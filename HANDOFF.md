# Handoff — Amitek AI Sales Employee (service edition)

Written 28 Oct 2026 for the next Claude Code session. Read this first, then `service/README.md`.

**Who:** Sourrabh Bairwa, an employee at Amitek (Jaipur), not the owner. Writes English/Hinglish — **reply to him in Hinglish**,
short and one step at a time. He gets overwhelmed by long instruction lists.
**Standing preference:** do everything yourself that you can; tell him only the steps that genuinely need a human
(his passwords, API keys, approvals, clicking a button in a web UI you cannot reach).

## What this is

A WhatsApp lead bot for Amitek (BlueTick on top of Meta Cloud API, Claude for replies). The old version ran on Google
Apps Script + a Google Sheet (`apps-script/`, still live) and was too slow (34k leads, 6-minute limits, imports that never
finished). The new version is `service/`: **FastAPI + Supabase Postgres**, running on his Windows PC first, a rented
server (~₹500/month, Mumbai/Bangalore) later. Same `.env`, same folder, no code change when it moves.

Branch: `claude/signup-fix` (HEAD `00d6d15` plus this file). **Not merged to `main`.** This repo is **public** — never commit
`.env`, lead CSVs, tokens, the webhook secret, or the tunnel address (`.gitignore` already blocks `.env*`, `*.csv`, `*.xlsx`).

## Where things are right now

| Piece | State |
|---|---|
| Supabase project `amitek-sales-employee` (ap-south-1) | Live. 34,879 leads imported, ~99.6% categorised. Indexed (composite + lower() expression indexes). |
| Service on his PC, `D:\Lead Data\Amitek-Bot\` | Runs; `/health`, `/api/status` OK, DB connected. **Probably not running now** — the newest log file on the PC is from 23 Oct. |
| Campaign id 1 "Rajasthan - welcome" | **Draft**. Template `amitek_welcome` (Marketing, English), var `{Name}`, 3,691 leads, never started. |
| `SEND_ENABLED` | `false` (dry-run: replies are computed and stored, nothing is sent). Keep it false until he agrees. |
| BlueTick webhook | **NOT verified.** "Failed to verify channel". See task 1. |
| Public address for the PC | Cloudflare quick tunnel, changes on every restart. The one from 23 Oct is certainly dead. |
| Old Apps Script bot | Still deployed. Check what BlueTick's webhook currently points to before changing it — switching it moves inbound replies away from the old bot. |

Secrets live only in `D:\Lead Data\Amitek-Bot\.env` on his PC (DATABASE_URL, WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN,
WEBHOOK_SECRET, ANTHROPIC_API_KEY). You can read it if you are on the PC; do not paste values into chat, logs, or commits.

## Pending tasks, in order

### 1. Make BlueTick verify the webhook (blocking — replies cannot arrive without it)
Webhook URL shape: `https://<tunnel-host>/wh/<WEBHOOK_SECRET>`. `GET /wh/{secret}` echoes `hub.challenge` (or `challenge`)
as plain text and logs `verification GET: {params}`. I tested it by hand with numeric and alphanumeric challenges through the
tunnel and it worked, yet BlueTick still fails — **cause unknown**. I could not find BlueTick-specific webhook docs; only generic Meta docs.
The new `start.bat` (writes `bot_log.txt`) was never re-run, so we have never seen what BlueTick actually sends.

Plan:
1. Start the bot (`start.bat`) and a fresh tunnel (`tunnel.bat`, writes `tunnel_log.txt`; the new `*.trycloudflare.com` host is in it).
   If you are running on the PC you can do this directly with a real shell — the .bat/log relay existed only because the previous session had no shell on the PC.
2. He pastes the new URL into BlueTick → Webhooks and clicks Verify (human step; ask him to say "done").
3. Read `bot_log.txt`. Either a `verification GET` line shows what BlueTick sent, or nothing arrives (then it is a reachability/URL problem: wrong host, tunnel down, secret typo, BlueTick wanting a different path or a verify-token field).
4. Fix `service/app/webhook.py` to match. Consider a catch-all that logs method, path, headers (not auth) and body of any request, so the next unknown costs minutes not hours.

### 2. Confirm inbound payload shape, then test a real reply
`_extract()` in `webhook.py` only understands Meta's `entry[].changes[].value.messages[]` and **ignores every non-text message**
(images, voice, buttons, location). It also does not process delivery-status callbacks (sent/delivered/read/failed). BlueTick may post a
different JSON shape. After verification works: he sends "hello" from his phone to the Amitek number, check the row in `messages` (Supabase) and that
a reply was *computed* (not sent — `SEND_ENABLED=false`). If nothing is extracted, log the raw body and adapt `_extract`.
Worth adding after that: handle button replies, store delivery statuses, keep a raw-webhook log table for debugging.

### 3. Answer his question: "what message do you reply when a customer replies to the bulk message?"
He asked this in the old Apps Script app's assistant box (screenshot, 23 Oct) and got back the campaign wizard prompt
("Which leads? Name a category…") — that old assistant routed a plain question into its campaign flow. Two things to do:
- **Answer in the new service:** there is no fixed reply text. `ai.reply_to()` sends the last 16 messages to Claude with `PERSONA` (Sir/Ma'am, 2–3 short WhatsApp lines, reply in the customer's language,
  never invent prices/warranty/delivery, hand off to a human when they want to buy) + `OWNER_RULES` setting + the `knowledge` table + the lead's category/city/state/business.
  Only fixed text: opt-out confirmation (`GOODBYE` in `webhook.py`) when the whole message is a stop phrase. Humans take over: if a team member replied in the last 12 h (`HUMAN_TAKEOVER_HOURS`) the bot stays quiet.
  I have not re-read the Apps Script reply logic; do not claim it matches.
