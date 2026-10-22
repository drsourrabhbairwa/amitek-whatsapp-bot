"""Sending on WhatsApp through BlueTick, which fronts the Meta Cloud API.

The payloads here are byte-for-byte what the Apps Script bot sends today, so
nothing about delivery changes in the move — only what sits behind it.

SEND_ENABLED=false makes every send a no-op that still returns a fake id and
logs what it would have sent. That is the switch that makes it safe to point
this at the real 34,000-lead database before anyone trusts it.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

from .config import get_settings

log = logging.getLogger(__name__)

# A WhatsApp text message is capped at 4096 characters by Meta.
MAX_TEXT = 4096


@dataclass
class SendResult:
    ok: bool
    message_id: str = ""
    error: str = ""

    def __bool__(self) -> bool:
        return self.ok


def _endpoint() -> str:
    s = get_settings()
    return f"{s.wa_api_url.rstrip('/')}/{s.wa_api_version}/{s.wa_phone_number_id}/messages"


def _post(body: dict, force: bool = False) -> SendResult:
    s = get_settings()
    if not force and not s.send_enabled:
        log.info("SEND_ENABLED is false — not sending: %s", str(body)[:300])
        return SendResult(ok=True, message_id="dry-run")
    if not s.wa_access_token or not s.wa_phone_number_id:
        return SendResult(ok=False, error="WhatsApp credentials are not set in .env")
    try:
        res = httpx.post(
            _endpoint(),
            json=body,
            headers={"Authorization": f"Bearer {s.wa_access_token}"},
            timeout=30,
        )
    except httpx.HTTPError as err:
        log.error("WhatsApp send failed to reach BlueTick: %s", err)
        return SendResult(ok=False, error=f"network: {err}")

    if res.status_code >= 300:
        detail = res.text[:500]
        log.error("WhatsApp send failed %s: %s", res.status_code, detail)
        # BlueTick answers 400 "invalid call" when its token or phone number id
        # has gone stale — worth saying plainly, it is the most common failure.
        if res.status_code == 400 and "invalid call" in detail.lower():
            detail += "  (usually a stale WA_ACCESS_TOKEN or WA_PHONE_NUMBER_ID — copy them from BlueTick again)"
        return SendResult(ok=False, error=f"{res.status_code}: {detail}")

    try:
        return SendResult(ok=True, message_id=res.json()["messages"][0]["id"])
    except (KeyError, IndexError, ValueError):
        return SendResult(ok=True, message_id="sent")


def send_text(to: str, text: str) -> SendResult:
    """Free text. Only allowed inside the 24-hour window after the lead wrote to us."""
    return _post(
        {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to,
            "type": "text",
            "text": {"preview_url": False, "body": str(text)[:MAX_TEXT]},
        }
    )


def send_template(to: str, name: str, lang: str, params: list[str]) -> SendResult:
    """An approved template. This is the only way to start a conversation."""
    return _post(
        {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to,
            "type": "template",
            "template": {
                "name": name,
                "language": {"code": lang or "en"},
                "components": [
                    {
                        "type": "body",
                        "parameters": [{"type": "text", "text": str(p)} for p in params],
                    }
                ],
            },
        }
    )


def mark_read(message_id: str) -> None:
    if message_id:
        _post({"messaging_product": "whatsapp", "status": "read", "message_id": message_id})
