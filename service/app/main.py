"""The service.

    uvicorn app.main:app --host 0.0.0.0 --port 8000

Runs the same on a laptop and on a server. The only difference between the two
is what is in .env, which is the point: moving it to a rented server later is a
copy of this folder and a different DATABASE_URL, not a rewrite.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI

from . import api, campaigns, db, webhook
from .config import get_settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("amitek")
scheduler = BackgroundScheduler(timezone=get_settings().zone())


def campaign_job() -> None:
    try:
        result = campaigns.tick()
        if result.get("sent") or result.get("failed"):
            log.info("campaign tick: %s", result)
    except Exception as err:  # noqa: BLE001 - a failed tick must not kill the scheduler
        log.exception("campaign tick failed: %s", err)


@asynccontextmanager
async def lifespan(_: FastAPI):
    s = get_settings()
    missing = s.missing()
    if missing:
        log.warning("Not configured yet — fill these in .env: %s", ", ".join(missing))
    else:
        log.info("configuration looks complete")
    if not s.send_enabled:
        log.warning("SEND_ENABLED is false: replies are worked out and stored, but NOT sent")

    if s.database_url:
        try:
            db.pool()
        except Exception as err:  # noqa: BLE001
            log.error("could not reach the database: %s", err)

    scheduler.add_job(campaign_job, "interval", minutes=5, id="campaigns",
                      max_instances=1, coalesce=True)
    scheduler.start()
    # The port comes from however uvicorn was started, not from here, so this
    # line says what it actually knows rather than guessing a number.
    log.info("ready — campaign tick every 5 minutes, sending hours in %s", s.zone())
    try:
        yield
    finally:
        scheduler.shutdown(wait=False)
        db.close()


app = FastAPI(title="Amitek Sales Employee", version="2.0.0", lifespan=lifespan)
app.include_router(webhook.router)
app.include_router(api.router)


@app.get("/health")
def health():
    """What a monitor checks. 'ok' here means the database answered just now."""
    return {"ok": db.healthy(), "send_enabled": get_settings().send_enabled}


@app.get("/")
def root():
    return {
        "service": "Amitek Sales Employee",
        "health": "/health",
        "status": "/api/status",
        "webhook": "/wh/<your WEBHOOK_SECRET>",
    }
