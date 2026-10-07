"""Lead tracking so no lead goes off road.

- check(): run every hour. Alerts sales about unanswered chats, hot leads nobody has contacted, and follow-ups due.
  Leads that went quiet without a follow-up date get one automatically.
- daily_summary(): run every morning. One WhatsApp message to sales with everything pending.
- handle_sales_command(): the salesperson updates leads by WhatsApp (DONE / LATER / WON / LOST / LIST / HELP).
"""
import logging
import re
from datetime import timedelta, timezone

from .config import Settings
from .db import Store, aware, now
from .whatsapp import WhatsAppClient

log = logging.getLogger(__name__)
IST = timezone(timedelta(hours=5, minutes=30))
CLOSED = ("Won", "Lost", "Opted out")
QUIET_DAYS = 3          # an engaged lead silent this long gets a follow-up date if it has none
DEFAULT_LATER_DAYS = 3  # DONE without a date means "check again in 3 days"

HELP = ("*Lead commands* (send to this number):\n"
        "DONE 98xxxxxxxx note - I contacted them (next check in 3 days)\n"
        "LATER 98xxxxxxxx 5 note - follow up in 5 days\n"
        "WON 98xxxxxxxx note - order received\n"
        "LOST 98xxxxxxxx reason - closed, not buying\n"
        "LIST - everything pending today")


def norm_phone(raw: str) -> str:
    d = re.sub(r"\D", "", raw or "")
    if len(d) == 10:
        d = "91" + d
    elif len(d) == 11 and d.startswith("0"):
        d = "91" + d[1:]
    return d


def _label(lead: dict) -> str:
    name = lead.get("name") or lead.get("business_name") or "Lead"
    bits = [x for x in (lead.get("category") if lead.get("category") not in (None, "Other") else None,
                        lead.get("city")) if x]
    return f"{name} (+{lead['phone']}{', ' + ', '.join(bits) if bits else ''})"


def _ist(dt) -> str:
    return aware(dt).astimezone(IST).strftime("%d %b %I:%M %p") if dt else "-"


