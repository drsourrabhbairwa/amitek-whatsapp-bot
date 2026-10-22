"""Business rules, read from company_settings.

These are the numbers the app UI lets the team change: sending hours, the daily
cap, how long to wait between follow-ups. They are cached for a minute so a
campaign tick that touches them repeatedly does not hammer the database, and so
a change in the UI still takes effect within a minute without a restart.
"""
from __future__ import annotations

import time
from typing import Any

from . import db
from .config import get_settings

DEFAULTS: dict[str, str] = {
    "DAILY_LIMIT": "250",        # campaign messages per rolling 24 hours
    "WORK_FROM": "9",            # first hour of the day the bot may send
    "WORK_TO": "20",             # last hour
    "MARKETING_GAP_DAYS": "7",   # minimum gap between marketing messages to one lead
    "MARKETING_MAX": "3",        # how many marketing messages one lead may ever get
    "REMINDER_MINUTES": "20",    # how often to nudge the team about an unanswered lead
    "REMINDER_MAX": "6",
    "FOLLOWUP_STEPS": "",        # "3:template_a, 8:template_b" — blank means off
    "FOLLOWUP_LANG": "en",
    "AUTOPILOT": "false",
    "OWNER_RULES": "",
    "TRAINED": "false",
}

_cache: dict[str, str] = {}
_loaded_at: float = 0.0
_TTL = 60.0


def _load() -> dict[str, str]:
    global _cache, _loaded_at
    if _cache and time.time() - _loaded_at < _TTL:
        return _cache
    found = {
        r["key"]: (r["value"] or "")
        for r in db.rows(
            "select key, value from company_settings where company_id = %s",
            (get_settings().company_id,),
        )
    }
    _cache = {**DEFAULTS, **found}
    _loaded_at = time.time()
    return _cache


def get(key: str, default: str | None = None) -> str:
    value = _load().get(key)
    if value is None or value == "":
        return DEFAULTS.get(key, "") if default is None else default
    return value


def num(key: str, default: float = 0) -> float:
    try:
        return float(get(key))
    except (TypeError, ValueError):
        return default


def flag(key: str) -> bool:
    return get(key).strip().lower() in {"true", "yes", "on", "1"}


def put(key: str, value: Any) -> None:
    db.run(
        """insert into company_settings (company_id, key, value) values (%s, %s, %s)
           on conflict (company_id, key) do update set value = excluded.value""",
        (get_settings().company_id, key, "" if value is None else str(value)),
    )
    _cache.clear()


def all_settings() -> dict[str, str]:
    return dict(_load())
