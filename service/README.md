# Amitek Sales Employee — the service

This is the bot without Google Apps Script underneath it.

Same WhatsApp number, same BlueTick account, same approved templates, same
behaviour. What changes is where the leads live and what happens when the bot
needs to find one.

| | Apps Script + Sheet | This service |
|---|---|---|
| Find one lead | reads every row of the sheet | indexed lookup |
| 34,485 leads | ~1,000,000 cells read, every time | the work does not grow with the list |
| Import that whole file | 191 calls, hours, usually dies | ~90 seconds |
| Longest a job may run | 6 minutes, hard stop | no limit |
| Script time per day | 90 minutes, then it stops for the day | no limit |
| Outbound calls per day | 20,000 | no limit |

Everything the bot does is driven by `.env` and by the `company_settings`
table. Moving this from a laptop to a rented server later is: copy the folder,
change `.env`, start it. No code changes.

---

## What you need before you start

1. **Python 3.11 or newer.** https://www.python.org/downloads/ — on the first
   screen of the installer, tick **"Add python.exe to PATH"**. This matters;
   without it nothing below works.
2. **Your Supabase database connection string.** Supabase → your
   `amitek-sales-employee` project → Project Settings → Database → Connection
   string → **Transaction pooler** (port 6543). Copy it and replace
   `[YOUR-PASSWORD]` with your database password.
   Use the pooler, not port 5432 — it is the one that survives a laptop sleeping.
3. **BlueTick API details.** Bulk Campaign → API details → `WA_PHONE_NUMBER_ID`
   and `WA_ACCESS_TOKEN`.
4. **Your Claude API key.**

## Setting it up

Double-click **`setup_windows.bat`**. It checks Python, installs what the bot
needs into a private folder, creates `.env`, and opens it in Notepad for you to
fill in. Run it once.

Then double-click **`start.bat`**. Leave that window open — closing it stops
the bot.

Check it is alive:

* <http://localhost:8000/health> → should say `{"ok": true}`
* <http://localhost:8000/api/status> → counts, limits, and anything still missing

`/api/status` lists `missing_config` if something in `.env` is still blank.
Start there whenever something does not work.

## Loading your leads

Drag your CSV onto **`import.bat`**. It shows you what it found and what it
would add, asks once, and then writes.

It reads the raw export — you do not have to rename a single column — keeps
only numbers WhatsApp can reach, and works out each lead's category the same
way the bot does. Leads already in the database are left untouched, so running
the same file twice is harmless.

From a terminal, if you prefer:

```
.venv\Scripts\python -m scripts.import_leads "D:\Lead Data\AllLeads.csv" --dry-run
.venv\Scripts\python -m scripts.import_leads "D:\Lead Data\AllLeads.csv" --state Rajasthan
```

## The one thing a laptop cannot do

A campaign sends fine from a laptop. **Replies do not arrive.**

WhatsApp delivers an incoming message by calling a web address, from Meta's
servers, within seconds. `localhost:8000` is not reachable from the internet,
so with nothing else in place, every customer reply is lost.

Two ways to fix it, and only the second one actually lasts:

**While testing — Cloudflare Tunnel.** Free, no account needed:

```
winget install Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:8000
```

It prints a public `https://something.trycloudflare.com` address. In BlueTick →
Webhooks, set the URL to that address plus `/wh/` plus your `WEBHOOK_SECRET`.
The address changes every time you restart the tunnel, so you re-paste it each
time — fine for testing, not for running a business.

**For real — a rented server.** ~₹500/month in Mumbai or Bangalore, same region
as the database. The address never changes, it answers at 3 AM, and the 9 AM
campaign runs whether or not anyone opened a laptop. The same folder runs
there unchanged.

Until then, understand what you have: **campaigns go out, replies come back
only while the laptop is awake, online, and the tunnel is running.**

## Safety switches

`SEND_ENABLED=false` in `.env` means the bot works out every reply and writes
it to the database but sends nothing. Leave it false until you have read a few
replies and agree with them. This is what stops a bad prompt from messaging
34,000 people.

Three rules are checked before every campaign message, in this order:

1. **Sending hours** — nothing before `WORK_FROM` or after `WORK_TO`.
2. **Daily limit** — at most `DAILY_LIMIT` in any rolling 24 hours.
3. **One per lead per campaign** — a lead already logged is never sent again.

If WhatsApp refuses a template, or five sends fail in a row, the campaign
pauses itself and the team gets told. It does not keep burning the number.

Anyone who replies `stop`, `band karo`, `unsubscribe` or similar is opted out
immediately and never messaged again. The match is on the whole message, so
"stop by tomorrow" is treated as what it is.

## What is where

```
app/
  config.py          .env — secrets, connection details, switches
  settings_store.py  company_settings — hours, limits, the rules the UI changes
  db.py              the connection pool
  leads.py           lead and message queries, and the audience picker
  campaigns.py       the campaign engine: batches, limits, pausing on refusal
  ai.py              the prompt and the Claude call
  whatsapp.py        sending via BlueTick
  webhook.py         incoming messages, opt-outs, human takeover
  api.py             endpoints for the app UI
  main.py            the server and the five-minute timer
scripts/
  import_leads.py    bulk load
```

## Endpoints

| | |
|---|---|
| `GET /health` | is it alive and is the database answering |
| `GET /api/status` | counts, limits, what is still unconfigured |
| `GET /api/leads?q=&city=&category=` | search |
| `GET /api/leads/{phone}` | one lead and its conversation |
| `POST /api/audience/count` | how many leads a filter would reach |
| `GET /api/campaigns` | list |
| `POST /api/campaigns` | create one, as a draft |
| `POST /api/campaigns/{id}/start\|pause\|resume` | control it |
| `GET /api/settings` | the business rules |
| `POST /wh/{secret}` | where WhatsApp delivers messages |

Interactive docs while it runs: <http://localhost:8000/docs>

## Keep these out of screenshots

`.env`, and the webhook URL with the secret in it. Anyone who has the webhook
secret can feed messages to the bot; anyone with the BlueTick token can send
WhatsApp messages as Amitek. `.env` is gitignored — keep it that way.
