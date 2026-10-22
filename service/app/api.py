"""Read and control endpoints, for the app UI and for checking on the bot.

Everything here is scoped to COMPANY_ID. None of it takes a phone number or a
template from the caller and sends anything without a campaign behind it, so
this surface cannot be used to blast messages.
"""
from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import campaigns, db, leads, settings_store
from .config import get_settings

router = APIRouter(prefix="/api")


@router.get("/status")
def status():
    """Deliberately cannot fail. This is the page you open when something is
    wrong, so it reports the trouble instead of becoming more of it."""
    s = get_settings()
    out: dict = {
        "send_enabled": s.send_enabled,
        "missing_config": s.missing(),
        "database": False,
    }
    try:
        db.pool()
        out["database"] = db.healthy()
    except Exception as err:  # noqa: BLE001
        out["database_error"] = _explain(err)
        return out

    for label, work in (
        ("leads", leads.counts),
        ("sent_last_24h", leads.sent_last_24h),
        ("daily_limit", lambda: int(settings_store.num("DAILY_LIMIT", 250))),
        ("sending_hours_open", campaigns.work_open),
    ):
        try:
            out[label] = work()
        except Exception as err:  # noqa: BLE001
            out[label] = None
            out.setdefault("errors", {})[label] = _explain(err)
    return out


def _explain(err: Exception) -> str:
    """A database error in plain words, with no password in it."""
    text = re.sub(r"://([^:]+):[^@]*@", r"://\1:****@", str(err))[:400]
    low = text.lower()
    if "password authentication failed" in low:
        return "Wrong database password in DATABASE_URL. " + text
    if "could not translate host name" in low or "name or service not known" in low:
        return "The host in DATABASE_URL is wrong — copy the string from Supabase again. " + text
    if "timeout" in low or "timed out" in low:
        return ("Could not reach Supabase. Check the internet, and that you used the "
                "Transaction pooler string (port 6543). " + text)
    if "tenant or user not found" in low:
        return ("Supabase did not recognise the user — the DATABASE_URL is from the wrong "
                "project, or the username part was edited. " + text)
    if "is empty" in low:
        return "DATABASE_URL is still blank in .env. " + text
    return text


@router.get("/leads/{phone}")
def one_lead(phone: str):
    lead = leads.get(phone)
    if not lead:
        raise HTTPException(status_code=404, detail="No such lead")
    return {"lead": lead, "messages": leads.recent_messages(phone, 50)}


@router.get("/leads")
def search(q: str = "", city: str = "", category: str = "", limit: int = 50):
    where, params = ["company_id = %s"], [leads.company()]
    if q:
        where.append("(phone like %s or business ilike %s or name ilike %s)")
        params += [f"%{q}%", f"%{q}%", f"%{q}%"]
    if city:
        where.append("city ilike %s")
        params.append(f"{city}%")
    if category:
        where.append("category = %s")
        params.append(category)
    params.append(min(limit, 200))
    return db.rows(
        f"select * from leads where {' and '.join(where)} order by updated_at desc limit %s",
        params,
    )


class Filter(BaseModel):
    categories: list[str] = Field(default_factory=list)
    cities: list[str] = Field(default_factory=list)
    states: list[str] = Field(default_factory=list)
    newOnly: bool = True
    keepOn: bool = False
    limit: int = 0


@router.post("/audience/count")
def audience_count(f: Filter):
    """How many leads a filter would reach. The screen behind "50 leads match"."""
    picked = leads.audience(f.model_dump())
    return {
        "count": len(picked),
        "sample": [
            {"phone": p["phone"], "business": p.get("business"),
             "city": p.get("city"), "category": p.get("category")}
            for p in picked[:8]
        ],
    }


@router.get("/campaigns")
def list_campaigns():
    return campaigns.all_campaigns()


class CampaignIn(BaseModel):
    name: str
    template: str
    lang: str = "en"
    vars: str = "{Name}"
    filter: Filter = Field(default_factory=Filter)


@router.post("/campaigns")
def create_campaign(body: CampaignIn):
    payload = body.model_dump()
    payload["filter"] = body.filter.model_dump()
    payload["status"] = "Draft"
    return {"id": campaigns.save_campaign(None, payload)}


@router.post("/campaigns/{campaign_id}/{action}")
def control(campaign_id: int, action: str):
    """start / pause / resume a campaign. Nothing else may change its status."""
    campaign = campaigns.get_campaign(campaign_id)
    if not campaign:
        raise HTTPException(status_code=404, detail="No such campaign")
    if action == "start":
        campaigns.patch(campaign_id, {"status": "Running",
                                      "started": campaigns.now().isoformat()})
    elif action == "pause":
        campaigns.patch(campaign_id, {"status": "Paused"})
    elif action == "resume":
        campaigns.patch(campaign_id, {"status": "Running"})
    else:
        raise HTTPException(status_code=400, detail="Use start, pause or resume")
    return campaigns.get_campaign(campaign_id)


@router.get("/settings")
def read_settings():
    return settings_store.all_settings()


@router.post("/settings/{key}")
def write_setting(key: str, value: str = ""):
    settings_store.put(key, value)
    return {key: settings_store.get(key)}
