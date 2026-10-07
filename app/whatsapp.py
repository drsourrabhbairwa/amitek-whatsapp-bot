"""BlueTick exposes the Meta WhatsApp Cloud API at its own base URL, so we speak the standard Cloud API format."""
import logging
from dataclasses import dataclass

import httpx

from .config import Settings

log = logging.getLogger(__name__)


@dataclass
class Inbound:
    phone: str            # sender wa_id, e.g. 919812345678
    wa_message_id: str
    text: str             # text body, or button title, or a [type] placeholder
    profile_name: str = ""
    kind: str = "text"


@dataclass
class Echo:
    """A message sent from our number by someone else (a human in BlueTick Live Chat / phone app)."""
    phone: str            # the customer it was sent to
    wa_message_id: str
    text: str


def _message_text(m: dict) -> tuple[str, str]:
    t = m.get("type", "")
    if t == "text":
        return m.get("text", {}).get("body", ""), "text"
    if t == "button":  # quick-reply button on a template
        return m.get("button", {}).get("text", ""), "button"
    if t == "interactive":
        inter = m.get("interactive", {})
        reply = inter.get("button_reply") or inter.get("list_reply") or {}
        return reply.get("title", ""), "button"
    if t in ("image", "document", "video", "audio", "voice", "sticker"):
        caption = (m.get(t) or {}).get("caption", "")
        return f"[sent a {t}]" + (f" {caption}" if caption else ""), t
    if t == "location":
        loc = m.get("location", {})
        return f"[shared location {loc.get('name', '')} {loc.get('address', '')}]".strip(), "location"
    return f"[{t or 'unknown'} message]", t or "unknown"


def _find_entries(payload) -> list:
    """Meta payloads have entry[].changes[].value. Some providers wrap it, so search a little."""
    if isinstance(payload, dict):
        if isinstance(payload.get("entry"), list):
            return payload["entry"]
        for v in payload.values():
            found = _find_entries(v)
            if found:
                return found
    elif isinstance(payload, list):
        for v in payload:
            found = _find_entries(v)
            if found:
                return found
    return []


def parse_webhook(payload: dict) -> tuple[list[Inbound], list[Echo]]:
    inbound, echoes = [], []
    for entry in _find_entries(payload):
        for change in entry.get("changes", []):
            value = change.get("value", {}) or {}
            names = {c.get("wa_id"): (c.get("profile") or {}).get("name", "") for c in value.get("contacts", [])}
            business = "".join(ch for ch in str((value.get("metadata") or {}).get("display_phone_number", ""))
                               if ch.isdigit())
            for m in value.get("messages", []) or []:
                text, kind = _message_text(m)
                if business and m.get("from") == business and m.get("to"):  # outgoing copy from the provider
                    echoes.append(Echo(phone=m["to"], wa_message_id=m.get("id", ""), text=text))
                    continue
                inbound.append(Inbound(phone=m.get("from", ""), wa_message_id=m.get("id", ""), text=text,
                                       profile_name=names.get(m.get("from"), ""), kind=kind))
            # Messages sent from the business side by a person (coexistence / provider echo)
            for m in (value.get("message_echoes") or []):
                text, _ = _message_text(m)
                echoes.append(Echo(phone=m.get("to", ""), wa_message_id=m.get("id", ""), text=text))
    return inbound, echoes


class WhatsAppClient:
    def __init__(self, settings: Settings, http: httpx.Client | None = None):
        self.s = settings
        self.http = http or httpx.Client(timeout=20)

    @property
    def _url(self) -> str:
        return f"{self.s.wa_api_url}/{self.s.wa_api_version}/{self.s.wa_phone_number_id}/messages"

    def _post(self, body: dict) -> str | None:
        """Returns the sent message id, or None when sending is disabled or failed."""
        if not self.s.send_enabled:
            log.info("SEND_ENABLED=false, not sending: %s", body)
            return None
        r = self.http.post(self._url, json=body, headers={"Authorization": f"Bearer {self.s.wa_access_token}"})
        if r.status_code >= 300:
            log.error("WhatsApp send failed %s: %s", r.status_code, r.text[:500])
            return None
        try:
            return r.json()["messages"][0]["id"]
        except (ValueError, KeyError, IndexError):
            return None

    def send_text(self, to: str, text: str) -> str | None:
        return self._post({"messaging_product": "whatsapp", "recipient_type": "individual", "to": to,
                           "type": "text", "text": {"preview_url": False, "body": text[:4096]}})

    def send_template(self, to: str, name: str, lang: str, params: list[str]) -> str | None:
        components = [{"type": "body", "parameters": [{"type": "text", "text": p} for p in params]}] if params else []
        return self._post({"messaging_product": "whatsapp", "to": to, "type": "template",
                           "template": {"name": name, "language": {"code": lang}, "components": components}})

    def mark_read(self, wa_message_id: str) -> None:
        self._post({"messaging_product": "whatsapp", "status": "read", "message_id": wa_message_id})
