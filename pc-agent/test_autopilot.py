"""Checks the PC autopilot against real .xlsx and .csv files, and a fake bot."""
import importlib.util, json, os, shutil, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import openpyxl

HERE = tempfile.mkdtemp()
SRC = "/home/claude/amitek-whatsapp-bot/pc-agent/amitek_autopilot.py"
shutil.copy(SRC, os.path.join(HERE, "amitek_autopilot.py"))
spec = importlib.util.spec_from_file_location("agent", os.path.join(HERE, "amitek_autopilot.py"))
agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)

calls = []
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        calls.append(body)
        rows = body["args"]["rows"]
        out = {"added": len(rows), "skipped": 0, "invalid": 0, "welcome": True}
        if any(r["phone"] == "919000000099" for r in rows):
            out = {"error": "A campaign is running."}
        payload = json.dumps(out).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload))); self.end_headers()
        self.wfile.write(payload)
    def log_message(self, *a): pass

srv = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = "http://127.0.0.1:%d/exec" % srv.server_port

INBOX = os.path.join(HERE, "inbox"); os.makedirs(INBOX)
cfg = {"webAppUrl": URL, "pin": "1234", "inbox": INBOX}
json.dump(cfg, open(os.path.join(HERE, "config.json"), "w"))
agent.STATE_PATH = os.path.join(HERE, "state.json"); agent.LOG_PATH = os.path.join(HERE, "log.txt")
agent.time.sleep = lambda n: None  # no waiting in the test

def xlsx(path, rows):
    wb = openpyxl.Workbook(); ws = wb.active
    for r in rows: ws.append(r)
    wb.save(path)

# 1. a normal file, headings not on line 1, mixed phone shapes, a gap column, a duplicate, a landline
xlsx(os.path.join(INBOX, "leads.xlsx"), [
    ["Amitek lead list", "", "", ""],
    ["", "", "", ""],
    ["Firm Name", "Mobile No", "City", "State"],
    ["Sharma Paints", "9876543210", "Jaipur", "Rajasthan"],
    ["Verma Traders", "+91 98765 43211", "Jaipur", "Rajasthan"],
    ["Gupta Hardware", "09876543212", "Ajmer", "Rajasthan"],
    ["Repeat Co", "9876543210", "Jaipur", ""],       # duplicate phone
    ["Landline Shop", "0141 2345678", "Jaipur", ""],  # not a mobile
    ["", "", "", ""],
])
state = {"done": {}}
agent.scan_once(cfg, state)
rows = calls[0]["args"]["rows"]
assert list(calls[0].keys())[0] == "_app", "_app must come first so the bot recognises the app"
assert calls[0]["action"] == "importLeads" and calls[0]["pin"] == "1234"
assert [r["phone"] for r in rows] == ["919876543210", "919876543211", "919876543212"], rows
assert rows[0]["business"] == "Sharma Paints" and rows[0]["city"] == "Jaipur" and rows[0]["state"] == "Rajasthan"
assert os.path.exists(os.path.join(INBOX, "done", "leads.xlsx")), "imported file is moved to done"
print("ok  xlsx: headings found, phones normalised, duplicate and landline left out, file moved")

# 2. the same file again is not imported twice
shutil.copy(os.path.join(INBOX, "done", "leads.xlsx"), os.path.join(INBOX, "leads.xlsx"))
before = len(calls)
agent.scan_once(cfg, state)
assert len(calls) == before, "the same content is not sent again"
print("ok  the same file copied in again is not imported twice")

# 3. csv works too
open(os.path.join(INBOX, "more.csv"), "w", encoding="utf-8-sig").write(
    "Name,Phone,Category\nRamesh,9811122233,Applicator\nSuresh,bad,Dealer\n")
agent.scan_once(cfg, state)
rows = calls[-1]["args"]["rows"]
assert [r["phone"] for r in rows] == ["919811122233"] and rows[0]["category"] == "Applicator", rows
print("ok  csv read, bad number skipped")

# 4. a file with no phone column goes to the problem folder, the watch keeps going
open(os.path.join(INBOX, "junk.csv"), "w").write("a,b\n1,2\n")
agent.scan_once(cfg, state)
assert os.path.exists(os.path.join(INBOX, "problem", "junk.csv"))
print("ok  unreadable file set aside, not retried forever")

# 5. the bot refusing (a campaign is running) leaves the file in the inbox to try again
open(os.path.join(INBOX, "later.csv"), "w").write("Phone\n9000000099\n")
agent.scan_once(cfg, state)
assert os.path.exists(os.path.join(INBOX, "later.csv")), "stays in the inbox"
print("ok  when the bot refuses, the file waits and is tried again")

# 6. the bot being unreachable (no net / PC was off) also leaves the file
cfg_bad = dict(cfg, webAppUrl="http://127.0.0.1:9/exec")
os.remove(os.path.join(INBOX, "later.csv"))
open(os.path.join(INBOX, "offline.csv"), "w").write("Phone\n9811199999\n")
agent.scan_once(cfg_bad, state)
assert os.path.exists(os.path.join(INBOX, "offline.csv")), "stays in the inbox until the net is back"
agent.scan_once(cfg, state)
assert os.path.exists(os.path.join(INBOX, "done", "offline.csv")), "goes through once the net is back"
print("ok  no internet: the file waits, then goes through by itself when the net returns")

# 7. a big file is sent in chunks of 300
big = [["Phone", "Name"]] + [["98%08d" % i, "L%d" % i] for i in range(10000000, 10000650)]
xlsx(os.path.join(INBOX, "big.xlsx"), big)
before = len(calls)
agent.scan_once(cfg, state)
sizes = [len(c["args"]["rows"]) for c in calls[before:]]
assert sizes == [300, 300, 50], sizes
print("ok  650 leads sent in chunks of 300, 300, 50")
print("\nall PC autopilot checks passed")
