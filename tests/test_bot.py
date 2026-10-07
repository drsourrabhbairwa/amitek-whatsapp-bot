"""End-to-end tests with a fake Claude and a fake WhatsApp API. No network, nothing is sent."""
import json
import os
import sys
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.agent import SalesAgent  # noqa: E402
from app.config import Settings  # noqa: E402
from app.db import Store, make_engine, now  # noqa: E402
from app.service import BotService  # noqa: E402
from app.whatsapp import WhatsAppClient, parse_webhook  # noqa: E402

BUSINESS = "910000000001"
LEAD = "919812345678"


def meta_payload(messages=None, contacts=None):
    return {"object": "whatsapp_business_account", "entry": [{"id": "waba-test", "changes": [{
        "field": "messages", "value": {
            "messaging_product": "whatsapp",
            "metadata": {"display_phone_number": BUSINESS, "phone_number_id": "phone-id-test"},
            "contacts": contacts or [{"profile": {"name": "Ramesh"}, "wa_id": LEAD}],
            "messages": messages or []}}]}]}


def text_msg(body, mid="wamid.1", frm=LEAD):
    return {"from": frm, "id": mid, "timestamp": "1700000000", "type": "text", "text": {"body": body}}


# ---------- fakes
def block(**kw):
    return SimpleNamespace(**kw)


