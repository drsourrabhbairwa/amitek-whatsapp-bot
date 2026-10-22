"""Load a lead file straight into Postgres.

    python -m scripts.import_leads "D:\\Lead Data\\Amitek_Leads_Cleaned_AllLeads.csv"
    python -m scripts.import_leads leads.csv --state Rajasthan --dry-run

What the app's own Import screen does in 191 round trips and a couple of hours,
this does in one pass. It reads the raw export — no need to rename a single
column first — works out each lead's category the same way the bot does, keeps
only numbers WhatsApp can actually reach, and writes in blocks of 1000.

Leads already in the database are left exactly as they are. Re-running the same
file changes nothing, so a half-finished import is safe to just run again.
"""
from __future__ import annotations

import argparse
import csv
import re
import sys
from pathlib import Path

# Run from the service folder so "app" is importable: python -m scripts.import_leads
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import db, leads  # noqa: E402
from app.config import get_settings  # noqa: E402

# The bot's own rules for guessing what kind of business a lead is, so leads
# imported here land in the same buckets as leads sorted by the bot.
KEYWORDS: list[tuple[str, re.Pattern[str]]] = [
    ("Applicator", re.compile(r"water ?proof|leak|seepage|damp|painter|painting (service|contractor|work)"
                              r"|paint contractor|colou?r contractor", re.I)),
    ("Architect", re.compile(r"architect|interior|design studio|\bdecor\b|decorators?|\barch\b", re.I)),
    ("Builder", re.compile(r"builder|developer|buildcon|build ?tech|realty|real estate|estate|infra"
                           r"|housing|homes\b|properties|township|construction co", re.I)),
    ("Contractor", re.compile(r"contractor|construction|civil|engineers?\b|projects?\b", re.I)),
    ("Manufacturer", re.compile(r"manufactur|industries|chem(ical)?s?\b", re.I)),
    ("Dealer", re.compile(r"paints?\b|hardware|traders?|trading|colou?rs?|sanitary|bathware|plywood|ply\b"
                          r"|wood ?work|ceiling|tiles?|building material|marble|cement|steel|agency"
                          r"|agencies|store|mart|depot|suppliers?|distribut|enterprises?|sales\b", re.I)),
]
BUSINESS_TYPE = {
    "paint store": "Dealer", "hardware store": "Dealer", "building materials supplier": "Dealer",
    "paint manufacturer": "Manufacturer",
    "interior designer": "Architect", "architect": "Architect", "architecture firm": "Architect",
    "architectural designer": "Architect", "interior architect office": "Architect",
    "real estate builders & construction company": "Builder", "home builder": "Builder",
    "real estate developer": "Builder", "construction company": "Builder",
    "waterproofing service": "Applicator", "painter": "Applicator", "painting": "Applicator",
    "house painter": "Applicator", "painting contractor": "Applicator",
    "contractor": "Contractor", "general contractor": "Contractor", "civil engineer": "Contractor",
}
SEGMENT = {
    "Builder / Architect / Interior": "Builder",
    "Paint Shop / Dealer / Contractor": "Dealer",
    "Waterproofing": "Applicator",
}
# Column names we accept, in the order we prefer them.
PHONE_KEYS = ("whatsapp number", "phone", "mobile", "number", "phone (10-digit)")
NAME_KEYS = ("name", "display name", "contact name")
BUSINESS_KEYS = ("business", "business name", "company", "firm")
CITY_KEYS = ("city", "town")
STATE_KEYS = ("state",)
CATEGORY_KEYS = ("category", "lead category")


def pick(row: dict[str, str], keys: tuple[str, ...]) -> str:
    for key in keys:
        value = (row.get(key) or "").strip()
        if value:
            return value
    return ""