class Tracker:
    def __init__(self, settings: Settings, store: Store, wa: WhatsAppClient):
        self.s, self.store, self.wa = settings, store, wa

    def _alert(self, text: str) -> None:
        if self.s.sales_whatsapp:
            self.wa.send_text(self.s.sales_whatsapp, text)
        else:
            log.warning("no SALES_WHATSAPP; alert not sent: %s", text)

    # ---------- hourly
    def check(self) -> dict:
        t = now()
        unanswered, hot, due = [], [], []
        for lead in self.store.active_leads():
            phone = lead["phone"]
            last_in, last_out = aware(lead.get("last_inbound_at")), aware(lead.get("last_outbound_at"))
            human = aware(lead.get("last_human_contact_at"))
            replied_after = max([x for x in (last_out, human) if x], default=None)

            # 1. customer wrote and nobody (bot or human) answered
            if last_in and (replied_after is None or replied_after < last_in) \
                    and t - last_in >= timedelta(minutes=self.s.unanswered_alert_minutes):
                alerted = aware(lead.get("unanswered_alerted_at"))
                if alerted is None or alerted < last_in:
                    unanswered.append(lead)
                    self.store.upsert_lead(phone, unanswered_alerted_at=t)

            # 2. hot lead handed to sales, no human contact within the SLA
            handoff = aware(lead.get("handoff_at"))
            if lead.get("status") == "Hot" and handoff and (human is None or human < handoff):
                n = lead.get("sla_alerts") or 0
                if n < 3 and t - handoff >= timedelta(hours=self.s.hot_lead_sla_hours * (n + 1)):
                    hot.append(lead)
                    self.store.upsert_lead(phone, sla_alerts=n + 1)

            # 3. follow-up date reached
            nf = aware(lead.get("next_follow_up"))
            if nf and nf <= t:
                fa = aware(lead.get("followup_alerted_at"))
                if fa is None or fa < nf:
                    due.append(lead)
                    self.store.upsert_lead(phone, followup_alerted_at=t)
            # 4. quiet lead with no follow-up date: give it one so it can't be forgotten
            elif nf is None and last_in and t - last_in >= timedelta(days=QUIET_DAYS):
                self.store.upsert_lead(phone, actor="system", next_follow_up=t,
                                       follow_up_note=f"Silent for {QUIET_DAYS}+ days")

        parts = []
        if unanswered:
            parts.append("*⚠️ Waiting for a reply:*\n" + "\n".join(f"• {_label(l)}" for l in unanswered))
        if hot:
            parts.append(f"*🔥 Hot leads not contacted yet (>{self.s.hot_lead_sla_hours}h):*\n" + "\n".join(
                f"• {_label(l)}" for l in hot))
        if due:
            parts.append("*📅 Follow-up due now:*\n" + "\n".join(
                f"• {_label(l)}{' - ' + l['follow_up_note'] if l.get('follow_up_note') else ''}" for l in due))
        if parts:
            self._alert("\n\n".join(parts) + "\n\n_Reply DONE <number> after you call. HELP for commands._")
        return {"unanswered": len(unanswered), "hot_overdue": len(hot), "follow_ups_due": len(due)}

    # ---------- daily
    def pending_report(self) -> str:
        t = now()
        active = self.store.active_leads()
        hot = [l for l in active if l.get("status") == "Hot"]
        overdue = [l for l in active if l.get("next_follow_up") and aware(l["next_follow_up"]) <= t
                   and l.get("status") != "Hot"]
        today_end = t.astimezone(IST).replace(hour=23, minute=59).astimezone(timezone.utc)
        later_today = [l for l in active if l.get("next_follow_up")
                       and t < aware(l["next_follow_up"]) <= today_end]
        new24 = [l for l in active if l.get("last_inbound_at") and t - aware(l["last_inbound_at"]) <= timedelta(days=1)]
        lines = [f"*Amitek leads - {t.astimezone(IST).strftime('%d %b %Y')}*",
                 f"Active: {len(active)} | Hot: {len(hot)} | Overdue: {len(overdue)} | Wrote in last 24h: {len(new24)}"]

        def section(title, rows, limit=15):
            if rows:
                lines.append(f"\n*{title}*")
                lines.extend(f"• {_label(l)} - due {_ist(l.get('next_follow_up'))}" for l in rows[:limit])
                if len(rows) > limit:
                    lines.append(f"…and {len(rows) - limit} more (see lead board)")

        section("🔥 Hot - call first", sorted(hot, key=lambda l: aware(l.get("handoff_at")) or t))
        section("⏰ Overdue follow-ups", sorted(overdue, key=lambda l: aware(l["next_follow_up"])))
        section("📅 Later today", later_today)
        if not (hot or overdue or later_today):
            lines.append("\nNothing pending. 👍")
        return "\n".join(lines)

    def daily_summary(self) -> str:
        text = self.pending_report()
        self._alert(text)
        return text

    # ---------- salesperson commands over WhatsApp
    def handle_sales_command(self, text: str) -> str:
        parts = text.strip().split(maxsplit=3)
        cmd = parts[0].upper() if parts else ""
        if cmd in ("HELP", "?"):
            return HELP
        if cmd in ("LIST", "PENDING"):
            return self.pending_report()
        if cmd not in ("DONE", "LATER", "WON", "LOST") or len(parts) < 2:
            return "Command not understood.\n\n" + HELP
        phone = norm_phone(parts[1])
        lead = self.store.get_lead(phone)
        if not lead:
            return f"No lead found for {parts[1]}."
        rest = " ".join(parts[2:])
        t = now()
        if cmd == "DONE":
            self.store.upsert_lead(phone, actor="sales", last_human_contact_at=t, status="Contacted"
                                   if lead.get("status") in ("Replied", "Hot", "Qualified") else lead.get("status"),
                                   next_follow_up=t + timedelta(days=DEFAULT_LATER_DAYS), follow_up_note=rest or None)
            return f"✅ {_label(lead)} marked contacted. Next check {_ist(t + timedelta(days=DEFAULT_LATER_DAYS))}."
        if cmd == "LATER":
            m = re.match(r"(\d+)\s*(.*)", rest)
            days = int(m.group(1)) if m else DEFAULT_LATER_DAYS
            note = (m.group(2) if m else rest) or None
            self.store.upsert_lead(phone, actor="sales", last_human_contact_at=t,
                                   next_follow_up=t + timedelta(days=days), follow_up_note=note)
            return f"📅 {_label(lead)}: follow up on {_ist(t + timedelta(days=days))}."
        if cmd == "WON":
            self.store.upsert_lead(phone, actor="sales", status="Won", stage="Won", next_follow_up=None,
                                   last_human_contact_at=t, follow_up_note=rest or None)
            return f"🎉 {_label(lead)} marked WON."
        self.store.upsert_lead(phone, actor="sales", status="Lost", stage="Lost", next_follow_up=None,
                               last_human_contact_at=t, lost_reason=rest or "not given")
        return f"Closed {_label(lead)} as LOST ({rest or 'no reason given'})."
