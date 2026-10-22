#!/usr/bin/env python3
"""
Amitek lead autopilot - the PC side.

Drop an Excel or CSV file of leads into the inbox folder. This watches that folder and sends the leads
to the Amitek bot, which files them by category and (if an always-on welcome campaign is running)
greets them by itself, inside the daily limit and the sending hours.

It keeps running in the background. If the PC sleeps, loses power or loses the internet, it picks up
where it left off the moment it is back: a file that did not go through stays in the inbox and is tried again.

Nothing is sent from this PC to WhatsApp directly. It only hands the leads to the bot.

Needs Python 3.8+ and nothing else (no pip install).
"""

import csv
import hashlib
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")
STATE_PATH = os.path.join(HERE, "state.json")
LOG_PATH = os.path.join(HERE, "autopilot.log")

CHUNK = 300          # the bot takes up to 300 leads per call
SCAN_SECONDS = 300   # look in the inbox every 5 minutes
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}

# Which spreadsheet heading means which field. Everything is lower-cased and stripped first.
HEADERS = {
    "phone": ["phone", "phone no", "phone number", "mobile", "mobile no", "mobile number",
              "number", "contact", "contact no", "contact number", "whatsapp"],
    "name": ["name", "person", "contact name", "owner", "owner name"],
    "business": ["business", "business name", "firm", "firm name", "company", "company name", "shop", "shop name"],
    "category": ["category", "type", "lead type", "business type"],
    "city": ["city", "town", "location", "place"],
    "state": ["state", "region"],
}


def log(message):
    line = "%s  %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), message)
    print(line, flush=True)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def load_json(path, fallback):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return fallback


def save_state(state):
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)
    os.replace(tmp, STATE_PATH)


# --------------------------------------------------------------------------- reading the file

def norm_header(value):
    key = re.sub(r"[^a-z ]+", " ", str(value or "").strip().lower())
    key = re.sub(r"\s+", " ", key).strip()
    for field, names in HEADERS.items():
        if key in names:
            return field
    return None


def col_letters(ref):
    """'BC12' -> 'BC' -> 0-based column index."""
    letters = re.match(r"([A-Z]+)", ref or "")
    if not letters:
        return None
    index = 0
    for char in letters.group(1):
        index = index * 26 + (ord(char) - 64)
    return index - 1


def read_xlsx(path):
    """Rows of an .xlsx, using only the standard library. Returns a list of lists of strings."""
    with zipfile.ZipFile(path) as zf:
        shared = []
        if "xl/sharedStrings.xml" in zf.namelist():
            root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in root.findall("m:si", NS):
                shared.append("".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])))
        sheets = sorted(n for n in zf.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n))
        if not sheets:
            return []
        root = ET.fromstring(zf.read(sheets[0]))
        rows = []
        for row in root.iter("{%s}row" % NS["m"]):
            cells = {}
            for cell in row.findall("m:c", NS):
                index = col_letters(cell.get("r"))
                if index is None:
                    continue
                kind = cell.get("t")
                if kind == "inlineStr":
                    text = "".join(t.text or "" for t in cell.iter("{%s}t" % NS["m"]))
                else:
                    node = cell.find("m:v", NS)
                    text = node.text if node is not None and node.text else ""
                    if kind == "s" and text.isdigit() and int(text) < len(shared):
                        text = shared[int(text)]
                cells[index] = (text or "").strip()
            if cells:
                width = max(cells) + 1
                rows.append([cells.get(i, "") for i in range(width)])
        return rows


def read_csv(path):
    for encoding in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            with open(path, newline="", encoding=encoding) as fh:
                return [[(c or "").strip() for c in row] for row in csv.reader(fh)]
        except UnicodeDecodeError:
            continue
    return []


def clean_phone(value):
    """Indian mobile -> 91XXXXXXXXXX, or '' when it is not one (landlines and short numbers are left out)."""
    digits = re.sub(r"\D", "", str(value or ""))
    digits = re.sub(r"^0+", "", digits)
    if len(digits) == 10:
        digits = "91" + digits
    elif len(digits) == 12 and digits.startswith("91"):
        pass
    elif len(digits) == 13 and digits.startswith("091"):
        digits = digits[1:]
    else:
        return ""
    return digits if re.match(r"^91[6-9]\d{9}$", digits) else ""


def leads_from(path):
    rows = read_xlsx(path) if path.lower().endswith((".xlsx", ".xlsm")) else read_csv(path)
    if not rows:
        return [], "the file is empty or could not be read"

    header_at, columns = None, {}
    for index, row in enumerate(rows[:10]):           # the headings are not always on line 1
        found = {}
        for position, cell in enumerate(row):
            field = norm_header(cell)
            if field and field not in found:
                found[field] = position
        if "phone" in found:
            header_at, columns = index, found
            break
    if header_at is None:
        return [], "no Phone (or Mobile / Number) column found in the first 10 lines"

    leads, seen, bad = [], set(), 0
    for row in rows[header_at + 1:]:
        def cell(field):
            position = columns.get(field)
            return row[position].strip() if position is not None and position < len(row) else ""
        phone = clean_phone(cell("phone"))
        if not phone:
            if any(c.strip() for c in row):
                bad += 1
            continue
        if phone in seen:
            continue
        seen.add(phone)
        leads.append({"phone": phone, "name": cell("name")[:60], "business": cell("business")[:80],
                      "category": cell("category")[:30], "city": cell("city")[:40], "state": cell("state")[:40]})
    return leads, ("%d line(s) had no usable mobile number" % bad) if bad else ""