def category_for(row: dict[str, str]) -> str:
    given = pick(row, CATEGORY_KEYS)
    if given in leads.CATEGORIES:
        return given
    business_type = pick(row, ("business type",)).lower()
    if business_type in BUSINESS_TYPE:
        return BUSINESS_TYPE[business_type]
    name = pick(row, BUSINESS_KEYS) or pick(row, NAME_KEYS)
    for category, pattern in KEYWORDS:
        if pattern.search(name):
            return category
    segment = pick(row, ("segment",)).split(",")[0].strip()
    return SEGMENT.get(segment, "Other")


def read_file(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return [
            {(k or "").strip().lower(): v for k, v in row.items()}
            for row in csv.DictReader(handle)
        ]


def main() -> int:
    parser = argparse.ArgumentParser(description="Import leads into Supabase.")
    parser.add_argument("csv_file", type=Path)
    parser.add_argument("--state", help="import only this state")
    parser.add_argument("--city", help="import only cities starting with this")
    parser.add_argument("--source", default="", help="tag these leads, e.g. 'Gujarat export Oct'")
    parser.add_argument("--mobiles-only", action="store_true", default=True,
                        help="skip landline / IVR numbers (default)")
    parser.add_argument("--all-numbers", dest="mobiles_only", action="store_false")
    parser.add_argument("--dry-run", action="store_true", help="report what would happen, write nothing")
    args = parser.parse_args()

    if not args.csv_file.exists():
        print(f"No such file: {args.csv_file}")
        return 1
    missing = [m for m in get_settings().missing() if m in {"DATABASE_URL", "COMPANY_ID"}]
    if missing:
        print("Fill these in .env first: " + ", ".join(missing))
        return 1

    raw = read_file(args.csv_file)
    print(f"{len(raw):,} rows in {args.csv_file.name}")

    prepared: dict[str, tuple] = {}
    skipped = {"bad number": 0, "landline": 0, "filtered out": 0}
    for row in raw:
        if args.mobiles_only and (row.get("number type") or "Mobile").strip() != "Mobile":
            skipped["landline"] += 1
            continue
        state, city = pick(row, STATE_KEYS), pick(row, CITY_KEYS)
        if args.state and state.lower() != args.state.lower():
            skipped["filtered out"] += 1
            continue
        if args.city and not city.lower().startswith(args.city.lower()):
            skipped["filtered out"] += 1
            continue
        phone = leads.norm_phone(pick(row, PHONE_KEYS))
        if not leads.valid_phone(phone):
            skipped["bad number"] += 1
            continue
        category = category_for(row)
        prepared[phone] = (
            get_settings().company_id, phone, pick(row, NAME_KEYS), pick(row, BUSINESS_KEYS),
            category, leads.TIER_OF.get(category, "To confirm"), city, state,
            args.source or args.csv_file.stem,
        )

    print(f"{len(prepared):,} usable leads  "
          + "  ".join(f"({n:,} {why})" for why, n in skipped.items() if n))
    if not prepared:
        return 0

    existing = {
        r["phone"] for r in db.rows(
            "select phone from leads where company_id = %s and phone = any(%s)",
            (get_settings().company_id, list(prepared)),
        )
    }
    fresh = [v for k, v in prepared.items() if k not in existing]
    print(f"{len(existing):,} already in the database, {len(fresh):,} new")

    if args.dry_run:
        print("\n--dry-run: nothing written. Sample of what would be added:")
        for record in fresh[:5]:
            print(f"  +{record[1]}  {record[3][:40]:40s}  {record[6][:15]:15s}  {record[4]}")
        return 0
    if not fresh:
        print("Nothing to do.")
        return 0

    sql = """insert into leads
               (company_id, phone, name, business, category, tier, city, state, source,
                status, stage, opt_in, campaign)
             values (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'New', 'New', 'Not Asked', 'Imported')
             on conflict (company_id, phone) do nothing"""
    written = 0
    for start in range(0, len(fresh), 1000):
        block = fresh[start:start + 1000]
        db.run_many(sql, block)
        written += len(block)
        print(f"  written {written:,} of {len(fresh):,}", end="\r", flush=True)
    print(f"\nDone. {written:,} leads added.")
    print(f"Total leads now: {leads.counts().get('total', 0):,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
