"""The campaign engine.

Campaigns live in the campaigns table, one JSON blob per campaign in `data`:

    {"name": "Jaipur Dealers", "status": "Running", "template": "amitek_welcome",
     "lang": "en", "vars": "{Name}", "filter": {"cities": ["Jaipur"], "limit": 500}}

A tick sends one batch and returns. Nothing here loops until a campaign is
finished, so no single run can be long enough to matter, and a laptop that
closes mid-campaign simply picks up at the next tick with nobody messaged twice.

Three rules are enforced on every send, in this order, because each of them
exists to protect the WhatsApp number from being shut down:

  1. sending hours   — nothing goes out before WORK_FROM or after WORK_TO
  2. daily limit     — at most DAILY_LIMIT messages in any rolling 24 hours
  3. one per lead    — a lead already logged for this campaign is never resent
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from typing import Any

from . import db, leads, settings_store, whatsapp
from .config import get_settings

log = logging.getLogger(__name__)

BATCH = 40          # messages per tick: small enough that a tick is always quick
ERROR_STREAK = 5    # consecutive failures that mean something is wrong, not unlucky
# Meta's error codes for "this template cannot be used" — retrying these is pointless.
TEMPLATE_ERROR = re.compile(r"13200[0157]|13201[256]|template", re.I)


def now() -> datetime:
    return datetime.now(get_settings().zone())


def work_open(at: datetime | None = None) -> bool:
    at = at or now()
    return settings_store.num("WORK_FROM", 9) <= at.hour < settings_store.num("WORK_TO", 20)


# --------------------------------------------------------------------------- store

def all_campaigns() -> list[dict]:
    out = []
    for row in db.rows(
        "select id, data, created_at from campaigns where company_id = %s order by id desc",
        (leads.company(),),
    ):
        data = row["data"] or {}
        out.append({**data, "id": row["id"], "created_at": row["created_at"]})
    return out


def get_campaign(campaign_id: int) -> dict | None:
    row = db.one(
        "select id, data from campaigns where company_id = %s and id = %s",
        (leads.company(), campaign_id),
    )
    return {**(row["data"] or {}), "id": row["id"]} if row else None


def save_campaign(campaign_id: int | None, data: dict) -> int:
    payload = {k: v for k, v in data.items() if k not in ("id", "created_at")}
    if campaign_id:
        db.run(
            "update campaigns set data = data || %s::jsonb where company_id = %s and id = %s",
            (json.dumps(payload), leads.company(), campaign_id),
        )
        return campaign_id
    row = db.one(
        "insert into campaigns (company_id, name, data) values (%s, %s, %s::jsonb) returning id",
        (leads.company(), payload.get("name", "Campaign"), json.dumps(payload)),
    )
    return int(row["id"])


def patch(campaign_id: int, fields: dict) -> None:
    db.run(
        "update campaigns set data = data || %s::jsonb where company_id = %s and id = %s",
        (json.dumps(fields, default=str), leads.company(), campaign_id),
    )


def already_sent(campaign_id: int) -> set[str]:
    return {
        r["phone"] for r in db.rows(
            """select data ->> 'phone' as phone from campaign_log
                where company_id = %s and (data ->> 'campaign_id')::bigint = %s""",
            (leads.company(), campaign_id),
        ) if r["phone"]
    }


def tally(campaign_id: int) -> dict:
    row = db.one(
        """select count(*) filter (where data ->> 'result' = 'sent')   as sent,
                  count(*) filter (where data ->> 'result' = 'failed') as failed
             from campaign_log
            where company_id = %s and (data ->> 'campaign_id')::bigint = %s""",
        (leads.company(), campaign_id),
    )
    return {"sent": int(row["sent"]), "failed": int(row["failed"])} if row else {"sent": 0, "failed": 0}


def write_log(campaign_id: int, phone: str, result: str, detail: str = "") -> None:
    db.run(
        "insert into campaign_log (company_id, data) values (%s, %s::jsonb)",
        (leads.company(), json.dumps(
            {"campaign_id": campaign_id, "phone": phone, "result": result, "detail": detail[:300]}
        )),
    )


# --------------------------------------------------------------------------- sending

def fill_vars(spec: str, lead: dict) -> list[str]:
    """"{Name}, Waterproofing, {City}" -> ["Sir/Ma'am", "Waterproofing", "Jaipur"].

    A {Field} is replaced from the lead; anything else is sent as written.
    {Name} is always the greeting — the bot addresses everyone the same way.
    """
    out: list[str] = []
    for part in (spec or "{Name}").split(","):
        part = part.strip()
        match = re.fullmatch(r"\{(\w+)\}", part)
        if not match:
            out.append(part)
            continue
        field = match.group(1).lower()
        if field in ("name", "firstname"):
            out.append(leads.GREETING)
        else:
            out.append(str(lead.get(field) or "").strip() or leads.GREETING)
    return out


def tick() -> dict:
    """Called every few minutes. Sends one batch for each running campaign."""
    if not work_open():
        return {"skipped": "outside sending hours"}

    budget = int(settings_store.num("DAILY_LIMIT", 250)) - leads.sent_last_24h()
    if budget <= 0:
        return {"skipped": "daily limit reached"}

    result = {"sent": 0, "failed": 0, "campaigns": 0}
    for campaign in all_campaigns():
        if campaign.get("status") != "Running" or budget <= 0:
            continue
        outcome = send_batch(campaign, min(BATCH, budget))
        budget -= outcome["sent"]
        result["sent"] += outcome["sent"]
        result["failed"] += outcome["failed"]
        result["campaigns"] += 1
    return result


def send_batch(campaign: dict, max_messages: int) -> dict:
    campaign_id = campaign["id"]
    spec = dict(campaign.get("filter") or {})
    done = already_sent(campaign_id)

    # An always-on welcome campaign greets only leads added after it started,
    # never the back catalogue.
    if spec.get("keepOn") and campaign.get("started"):
        spec["since"] = campaign["started"]

    batch = leads.audience(spec, exclude=done)
    finished = not batch and not spec.get("keepOn")

    cap = int(spec.get("limit") or 0)
    if cap:
        batch = batch[: max(0, cap - len(done))]
    batch = batch[:max_messages]

    sent = failed = streak = 0
    template = campaign.get("template", "")
    lang = campaign.get("lang", "en")

    for lead in batch:
        phone = lead["phone"]
        params = fill_vars(campaign.get("vars", "{Name}"), lead)
        res = whatsapp.send_template(phone, template, lang, params)

        if res.ok:
            sent += 1
            streak = 0
            write_log(campaign_id, phone, "sent", res.message_id)
            leads.log_message(phone, "out", f"[{template}] " + " | ".join(params),
                              sender="campaign", wa_message_id=res.message_id)
            update: dict[str, Any] = {"campaign": campaign.get("name", ""),
                                      "last_outbound": datetime.now(timezone.utc)}
            if (lead.get("status") or "New") in ("", "New"):
                update["status"] = "Contacted"
            leads.upsert(phone, update)
        else:
            failed += 1
            streak += 1
            write_log(campaign_id, phone, "failed", res.error)
            # A refused template or a run of failures means the next 500 sends
            # would fail too. Stop, and say so, rather than burning the number.
            if TEMPLATE_ERROR.search(res.error) or streak >= ERROR_STREAK:
                patch(campaign_id, {"status": "Paused", "last_error": res.error[:300]})
                alert_team(
                    f'Campaign "{campaign.get("name")}" paused: WhatsApp refused the message.\n'
                    f"{res.error[:200]}\nCheck the template name and language."
                )
                break

    counts = tally(campaign_id)
    if campaign.get("status") == "Running" and finished and not spec.get("keepOn"):
        patch(campaign_id, {"status": "Done", "finished": now().isoformat(), **counts})
        alert_team(f'Campaign "{campaign.get("name")}" finished: '
                   f'{counts["sent"]} sent, {counts["failed"]} failed.')
    else:
        patch(campaign_id, counts)

    if sent or failed:
        log.info("campaign %s: sent %s, failed %s", campaign.get("name"), sent, failed)
    return {"sent": sent, "failed": failed}


def alert_team(text: str) -> None:
    """Tell the salesperson something. Free text only works inside their 24-hour
    window; outside it WhatsApp will refuse, and the message is only logged."""
    to = get_settings().sales_whatsapp
    if not to:
        return
    res = whatsapp.send_text(to, text)
    if not res.ok:
        log.warning("could not reach the team on WhatsApp: %s", res.error)
    leads.log_message(to, "out", text, sender="alert")
