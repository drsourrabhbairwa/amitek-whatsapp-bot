"""Glue: webhook events -> store -> agent -> WhatsApp replies and sales hand-offs."""
import logging
import threading
from collections import defaultdict
from datetime import timedelta

from .agent import AgentResult, SalesAgent
from .config import Settings
from .db import Store, now
from .tracker import Tracker, norm_phone
from .whatsapp import Echo, Inbound, WhatsAppClient

log = logging.getLogger(__name__)

STOP_WORDS = {"stop", "unsubscribe", "stop messages", "not interested", "abhi nahi", "band karo", "मत भेजो"}
START_WORDS = {"start", "subscribe"}
CALL_WORDS = {"call me", "call karein", "discuss a project"}

GOODBYE = ("Theek hai ji, ab aapko hamari taraf se message nahi aayenge. 🙏 "
           "Kabhi bhi waterproofing ki zarurat ho to yahan 'START' likh dijiye.")
CALL_ACK = ("Ji zaroor 🙏 Hamari team ke senior member aapko jaldi call karenge. "
            "Tab tak bata dijiye: kaam kis city mein hai aur lagbhag kitna area (sq ft) hai?")


class BotService:
    def __init__(self, settings: Settings, store: Store, wa: WhatsAppClient, agent: SalesAgent):
        self.s, self.store, self.wa, self.agent = settings, store, wa, agent
        self._locks: dict[str, threading.Lock] = defaultdict(threading.Lock)
        self.tracker = Tracker(settings, store, wa)

    # ---------- entry points
    def handle_echo(self, e: Echo) -> None:
        """A human replied from Live Chat / phone: record it and keep the bot quiet for a while."""
        if not e.phone or self.store.seen(e.wa_message_id):
            return  # our own bot message coming back, or a duplicate
        self.store.upsert_lead(e.phone)
        self.store.add_message(e.phone, "out", "human", e.text, e.wa_message_id)
        self.store.upsert_lead(e.phone, actor="sales", last_human_contact_at=now(),
                               bot_paused_until=now() + timedelta(hours=self.s.human_takeover_hours))

    def handle_inbound(self, m: Inbound) -> None:
        if not m.phone:
            return
        if self.s.sales_whatsapp and m.phone == norm_phone(self.s.sales_whatsapp):
            if self.store.add_message(m.phone, "in", "sales", m.text, m.wa_message_id or None):
                self.wa.send_text(m.phone, self.tracker.handle_sales_command(m.text))
            return
        with self._locks[m.phone]:
            self._handle(m)

    # ---------- core
    def _handle(self, m: Inbound) -> None:
        if not self.store.add_message(m.phone, "in", "lead", m.text, m.wa_message_id or None):
            return  # duplicate webhook delivery
        lead = self.store.get_lead(m.phone)
        if lead is None:
            lead = self.store.upsert_lead(m.phone, actor="bot", name=m.profile_name or None, status="Replied",
                                          opt_in="Opted in", last_inbound_at=now())
        else:
            changes = {"last_inbound_at": now()}
            if lead.get("status") in (None, "New", "Contacted"):
                changes["status"] = "Replied"
            if lead.get("opt_in") == "Not Asked":
                changes["opt_in"] = "Opted in"  # they wrote to us
            if m.profile_name and not lead.get("name"):
                changes["name"] = m.profile_name
            lead = self.store.upsert_lead(m.phone, actor="bot", **changes)
        if m.wa_message_id:
            self.wa.mark_read(m.wa_message_id)

        word = m.text.strip().lower().strip(".!")
        if lead.get("opt_in") == "Opted out":
            if word in START_WORDS:
                self.store.upsert_lead(m.phone, actor="bot", opt_in="Opted in", status="Replied")
                self._send(m.phone, "Welcome back ji 🙏 Bataiye, kis kaam ke liye waterproofing chahiye?")
            return
        if word in STOP_WORDS:
            self._apply(m.phone, lead, AgentResult(reply=GOODBYE, opted_out=True))
            return
        if word in CALL_WORDS:
            self._apply(m.phone, lead, AgentResult(reply=CALL_ACK, handoff={
                "reason": "Customer tapped 'Call me'", "summary": "Asked for a call from the campaign message.",
                "priority": "hot"}))
            return

        paused = lead.get("bot_paused_until")
        if paused is not None:
            if paused.tzinfo is None:  # sqlite returns naive datetimes
                paused = paused.replace(tzinfo=now().tzinfo)
            if paused > now():
                log.info("bot paused for %s (human handling)", m.phone)
                return

        history = self.store.history(m.phone, self.s.history_turns)
        try:
            result = self.agent.respond(history, lead)
        except Exception:
            log.exception("agent failed for %s", m.phone)
            result = AgentResult(handoff={"reason": "Bot error", "summary": f"Last message: {m.text[:200]}",
                                          "priority": "normal"})
        self._apply(m.phone, lead, result)

    def _apply(self, phone: str, lead: dict, r: AgentResult) -> None:
        updates = dict(r.lead_updates)
        days = updates.pop("follow_up_in_days", None)
        if days is not None:
            updates["next_follow_up"] = now() + timedelta(days=max(0, days))
        if r.opted_out:
            updates.update(opt_in="Opted out", status="Opted out", next_follow_up=None)
        if r.handoff:
            hot = r.handoff.get("priority") == "hot"
            updates.update(status="Hot" if hot else "Qualified", handoff_at=now(), sla_alerts=0,
                           assigned_to=lead.get("assigned_to") or "Sales team",
                           follow_up_note=r.handoff.get("summary"),
                           next_follow_up=now() + (timedelta(hours=self.s.hot_lead_sla_hours) if hot
                                                   else timedelta(days=1)))
        if updates:
            lead = self.store.upsert_lead(phone, actor="bot", **updates)
        if r.reply:
            self._send(phone, r.reply)
        if r.handoff:
            self._notify_sales(lead, r.handoff)

    def _send(self, phone: str, text: str) -> None:
        wa_id = self.wa.send_text(phone, text)
        self.store.add_message(phone, "out", "bot", text, wa_id)
        if wa_id or not self.s.send_enabled:  # a failed send must still count as unanswered
            self.store.upsert_lead(phone, last_outbound_at=now())

    def _notify_sales(self, lead: dict, h: dict) -> None:
        if not self.s.sales_whatsapp:
            log.warning("handoff for %s but SALES_WHATSAPP is not set", lead["phone"])
            return
        name = lead.get("name") or lead.get("business_name") or "Lead"
        details = " | ".join(str(x) for x in (lead.get("category"), lead.get("city"),
                                              f"{lead['area_sqft']} sq ft" if lead.get("area_sqft") else None,
                                              lead.get("requirement")) if x)
        if self.s.sales_alert_template:
            self.wa.send_template(self.s.sales_whatsapp, self.s.sales_alert_template, "en",
                                  [name, f"+{lead['phone']}", f"{h['summary']} ({h['reason']})"[:900]])
            return
        flag = "🔥 HOT LEAD" if h.get("priority") == "hot" else "📋 New lead for follow-up"
        self.wa.send_text(self.s.sales_whatsapp,
                          f"*{flag}*\n{name} - +{lead['phone']}\n{details}\n\n{h['summary']}\n_Why now:_ {h['reason']}")
