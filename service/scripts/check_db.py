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
    # Greedy to the LAST @, because the password may contain an @ itself.
    return re.sub(r"://([^:/@]+):.*@", r"://\1:****@", text)


# Characters that mean something inside a connection URI and so cannot appear
# raw in a password. Everything here must be written as its %XX code instead.
MUST_ENCODE = {"@": "%40", ":": "%3A", "/": "%2F", "?": "%3F", "#": "%23",
               "[": "%5B", "]": "%5D", " ": "%20", "%": "%25"}


def password_problems(url: str) -> list[str]:
    """Find a password that will break the URI, without ever printing it."""
    body = url.split("://", 1)[-1]
    host_part = body.rsplit("@", 1)
    if len(host_part) != 2:
        return []
    creds = host_part[0]
    if ":" not in creds:
        return []
    password = creds.split(":", 1)[1]
    found = sorted({ch for ch in password if ch in MUST_ENCODE})
    if not found:
        return []
    return [
        "PROBLEM: your password contains " + ", ".join(f"'{c}'" for c in found)
        + " — these have a special meaning inside a connection string.",
        "         Replace each one in the DATABASE_URL line with its code:",
        *[f"           {c}   ->   {MUST_ENCODE[c]}" for c in found],
        "         Change it ONLY inside the string. Your real password stays as it is.",
    ]


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

    problems = password_problems(url)
    if problems:
        say()
        for line in problems:
            say(line)
        say()
        say("Fix that line in .env, save it, and run this check again.")
        return 1

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
    # Close the pool before the interpreter shuts down. Python 3.14 refuses to
    # join a thread during finalization, so leaving it open prints an alarming
    # PythonFinalizationError traceback after a run that actually succeeded.
    try:
        from app import db as _db
        _db.close()
    except Exception:  # noqa: BLE001
        pass
    try:
        Path(__file__).resolve().parent.parent.joinpath("check_log.txt").write_text(
            "\n".join(LINES), encoding="utf-8"
        )
    except Exception:  # noqa: BLE001
        pass
    raise SystemExit(code)
