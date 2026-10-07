"""In-process scheduler: hourly lead check and 9:00 AM IST daily summary (no separate cron service needed).

Run a single web instance; with more instances, set ENABLE_SCHEDULER=false on all but one.
"""
import logging
import threading
import time
from datetime import datetime, timedelta

from .tracker import IST

log = logging.getLogger(__name__)


def next_daily(now_ist: datetime, hour: int = 9) -> datetime:
    target = now_ist.replace(hour=hour, minute=0, second=0, microsecond=0)
    return target if target > now_ist else target + timedelta(days=1)


def start(get_tracker, check_every_s: int = 3600, daily_hour_ist: int = 9) -> threading.Thread:
    def loop():
        next_check = time.monotonic() + 60  # first check a minute after boot
        next_summary = next_daily(datetime.now(IST), daily_hour_ist)
        while True:
            try:
                if time.monotonic() >= next_check:
                    log.info("lead check: %s", get_tracker().check())
                    next_check = time.monotonic() + check_every_s
                if datetime.now(IST) >= next_summary:
                    get_tracker().daily_summary()
                    next_summary = next_daily(datetime.now(IST), daily_hour_ist)
            except Exception:
                log.exception("scheduler run failed")
            time.sleep(30)

    t = threading.Thread(target=loop, name="lead-scheduler", daemon=True)
    t.start()
    return t
