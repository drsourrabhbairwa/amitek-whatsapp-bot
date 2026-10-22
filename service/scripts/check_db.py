"""Test the database connection and say plainly what is wrong.

    python -m scripts.check_db

Writes the same report to check_log.txt. Never prints your password.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

LINES: list[str] = []


def say(text: str = "") -> None:
    print(text)
    LINES.append(text)


def hide_password(text: str) -> str:
    return re.sub(r"://([^:/@]+):[^@]*@", r"://\1:****@", text)


def main() -> int:
    say("===== database check =====")
    try:
        from app import db, leads
        from app.config import get_settings
    except Exception as err:  # noqa: BLE001
        say(f"Could not load the bot's code: {err}")
        return 1

    s = get_settings()
    missing = s.missing()
    say(f".env missing values : {', '.join(missing) if missing else 'none'}")

    url = s.database_url
    if not url:
        say("DATABASE_URL is blank in .env. Nothing to test.")
        return 1

    say(f"DATABASE_URL        : {hide_password(url)}")

    # Shape checks that catch the usual copy-paste slips before we even dial.
    if url.startswith("[") or url.endswith("]"):
        say("PROBLEM: the whole string is wrapped in [ ] — remove the brackets.")
    if "[YOUR-PASSWORD]" in url or "YOUR-PASSWORD" in url:
        say("PROBLEM: [YOUR-PASSWORD] is still in there. Replace it, brackets and all,")
        say("         with your real database password.")
        return 1
    if ":6543" not in url:
        say("NOTE: this is not the port 6543 pooler string. Direct (5432) works, but the")
        say("      pooler copes better with a laptop that sleeps.")
    if " " in url.strip():
        say("PROBLEM: there is a space inside the string. It should be one unbroken line.")

    say()
    say("Connecting ...")
    try:
        db.pool()
        row = db.one("select current_database() as name, version() as v")
        say(f"CONNECTED to {row['name']}")
        say(f"Postgres: {str(row['v'])[:60]}")
    except Exception as err:  # noqa: BLE001
        text = hide_password(str(err))
        low = text.lower()
        say("COULD NOT CONNECT")
        if "password authentication failed" in low:
            say("-> The database password is wrong. Reset it in Supabase:")
            say("   Project Settings -> Database -> Reset database password.")
        elif "tenant or user not found" in low:
            say("-> Supabase did not recognise the username. The string is probably from")
            say("   another project, or the postgres.<ref> part got edited.")
        elif "could not translate host name" in low or "name or service" in low:
            say("-> The host name is wrong. Copy the string from Supabase again.")
        elif "timeout" in low or "timed out" in low:
            say("-> Could not reach Supabase at all. Check the internet connection.")
        say()
        say(f"Full message: {text[:500]}")
        return 1

    try:
        say(f"Leads in the database: {leads.counts().get('total', 0):,}")
    except Exception as err:  # noqa: BLE001
        say(f"Connected, but reading leads failed: {hide_password(str(err))[:300]}")
        say("(COMPANY_ID may be wrong in .env.)")
        return 1

    say()
    say("RESULT: DATABASE OK")
    return 0


if __name__ == "__main__":
    code = main()
    try:
        Path(__file__).resolve().parent.parent.joinpath("check_log.txt").write_text(
            "\n".join(LINES), encoding="utf-8"
        )
    except Exception:  # noqa: BLE001
        pass
    raise SystemExit(code)
