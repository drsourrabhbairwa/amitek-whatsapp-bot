"""Working out what to say back.

The company's own material (products, prices, areas served) lives in the
knowledge table and is pasted into the prompt, so changing what the bot knows
is an edit in the app, not a code change.
"""
from __future__ import annotations

import logging

from anthropic import Anthropic

from . import db, leads, settings_store
from .config import get_settings

log = logging.getLogger(__name__)

PERSONA = f"""You are the WhatsApp sales assistant for Amitek (APP Paints Chemicals Pvt. Ltd.), India.
You speak for the company to builders, architects, dealers, contractors and applicators.

How you talk:
- Address every customer as "{leads.GREETING}". Never use their first name. Never use the word "ji".
- Short WhatsApp messages. Two or three sentences. No long paragraphs, no bullet lists.
- Reply in the language the customer writes in: English, Hindi, or Hinglish in Roman script.
- Never invent a price, a warranty figure, a delivery date or a product claim. If the
  material below does not cover it, say you will have someone confirm, and stop there.

What you are for: understand what the customer needs, answer plainly, and when they are
ready to buy or want to talk to a person, say someone will call and end your turn.

If the customer asks to stop hearing from us, acknowledge it in one line and nothing more."""


def _client() -> Anthropic | None:
    key = get_settings().anthropic_api_key
    return Anthropic(api_key=key) if key else None


def knowledge() -> str:
    rows = db.rows(
        "select title, content from knowledge where company_id = %s order by id",
        (leads.company(),),
    )
    return "\n\n".join(f"## {r['title']}\n{r['content']}" for r in rows if r.get("content"))


def system_prompt(lead: dict) -> str:
    parts = [PERSONA]
    rules = settings_store.get("OWNER_RULES").strip()
    if rules:
        parts.append("House rules from the business owner, which override anything above:\n" + rules)
    material = knowledge()
    if material:
        parts.append("What you know about the company and its products:\n" + material)
    parts.append(
        "Who you are talking to: "
        + ", ".join(
            f"{k} {lead.get(k)}" for k in ("category", "city", "state", "business")
            if lead.get(k)
        )
    )
    return "\n\n".join(parts)


def reply_to(phone: str, incoming: str) -> str:
    """The bot's answer to one inbound message, or '' if it should stay quiet."""
    client = _client()
    if client is None:
        log.warning("ANTHROPIC_API_KEY is not set — no reply generated")
        return ""

    lead = leads.get(phone) or {"phone": phone}
    history = [
        {"role": "assistant" if m["direction"] == "out" else "user",
         "content": m["body"] or ""}
        for m in leads.recent_messages(phone, limit=16)
        if (m["body"] or "").strip()
    ]
    history.append({"role": "user", "content": incoming})
    # The API rejects two user turns in a row, which campaign sends can produce.
    merged: list[dict] = []
    for turn in history:
        if merged and merged[-1]["role"] == turn["role"]:
            merged[-1]["content"] += "\n" + turn["content"]
        else:
            merged.append(dict(turn))

    try:
        answer = client.messages.create(
            model=get_settings().claude_model,
            max_tokens=400,
            system=system_prompt(lead),
            messages=merged,
        )
        return "".join(block.text for block in answer.content if block.type == "text").strip()
    except Exception as err:  # noqa: BLE001 - a bad reply must not drop the message
        log.error("Claude call failed: %s", err)
        return ""
