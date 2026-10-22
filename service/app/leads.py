"""Lead and message queries.

This is where the speed comes from. The Apps Script version read every row of
the Leads sheet to answer any of these questions — about a million cells once
34,000 leads are in. Here each one is an indexed lookup, and the work the
database does does not grow with how many leads you own.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from . import db
from .config import get_settings

log = logging.getLogger(__name__)

GREETING = "Sir/Ma'am"  # everyone is addressed the same way: no first names, no "ji"

CATEGORIES = ["Applicator", "Contractor", "Builder", "Architect", "Dealer",
              "Manufacturer", "End Client", "Other"]
TIER_OF = {
    "Applicator": "Applicator / Project", "Contractor": "Applicator / Project",
    "Builder": "Applicator / Project", "Architect": "Applicator / Project",
    "Dealer": "Dealer", "Manufacturer": "Bulk", "End Client": "End Client",
}
CLOSED = ("Won", "Lost", "Opted out")
MOBILE_RE = re.compile(r"^91[6-9]\d{9}$")


def company() -> str:
    return get_settings().company_id


def norm_phone(raw: Any) -> str:
    digits = re.sub(r"\D", "", str(raw or ""))
    if len(digits) == 10:
        digits = "91" + digits
    elif len(digits) == 11 and digits.startswith("0"):
        digits = "91" + digits[1:]
    return digits


def valid_phone(phone: str) -> bool:
    return bool(re.fullmatch(r"91\d{10}", phone or ""))


# --------------------------------------------------------------------------- read

def get(phone: str) -> dict | None:
    return db.one(
        "select * from leads where company_id = %s and phone = %s",
        (company(), norm_phone(phone)),
    )


def counts() -> dict:
    row = db.one(
        """select count(*)                                              as total,
                  count(*) filter (where last_inbound is not null)      as replied,
                  count(*) filter (where last_outbound is not null)     as messaged,
                  count(*) filter (where status = 'Opted out')          as opted_out,
                  count(*) filter (where created_at > now() - interval '7 days') as new_week
             from leads where company_id = %s""",
        (company(),),
    )
    return row or {}


def window_open(phone: str) -> bool:
    """True while we may send free text: the lead wrote to us in the last 24 hours."""
    lead = get(phone)
    if not lead or not lead.get("last_inbound"):
        return False
    return lead["last_inbound"] > datetime.now(timezone.utc) - timedelta(hours=24)


def recent_messages(phone: str, limit: int = 20) -> list[dict]:
    return db.rows(
        """select direction, sender, body, at from messages
            where company_id = %s and phone = %s order by at desc limit %s""",
        (company(), norm_phone(phone), limit),
    )[::-1]


def team_phones() -> set[str]:
    return {
        norm_phone(r["phone"])
        for r in db.rows(
            "select phone from team_members where company_id = %s and active", (company(),)
        )
    }


# --------------------------------------------------------------------------- write

_WRITABLE = {
    "name", "business", "category", "tier", "city", "state", "stage", "status",
    "opt_in", "language", "requirement", "area_sqft", "assigned_to", "campaign",
    "next_followup", "followup_note", "handoff_at", "last_inbound", "last_outbound",
    "last_human_contact", "bot_paused_until", "lost_reason", "source", "priority",
}


def upsert(phone: str, fields: dict[str, Any]) -> dict | None:
    """Create the lead or update the columns given. Unknown keys are ignored."""
    phone = norm_phone(phone)
    if not valid_phone(phone):
        return None
    data = {k: v for k, v in fields.items() if k in _WRITABLE}

    cols = ["company_id", "phone", *data.keys(), "updated_at"]
    values = [company(), phone, *data.values(), datetime.now(timezone.utc)]
    placeholders = ", ".join(["%s"] * len(cols))
    updates = ", ".join(f"{c} = excluded.{c}" for c in [*data.keys(), "updated_at"])
    if not data:
        updates = "updated_at = excluded.updated_at"

    return db.one(
        f"""insert into leads ({", ".join(cols)}) values ({placeholders})
            on conflict (company_id, phone) do update set {updates}
            returning *""",
        values,
    )


def log_message(phone: str, direction: str, body: str,
                sender: str = "bot", wa_message_id: str = "") -> None:
    db.run(
        """insert into messages (company_id, phone, direction, sender, body, wa_message_id)
           values (%s, %s, %s, %s, %s, %s)""",
        (company(), norm_phone(phone), direction, sender, body, wa_message_id or None),
    )


def mark_sent(phone: str) -> None:
    db.run(
        "update leads set last_outbound = now(), updated_at = now() where company_id = %s and phone = %s",
        (company(), norm_phone(phone)),
    )


def mark_received(phone: str) -> None:
    db.run(
        "update leads set last_inbound = now(), updated_at = now() where company_id = %s and phone = %s",
        (company(), norm_phone(phone)),
    )


# --------------------------------------------------------------------------- audience

def audience(f: dict, limit: int = 0, exclude: set[str] | None = None) -> list[dict]:
    """Who a campaign should go to, decided by the database rather than by reading
    every lead into memory. The rules are the same ones the Apps Script bot uses:

      * mobile numbers only, never our own team
      * never anyone who said STOP, and never a closed lead
      * "new only" means we have neither messaged them nor heard from them
      * category / city / state narrow it further; city matches on prefix,
        so "Jaipur" also catches "Jaipur Nagar Nigam Area"
    """
    where = [
        "l.company_id = %s",
        "l.phone ~ '^91[6-9][0-9]{9}$'",
        "coalesce(l.opt_in, '')  <> 'Opted out'",
        "coalesce(l.status, '')  <> 'Opted out'",
        "coalesce(l.status, '') not in ('Won', 'Lost')",
        """not exists (select 1 from team_members t
                        where t.company_id = l.company_id and t.active
                          and regexp_replace(t.phone, '\\D', '', 'g') = l.phone)""",
    ]
    params: list[Any] = [company()]

    if f.get("newOnly", True):
        where.append("l.last_outbound is null and l.last_inbound is null")

    for key, column in (("categories", "category"), ("states", "state")):
        wanted = _as_list(f.get(key))
        if wanted:
            where.append(f"lower(coalesce(l.{column}, '')) = any(%s)")
            params.append([w.lower() for w in wanted])

    cities = _as_list(f.get("cities"))
    if cities:
        where.append("(" + " or ".join(["lower(coalesce(l.city, '')) like %s"] * len(cities)) + ")")
        params.extend(f"{c.lower()}%" for c in cities)

    if exclude:
        where.append("l.phone <> all(%s)")
        params.append(list(exclude))

    if f.get("since"):
        where.append("l.created_at >= %s")
        params.append(f["since"])

    sql = f"select l.* from leads l where {' and '.join(where)} order by l.created_at, l.phone"
    cap = limit or int(f.get("limit") or 0)
    if cap:
        sql += " limit %s"
        params.append(cap)
    return db.rows(sql, params)


def audience_size(f: dict) -> int:
    return len(audience(f))


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = value.split(",")
    return [str(v).strip() for v in value if str(v).strip()]


def sent_last_24h() -> int:
    row = db.one(
        """select count(*) as n from campaign_log
            where company_id = %s and at > now() - interval '24 hours'
              and data ->> 'result' = 'sent'""",
        (company(),),
    )
    return int(row["n"]) if row else 0