- **Decide with him** whether to fix the old assistant's routing or retire that UI. The Android app / `apps-script/App.html` still talks to Apps Script; **the new service has an API (`service/app/api.py`) but no UI yet.** Building one on that API is the real next product step.

### 4. Go live with sending (needs his explicit yes, one step at a time)
After tasks 1–2 and he has read a handful of computed replies and likes them:
1. He sets `SEND_ENABLED=true` in `.env` (human step — `.env` is not writable remotely) and restarts the bot.
2. Start campaign id 1 (`POST /api/campaigns/1/start`). Guards already in code: sending hours 9–20 IST, `DAILY_LIMIT` 250 per rolling 24 h, one send per lead per campaign, auto-pause on template refusal or 5 failures in a row, STOP detection on whole-message match.
3. Watch the first batch of 40 (`campaign_log`, `/api/status`). Do not raise the limit before the first day looks clean.
He does **not** want new templates created ("hum abhi koi naya template nahi banane wale"); use only approved ones.

### 5. Stable hosting
Quick tunnels are for testing only: the address changes on every restart and the PC must be on. Options: ~₹500/mo VPS (preferred, also hosts his other tools — see his server-hosting notes), a Cloudflare *named* tunnel (needs a domain), or Render (`render.yaml` exists from the older edition; free tier sleeps, so not for webhooks).
Moving = copy folder, new `.env`, start. Then update the BlueTick webhook once.

### 6. Housekeeping / loose ends
- Merge `claude/signup-fix` into `main` when he approves.
- **Rotate secrets** before real traffic: the webhook secret appeared in chat/screenshots; the tail of the DB password leaked once into a log line (old masking bug, fixed) and was disclosed to him; a reset was offered but not taken. Reset the Supabase DB password, update `DATABASE_URL` (`@` in a password must be written `%40`), and pick a new `WEBHOOK_SECRET`.
- Old Apps Script campaigns that are Paused use templates `amitek_intro (hi)` / `amitek_applicator (hi)` which **no longer exist** — never Resume them.
- Team-alert template `team lead alert` was still PENDING. Team alerts go over WhatsApp only, 9–20 IST, urgent exceptions allowed.
- The Apps Script "Jaipur Applicator 50" campaign was running; its completion and any replies were never confirmed.
- A `touch_updated_at` trigger migration timed out twice and was **not applied**; `leads.updated_at` is not auto-maintained by a trigger. Not required for the above.
- Python 3.14 on his PC: close the DB pool before exit (already done in `scripts/check_db.py` and app lifespan) or you get `PythonFinalizationError`.

## Gotchas learned the hard way

- Windows: use `127.0.0.1`, not `localhost` (IPv6 `::1` is tried first; bot listens on IPv4). Tunnel target is `http://127.0.0.1:8000`.
- `DATABASE_URL`: Supabase **Transaction pooler**, port 6543. URL-encode special characters in the password. `check.bat` / `scripts/check_db.py` diagnose this and mask the password.
- Timezone env var must be `BOT_TZ` (a plain `TZ` collided with Windows); `tzdata` is in requirements because Windows has no tz database.
- `/api/status` is deliberately non-failing — start any debugging there.
- Opt-out regex matches the **whole message** ("stop" yes, "stop by tomorrow" no). Keep it that way.
- The audience query needs `^91[6-9][0-9]{9}$` mobiles, not opted out / Won / Lost, not team numbers. Only 3,691 Rajasthan leads qualify as "never messaged".
- Webhook secret is the URL path itself; treat the full URL as a credential.
- If you write files to his PC remotely, **verify the size afterwards** — a write once reported success while the file was unchanged.

## Files

```
service/app/    config, db, settings_store, leads, campaigns, ai, whatsapp, webhook, api, main
service/scripts import_leads.py (bulk CSV, raw export columns), check_db.py
service/*.bat   setup_windows / start / import / check (+ tunnel.bat, setup_fix.bat, import_all.bat on the PC only)
service/.env.example
apps-script/    the old live bot (do not delete until the new one is verified end to end)
```
No automated tests exist for `service/` yet (top-level `tests/test_bot.py` belongs to the older Python edition). I tested by hand: opt-out phrases, challenge echo,
audience counts, status page with a broken DB. Adding tests for `webhook._extract`, `STOP_WORDS`, `leads.audience` and `campaigns` safeguards is worthwhile before going live.

## Paste this into Claude Code to start

> Read HANDOFF.md in this folder, then service/README.md. Work on task 1: get the BlueTick webhook verified. Start the bot and a fresh
> Cloudflare tunnel yourself, tell me the exact webhook URL to paste into BlueTick (don't paste secrets anywhere else), wait for me to say "done",
> then read the bot log and fix webhook.py to match what BlueTick really sends. Reply to me in Hinglish, one step at a time. SEND_ENABLED must stay false.
