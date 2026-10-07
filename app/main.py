import csv
import io
import json
import logging
import secrets

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, PlainTextResponse, StreamingResponse
from html import escape

from .agent import SalesAgent
from .config import settings
from .db import Store, aware, make_engine, now
from .service import BotService
from .whatsapp import WhatsAppClient, parse_webhook

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("amitek-bot")

app = FastAPI(title="Amitek WhatsApp Sales Agent")
store = Store(make_engine(settings.database_url))
_service: BotService | None = None


def service() -> BotService:
    global _service
    if _service is None:  # lazy so /health works without an Anthropic key
        _service = BotService(settings, store, WhatsAppClient(settings), SalesAgent(settings))
    return _service


def _check_secret(secret: str) -> None:
    if not settings.webhook_secret or not secrets.compare_digest(secret, settings.webhook_secret):
        raise HTTPException(status_code=404)


@app.on_event("startup")
def _start_scheduler():
    import os
    if os.getenv("ENABLE_SCHEDULER", "true").lower() in ("1", "true", "yes"):
        from . import scheduler
        scheduler.start(lambda: service().tracker)


@app.get("/health")
def health():
    return {"ok": True, "sending": settings.send_enabled, "model": settings.claude_model}


@app.get("/webhook/{secret}")
def verify(secret: str, request: Request):
    """Meta-style verification handshake (hub.challenge), in case the provider performs one."""
    _check_secret(secret)
    return PlainTextResponse(request.query_params.get("hub.challenge", "ok"))


@app.post("/webhook/{secret}")
async def webhook(secret: str, request: Request, background: BackgroundTasks):
    _check_secret(secret)
    raw = await request.body()
    try:
        payload = json.loads(raw or b"{}")
    except json.JSONDecodeError:
        log.warning("non-JSON webhook body: %r", raw[:300])
        return {"ok": True}
    store.log_event(raw.decode("utf-8", "replace")[:20000])
    inbound, echoes = parse_webhook(payload)
    svc = service()
    for e in echoes:
        background.add_task(svc.handle_echo, e)
    for m in inbound:
        background.add_task(svc.handle_inbound, m)
    return {"ok": True}  # answer fast; work happens after the response


@app.get("/leads.csv/{secret}")
def leads_csv(secret: str):
    """Download the bot's lead sheet (open in Google Sheets / Excel)."""
    _check_secret(secret)
    rows = store.all_leads()
    buf = io.StringIO()
    if rows:
        w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=amitek_leads.csv"})


@app.post("/cron/{secret}/check")
def cron_check(secret: str):
    """Run hourly: unanswered chats, hot leads not contacted, follow-ups due."""
    _check_secret(secret)
    return service().tracker.check()


@app.post("/cron/{secret}/daily")
def cron_daily(secret: str):
    """Run every morning: one WhatsApp summary to sales."""
    _check_secret(secret)
    return {"summary": service().tracker.daily_summary()}


@app.get("/board/{secret}", response_class=HTMLResponse)
def board(secret: str):
    """Simple lead board: what needs action first."""
    _check_secret(secret)
    t = now()
    rows = [l for l in store.all_leads() if l.get("status") not in (None, "New")]

    def bucket(l):
        nf = aware(l.get("next_follow_up"))
        if l.get("status") in ("Won", "Lost", "Opted out"):
            return 5, "Closed"
        if l.get("status") == "Hot":
            return 0, "Hot"
        if nf and nf <= t:
            return 1, "Overdue"
        if l.get("last_inbound_at") and (not l.get("last_outbound_at")
                                         or aware(l["last_outbound_at"]) < aware(l["last_inbound_at"])):
            return 2, "Waiting reply"
        if nf:
            return 3, "Scheduled"
        return 4, "Active"

    colors = {"Hot": "#fde2e1", "Overdue": "#fff1cc", "Waiting reply": "#e6f0ff"}
    rows.sort(key=lambda l: (bucket(l)[0], aware(l.get("next_follow_up")) or t))
    body = "".join(
        f"<tr style='background:{colors.get(bucket(l)[1], 'transparent')}'><td>{bucket(l)[1]}</td>"
        f"<td>{escape(str(l.get('name') or l.get('business_name') or ''))}</td><td>+{l['phone']}</td>"
        f"<td>{escape(str(l.get('category') or ''))}</td><td>{escape(str(l.get('city') or ''))}</td>"
        f"<td>{escape(str(l.get('status') or ''))}</td><td>{escape(str(l.get('stage') or ''))}</td>"
        f"<td>{aware(l['next_follow_up']).strftime('%d %b %H:%M UTC') if l.get('next_follow_up') else ''}</td>"
        f"<td>{escape(str(l.get('follow_up_note') or l.get('requirement') or ''))[:160]}</td></tr>" for l in rows)
    return f"""<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Amitek Lead Board</title><style>body{{font-family:system-ui;margin:16px;background:#fff;color:#111}}
table{{border-collapse:collapse;width:100%;font-size:14px}}td,th{{border-bottom:1px solid #ddd;padding:6px;text-align:left}}
.wrap{{overflow-x:auto}}</style><h2>Amitek Lead Board</h2><p>{len(rows)} engaged leads. Hot and overdue first.</p>
<div class=wrap><table><tr><th>Needs</th><th>Name</th><th>Phone</th><th>Category</th><th>City</th><th>Status</th>
<th>Stage</th><th>Next follow-up</th><th>Note</th></tr>{body}</table></div>"""