# --------------------------------------------------------------------------- talking to the bot

def call_bot(config, action, args):
    body = json.dumps({"_app": 1, "pin": str(config["pin"]), "action": action, "args": args}).encode("utf-8")
    request = urllib.request.Request(config["webAppUrl"], data=body,
                                     headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def send_leads(config, leads):
    """Returns (totals, error). An error means the file is left in the inbox and tried again later."""
    totals = {"added": 0, "skipped": 0, "invalid": 0}
    welcome = False
    for start in range(0, len(leads), CHUNK):
        chunk = leads[start:start + CHUNK]
        try:
            result = call_bot(config, "importLeads", {"rows": chunk})
        except (urllib.error.URLError, OSError, ValueError) as err:
            return totals, "could not reach the bot (%s)" % err
        if result.get("error"):
            return totals, result["error"]
        for key in totals:
            totals[key] += int(result.get(key) or 0)
        welcome = welcome or bool(result.get("welcome"))
        time.sleep(2)   # gentle on the script's quota
    totals["welcome"] = welcome
    return totals, ""


# --------------------------------------------------------------------------- the folder watch

def file_id(path):
    """Content hash, so the same file copied in twice is not imported twice, and a changed file is."""
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(65536), b""):
            digest.update(block)
    return digest.hexdigest()


def settled(path):
    """True once the file has stopped growing, so a half-copied file is not read."""
    try:
        first = os.path.getsize(path)
        time.sleep(2)
        return first == os.path.getsize(path) and first > 0
    except OSError:
        return False


def handle_file(config, state, inbox, name):
    path = os.path.join(inbox, name)
    if not settled(path):
        return
    try:
        key = file_id(path)
    except OSError as err:
        log("could not read %s: %s" % (name, err))
        return
    if key in state.get("done", {}):
        log("%s was already imported earlier, moving it aside" % name)
        move_to(path, os.path.join(inbox, "done"))
        return

    leads, note = leads_from(path)
    if note:
        log("%s: %s" % (name, note))
    if not leads:
        log("%s: nothing to import, moved to the problem folder" % name)
        move_to(path, os.path.join(inbox, "problem"))
        return

    log("%s: %d lead(s) found, sending to the bot" % (name, len(leads)))
    totals, error = send_leads(config, leads)
    if error:
        log("%s: NOT imported (%s). It stays in the inbox and will be tried again." % (name, error))
        return

    state.setdefault("done", {})[key] = {"file": name, "at": datetime.now().isoformat(timespec="seconds"),
                                         "added": totals["added"]}
    save_state(state)
    log("%s: %d added, %d already known, %d without a usable number%s"
        % (name, totals["added"], totals["skipped"], totals["invalid"],
           ". The welcome campaign will greet the new ones." if totals.get("welcome") else ""))
    move_to(path, os.path.join(inbox, "done"))


def move_to(path, folder):
    os.makedirs(folder, exist_ok=True)
    target = os.path.join(folder, os.path.basename(path))
    if os.path.exists(target):
        stem, ext = os.path.splitext(os.path.basename(path))
        target = os.path.join(folder, "%s %s%s" % (stem, datetime.now().strftime("%Y%m%d-%H%M%S"), ext))
    try:
        shutil.move(path, target)
    except OSError as err:
        log("could not move %s: %s" % (os.path.basename(path), err))


def scan_once(config, state):
    inbox = config["inbox"]
    os.makedirs(inbox, exist_ok=True)
    try:
        names = sorted(n for n in os.listdir(inbox)
                       if n.lower().endswith((".xlsx", ".xlsm", ".csv"))
                       and not n.startswith("~$")
                       and os.path.isfile(os.path.join(inbox, n)))
    except OSError as err:
        log("could not read the inbox: %s" % err)
        return
    for name in names:
        try:
            handle_file(config, state, inbox, name)
        except Exception as err:                      # one bad file never stops the watch
            log("%s: unexpected problem (%s). It stays in the inbox." % (name, err))


def main():
    config = load_json(CONFIG_PATH, None)
    if not config or not config.get("webAppUrl") or not config.get("pin"):
        log("Set up config.json first (webAppUrl and pin). See README.md.")
        return 1
    config.setdefault("inbox", os.path.join(HERE, "inbox"))
    state = load_json(STATE_PATH, {"done": {}})

    once = "--once" in sys.argv
    log("Autopilot started. Watching: %s" % config["inbox"])
    while True:
        scan_once(config, state)
        if once:
            return 0
        time.sleep(max(60, int(config.get("scanSeconds") or SCAN_SECONDS)))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log("Stopped.")