class FakeClaude:
    """Scripted responses: each item is a list of content blocks."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.calls.append({**kwargs, "messages": list(kwargs["messages"])})
        content = self.script.pop(0)
        stop = "tool_use" if any(b.type == "tool_use" for b in content) else "end_turn"
        return SimpleNamespace(content=content, stop_reason=stop, stop_details=None)


class FakeWhatsApp:
    def __init__(self):
        self.sent = []

    def handler(self, request: httpx.Request):
        body = json.loads(request.content)
        self.sent.append(body)
        return httpx.Response(200, json={"messages": [{"id": f"wamid.out{len(self.sent)}"}]})


@pytest.fixture
def env(tmp_path):
    settings = Settings(wa_phone_number_id="phone-id-test", wa_access_token="test", send_enabled=True,
                        sales_whatsapp="919999999999", database_url=f"sqlite:///{tmp_path}/t.db")
    store = Store(make_engine(settings.database_url))
    fake_wa = FakeWhatsApp()
    wa = WhatsAppClient(settings, httpx.Client(transport=httpx.MockTransport(fake_wa.handler)))

    def build(script):
        claude = FakeClaude(script)
        agent = SalesAgent(settings, client=claude)
        return BotService(settings, store, wa, agent), claude

    return SimpleNamespace(settings=settings, store=store, fake_wa=fake_wa, build=build)


def texts_to(fake_wa, phone):
    return [m["text"]["body"] for m in fake_wa.sent if m.get("type") == "text" and m["to"] == phone]


# ---------- parsing
def test_parse_text_button_and_echo():
    p = meta_payload(messages=[
        text_msg("Hello"),
        {"from": LEAD, "id": "wamid.2", "type": "button", "button": {"text": "Yes, send details", "payload": "x"}},
        {"from": LEAD, "id": "wamid.3", "type": "interactive",
         "interactive": {"type": "button_reply", "button_reply": {"id": "a", "title": "Contractor"}}},
        {"from": BUSINESS, "to": LEAD, "id": "wamid.4", "type": "text", "text": {"body": "Sir I will call you"}},
    ])
    inbound, echoes = parse_webhook(p)
    assert [m.text for m in inbound] == ["Hello", "Yes, send details", "Contractor"]
    assert inbound[0].profile_name == "Ramesh"
    assert len(echoes) == 1 and echoes[0].phone == LEAD


def test_parse_wrapped_payload():
    inbound, _ = parse_webhook({"data": meta_payload(messages=[text_msg("hi")])})
    assert inbound[0].text == "hi"


# ---------- conversation
def test_reply_and_lead_update(env):
    svc, claude = env.build([
        [block(type="text", text=""), block(type="tool_use", id="t1", name="update_lead",
                                            input={"category": "Applicator", "city": "Jaipur", "area_sqft": "1200",
                                                   "stage": "Diagnose"})],
        [block(type="text", text="Ji, 1200 sq ft terrace hai. Kya abhi leakage ho rahi hai?")],
    ])
    inbound, _ = parse_webhook(meta_payload(messages=[text_msg("Terrace 1200 sqft Jaipur waterproofing chahiye")]))
    svc.handle_inbound(inbound[0])

    assert texts_to(env.fake_wa, LEAD) == ["Ji, 1200 sq ft terrace hai. Kya abhi leakage ho rahi hai?"]
    lead = env.store.get_lead(LEAD)
    assert (lead["category"], lead["city"], lead["area_sqft"], lead["stage"]) == ("Applicator", "Jaipur", 1200,
                                                                                  "Diagnose")
    assert lead["status"] == "Replied" and lead["name"] == "Ramesh"
    # lead card is passed to Claude with the customer's message
    assert "<lead_record>" in claude.calls[0]["messages"][-1]["content"]
    assert claude.calls[0]["fallbacks"] == "default"


def test_duplicate_webhook_is_ignored(env):
    svc, claude = env.build([[block(type="text", text="Namaste ji")]])
    m = parse_webhook(meta_payload(messages=[text_msg("hi")]))[0][0]
    svc.handle_inbound(m)
    svc.handle_inbound(m)
    assert len(claude.calls) == 1
    assert texts_to(env.fake_wa, LEAD) == ["Namaste ji"]


def test_handoff_notifies_sales(env):
    svc, _ = env.build([
        [block(type="tool_use", id="t1", name="handoff_to_sales",
               input={"reason": "Wants rate for 5000 sq ft", "summary": "Builder, Jaipur, 5000 sq ft roof",
                      "priority": "hot"})],
        [block(type="text", text="Ji, hamari team aapko exact rate ke saath call karegi.")],
    ])
    svc.handle_inbound(parse_webhook(meta_payload(messages=[text_msg("rate batao 5000 sqft")]))[0][0])
    assert env.store.get_lead(LEAD)["status"] == "Hot"
    alerts = texts_to(env.fake_wa, "919999999999")
    assert alerts and "HOT LEAD" in alerts[0] and LEAD in alerts[0]


def test_stop_opts_out_without_ai(env):
    svc, claude = env.build([])
    svc.handle_inbound(parse_webhook(meta_payload(messages=[text_msg("STOP")]))[0][0])
    assert env.store.get_lead(LEAD)["opt_in"] == "Opted out"
    assert len(texts_to(env.fake_wa, LEAD)) == 1 and not claude.calls
    # later messages are ignored until START
    svc.handle_inbound(parse_webhook(meta_payload(messages=[text_msg("hello", mid="wamid.9")]))[0][0])
    assert len(texts_to(env.fake_wa, LEAD)) == 1 and not claude.calls


def test_call_me_button_hands_off(env):
    svc, claude = env.build([])
    msg = {"from": LEAD, "id": "wamid.b", "type": "button", "button": {"text": "Call me"}}
    svc.handle_inbound(parse_webhook(meta_payload(messages=[msg]))[0][0])
    assert env.store.get_lead(LEAD)["status"] == "Hot" and not claude.calls
    assert texts_to(env.fake_wa, "919999999999")


def test_human_takeover_pauses_bot(env):
    svc, claude = env.build([[block(type="text", text="should not be sent")]])
    _, echoes = parse_webhook(meta_payload(messages=[
        {"from": BUSINESS, "to": LEAD, "id": "wamid.h", "type": "text", "text": {"body": "Main Rahul, call karta hoon"}}]))
    svc.handle_echo(echoes[0])
    svc.handle_inbound(parse_webhook(meta_payload(messages=[text_msg("ok sir")]))[0][0])
    assert not claude.calls and texts_to(env.fake_wa, LEAD) == []
    # after the pause window the bot answers again, and sees the human's message in history
    env.store.upsert_lead(LEAD, bot_paused_until=now() - timedelta(minutes=1))
    svc.handle_inbound(parse_webhook(meta_payload(messages=[text_msg("rate?", mid="wamid.10")]))[0][0])
    assert claude.calls
    joined = json.dumps(claude.calls[0]["messages"], ensure_ascii=False)
    assert "Amitek sales team member wrote" in joined


def test_send_disabled_sends_nothing(env, tmp_path):
    s = Settings(send_enabled=False, database_url=f"sqlite:///{tmp_path}/x.db")
    fake = FakeWhatsApp()
    wa = WhatsAppClient(s, httpx.Client(transport=httpx.MockTransport(fake.handler)))
    assert wa.send_text(LEAD, "hi") is None and fake.sent == []


def test_webhook_endpoint(monkeypatch, tmp_path):
    monkeypatch.setenv("WEBHOOK_SECRET", "s3cret")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path}/api.db")
    for mod in [m for m in sys.modules if m.startswith("app.")]:
        del sys.modules[mod]
    from fastapi.testclient import TestClient
    import app.main as main

    calls = []
    main._service = SimpleNamespace(handle_inbound=calls.append, handle_echo=calls.append)
    c = TestClient(main.app)
    assert c.post("/webhook/wrong", json={}).status_code == 404
    assert c.get("/webhook/s3cret", params={"hub.challenge": "42"}).text == "42"
    r = c.post("/webhook/s3cret", json=meta_payload(messages=[text_msg("hi")]))
    assert r.status_code == 200 and len(calls) == 1
    assert c.get("/health").json()["ok"] is True


# ---------- phase 1: gentle mode
def test_gentle_mode_is_default(env):
    svc, claude = env.build([[block(type="text", text="Namaste ji 🙏")]])
    svc.handle_inbound(parse_webhook(meta_payload(messages=[text_msg("hi")]))[0][0])
    system = claude.calls[0]["system"][0]["text"]
    assert "NOT to sell" in system and "senior sales head" not in system


# ---------- tracking: nothing goes off road
SALES = "919999999999"


def sales_msg(text, mid):
    return parse_webhook(meta_payload(messages=[text_msg(text, mid=mid, frm=SALES)],
                                      contacts=[{"profile": {"name": "Rahul"}, "wa_id": SALES}]))[0][0]


def test_handoff_sets_follow_up_and_sla_reminder(env):
    svc, _ = env.build([
        [block(type="tool_use", id="t1", name="handoff_to_sales",
               input={"reason": "Asked price", "summary": "Builder Jaipur roof", "priority": "hot"})],
        [block(type="text", text="Ji, team aapko contact karegi.")],
    ])
    svc.handle_inbound(parse_webhook(meta_payload(messages=[text_msg("rate?")]))[0][0])
    lead = env.store.get_lead(LEAD)
    assert lead["handoff_at"] and lead["next_follow_up"]
    env.fake_wa.sent.clear()
    assert svc.tracker.check()["hot_overdue"] == 0  # within SLA
    env.store.upsert_lead(LEAD, handoff_at=now() - timedelta(hours=3))
    assert svc.tracker.check()["hot_overdue"] == 1
    assert "not contacted" in texts_to(env.fake_wa, SALES)[0]
    assert svc.tracker.check()["hot_overdue"] == 0  # no repeat until next window
    # salesperson marks it done -> no more hot reminders
    svc.handle_inbound(sales_msg("DONE 9812345678 called, site visit Monday", "wamid.s1"))
    lead = env.store.get_lead(LEAD)
    assert lead["status"] == "Contacted" and lead["last_human_contact_at"]
    assert "marked contacted" in texts_to(env.fake_wa, SALES)[-1]
    assert any("status: Hot -> Contacted" in r["change"] for r in env.store.lead_log(LEAD))


def test_unanswered_alert_when_bot_fails(env):
    svc, _ = env.build([])  # empty script -> agent raises -> no reply sent
    svc.handle_inbound(parse_webhook(meta_payload(messages=[text_msg("hello?")]))[0][0])
    env.store.upsert_lead(LEAD, last_inbound_at=now() - timedelta(hours=1))
    env.fake_wa.sent.clear()
    r = svc.tracker.check()
    assert r["unanswered"] == 1 and "Waiting for a reply" in texts_to(env.fake_wa, SALES)[0]
    assert svc.tracker.check()["unanswered"] == 0  # alerted once per customer message


def test_later_won_lost_and_list(env):
    svc, _ = env.build([[block(type="text", text="Ji")]])
    svc.handle_inbound(parse_webhook(meta_payload(messages=[text_msg("hi")]))[0][0])
    svc.handle_inbound(sales_msg("LATER 9812345678 5 call after Diwali", "wamid.s2"))
    lead = env.store.get_lead(LEAD)
    assert lead["follow_up_note"] == "call after Diwali"
    assert timedelta(days=4) < (lead["next_follow_up"] - lead["updated_at"]) <= timedelta(days=5, minutes=1)
    # follow-up date reached -> reminder
    env.store.upsert_lead(LEAD, next_follow_up=now() - timedelta(minutes=5))
    env.fake_wa.sent.clear()
    assert svc.tracker.check()["follow_ups_due"] == 1
    svc.handle_inbound(sales_msg("LIST", "wamid.s3"))
    assert "Overdue" in texts_to(env.fake_wa, SALES)[-1]
    svc.handle_inbound(sales_msg("WON 9812345678 50 buckets", "wamid.s4"))
    assert env.store.get_lead(LEAD)["status"] == "Won"
    assert svc.tracker.check() == {"unanswered": 0, "hot_overdue": 0, "follow_ups_due": 0}
    svc.handle_inbound(sales_msg("blah", "wamid.s5"))
    assert "Command not understood" in texts_to(env.fake_wa, SALES)[-1]


def test_quiet_lead_gets_follow_up_date(env):
    svc, _ = env.build([[block(type="text", text="Ji")]])
    svc.handle_inbound(parse_webhook(meta_payload(messages=[text_msg("hi")]))[0][0])
    env.store.upsert_lead(LEAD, last_inbound_at=now() - timedelta(days=4), next_follow_up=None)
    svc.tracker.check()
    assert env.store.get_lead(LEAD)["next_follow_up"] is not None
    assert svc.tracker.check()["follow_ups_due"] == 1


def test_follow_up_in_days_from_agent(env):
    svc, _ = env.build([
        [block(type="tool_use", id="t1", name="update_lead", input={"follow_up_in_days": 7})],
        [block(type="text", text="Theek hai ji, agle hafte baat karte hain.")],
    ])
    svc.handle_inbound(parse_webhook(meta_payload(messages=[text_msg("next week baat karenge")]))[0][0])
    lead = env.store.get_lead(LEAD)
    assert lead["next_follow_up"] is not None


def test_board_and_cron_endpoints(monkeypatch, tmp_path):
    monkeypatch.setenv("WEBHOOK_SECRET", "s3cret")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path}/b.db")
    for mod in [m for m in sys.modules if m.startswith("app.")]:
        del sys.modules[mod]
    from fastapi.testclient import TestClient
    import app.main as main
    main.store.upsert_lead(LEAD, name="Ramesh <b>", status="Hot", handoff_at=now())
    main._service = SimpleNamespace(tracker=SimpleNamespace(check=lambda: {"unanswered": 0},
                                                            daily_summary=lambda: "x"))
    c = TestClient(main.app)
    html = c.get("/board/s3cret").text
    assert "Ramesh &lt;b&gt;" in html and "Hot" in html
    assert c.post("/cron/s3cret/check").json() == {"unanswered": 0}
    assert c.post("/cron/wrong/check").status_code == 404
