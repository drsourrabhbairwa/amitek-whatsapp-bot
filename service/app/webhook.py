"""Inbound WhatsApp messages.

BlueTick posts here. The URL carries a secret, so the path itself is the
credential — anyone who learns it can feed the bot messages, which is why it
must be long, random, and never pasted into a screenshot.

The handler writes the message down first and answers second. If Claude is slow
or the API is down, the customer's message is still safely recorded.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import PlainTextResponse

from . import ai, leads, whatsapp
from .config import get_settings

log = logging.getLogger(__name__)
router = APIRouter()

# What a person sends when they want to be left alone. Honour it immediately —
# ignoring it is what gets a WhatsApp number reported and shut down.
#
# The whole message has to be the stop phrase, not merely start with one.
# "stop" means stop; "stop by tomorrow" is someone inviting us to visit, and
# opting them out of everything would be the wrong thing to do.
STOP_WORDS = re.compile(
    r"^\s*(?:please\s+|pls\s+|plz\s+|kripya\s+)?"
    r"(?:stop|unsubscribe|opt\s*out|remove(?:\s+me)?|block|do\s+not\s+disturb|dnd"
    r"|band\s*k[ar]+o|bandh\s*k[ar]+o|mat\s+bhejo|message\s+mat\s+bhejo|नहीं\s*चाहिए|बंद\s*करो)"
    r"[\s.!,।]*$",
    re.I,
)
GOODBYE = f"Theek hai {leads.GREETING}, ab aapko hamare message nahi aayenge. Dhanyavaad."


def _check_secret(secret: str) -> None:
    expected = get_settings().webhook_secret
    if not expected or secret != expected:
        raise HTTPException(status_code=404, detail="Not found")


@router.get("/wh/{secret}")
async def verify(secret: str, request: Request):
    """The one-time verification handshake.

    Whoever is verifying sends a challenge and expects it echoed back exactly,
    as plain text. It is not always a number — Meta sends alphanumeric ones —
    so it is returned as the string it arrived as, never parsed.
    """
    _check_secret(secret)
    params = request.query_params
    challenge = params.get("hub.challenge") or params.get("challenge")
    log.info("verification GET: %s", dict(params) or "no parameters")
    if challenge is not None:
        return PlainTextResponse(challenge)
    return PlainTextResponse("ok")


@router.post("/wh/{secret}")
async def receive(secret: str, request: Request):
    _check_secret(secret)
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="Body is not JSON")

    for phone, text, wa_id in _extract(payload):
        try:
            handle_message(phone, text, wa_id)
        except Exception as err:  # noqa: BLE001 - one bad message must not drop the rest
            log.exception("failed handling message from %s: %s", phone, err)
    return {"ok": True}


def _extract(payload: dict) -> list[tuple[str, str, str]]:
    """Pull (phone, text, message id) out of a Meta Cloud API webhook body."""
    found: list[tuple[str, str, str]] = []
    for entry in payload.get("entry", []) or []:
        for change in entry.get("changes", []) or []:
            for message in (change.get("value") or {}).get("messages", []) or []:
                if message.get("type") != "text":
                    continue
                phone = leads.norm_phone(message.get("from"))
                body = ((message.get("text") or {}).get("body") or "").strip()
                if phone and body:
                    found.append((phone, body, message.get("id", "")))
    return found


def handle_message(phone: str, text: str, wa_id: str = "") -> str:
    """Record an inbound message and answer it. Returns what was said back."""
    lead = leads.get(phone)
    if lead is None:
        lead = leads.upsert(phone, {"source": "WhatsApp", "status": "New"}) or {"phone": phone}

    leads.log_message(phone, "in", text, sender="customer", wa_message_id=wa_id)
    leads.mark_received(phone)
    whatsapp.mark_read(wa_id)

    if STOP_WORDS.match(text):
        leads.upsert(phone, {"opt_in": "Opted out", "status": "Opted out"})
        whatsapp.send_text(phone, GOODBYE)
        leads.log_message(phone, "out", GOODBYE, sender="bot")
        log.info("%s opted out", phone)
        return GOODBYE

    # A human from the team answered this lead recently: stay out of the way.
    paused_until = lead.get("bot_paused_until")
    human = lead.get("last_human_contact")
    quiet_for = timedelta(hours=get_settings().human_takeover_hours)
    nowish = datetime.now(timezone.utc)
    if (paused_until and paused_until > nowish) or (human and human > nowish - quiet_for):
        log.info("%s is with a human — bot staying quiet", phone)
        return ""

    answer = ai.reply_to(phone, text)
    if not answer:
        return ""

    res = whatsapp.send_text(phone, answer)
    leads.log_message(phone, "out", answer, sender="bot", wa_message_id=res.message_id)
    if res.ok:
        leads.mark_sent(phone)
    return answer
