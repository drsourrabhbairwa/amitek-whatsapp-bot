# Amitek WhatsApp Sales Agent

An AI sales head on Amitek's WhatsApp number (+91 89058 34151, via BlueTick). It replies to leads in English,
Hindi or Hinglish, qualifies them (Discover > Diagnose > Recommend > Quote > Close), keeps the lead sheet updated,
and hands hot leads to a salesperson on WhatsApp.

## How it works

```
Customer WhatsApp ──> BlueTick ──(Webhook: Incoming + Outgoing Messages)──> this server /webhook/<secret>
                                                                              │
                                    Claude (playbook + knowledge/*.md) <──────┤ update lead, hand off, opt out
                                                                              │
Customer WhatsApp <── BlueTick API (crmapi.bluetickapi.com/api/meta) <────────┘ reply
Salesperson WhatsApp <── hot-lead alert
```

- **Knowledge** the bot may use lives in `knowledge/*.md`. Add the catalog and price lists there; the bot never
  quotes a price that is not written in `03_pricing.md`.
- **STOP / Not interested**: opted out, never messaged again (until they write START).
- **Call me**: instant hand-off to sales.
- **Human takeover**: when someone on the team replies from BlueTick Live Chat, the bot stays quiet for
  `HUMAN_TAKEOVER_HOURS` (default 12) for that customer.
- **Phase 1 = gentle mode** (`BOT_MODE=gentle`, default): short, polite replies, no selling. The bot only finds out
  who they are, what work and which city, then hands over to the team. Set `BOT_MODE=sales` later for the full
  sales-head flow.
- **Lead tracking (nothing goes off road)**:
  - every handed-over lead gets an owner, a follow-up time and an audit log of every status change;
  - hourly check alerts the salesperson on WhatsApp about: customers waiting for a reply (30 min), hot leads not
    contacted within `HOT_LEAD_SLA_HOURS` (repeats up to 3 times), follow-ups that are due; leads silent 3+ days
    automatically get a follow-up date;
  - 9:00 AM IST daily summary: hot, overdue, due today;
  - the salesperson updates leads by WhatsApp: `DONE 98xxxxxxxx note`, `LATER 98xxxxxxxx 5 note`,
    `WON 98xxxxxxxx`, `LOST 98xxxxxxxx reason`, `LIST`, `HELP`;
  - lead board page: `GET /board/<WEBHOOK_SECRET>` (hot, overdue, waiting reply first).
- **Safety switch**: `SEND_ENABLED=false` (default) means the bot thinks and logs but sends nothing.
- Lead sheet download: `GET /leads.csv/<WEBHOOK_SECRET>`.

## Run tests

```
pip install -r requirements.txt
pytest -q
```

Tests use a fake Claude and a fake WhatsApp API; nothing is sent.

## Deploy (Render, ~US$16/month: web service Starter + Postgres basic + 2 small cron jobs)

1. Push this folder to a **private** GitHub repo.
2. Render > New > Blueprint > pick the repo (uses `render.yaml`). Fill the secret env vars:
   `ANTHROPIC_API_KEY`, `WA_ACCESS_TOKEN` (fresh BlueTick API token), `SALES_WHATSAPP` (e.g. 9198xxxxxxxx).
3. Load leads: Render shell > `python -m scripts.import_leads Amitek_Lead_Sheet.xlsx` (upload the file first).
4. BlueTick > Channel > Webhooks > Add Webhook:
   URL `https://<render-app>.onrender.com/webhook/<WEBHOOK_SECRET>`, tick **Incoming Messages** and
   **Outgoing Messages** (others optional).
5. Dry run: keep `SEND_ENABLED=false`, message the number from your own phone, check Render logs.
6. Set `APP_URL` on the two cron jobs to the web service URL.
7. Go live: set `SEND_ENABLED=true`, test again from your own phone, then send the campaign from BlueTick.

The salesperson alert is a free-text message, which WhatsApp only delivers if the salesperson messaged the business
number in the last 24 hours. For reliable alerts, create a Utility template (body with 3 variables: name, phone,
summary), get it approved, and set `SALES_ALERT_TEMPLATE` to its name.
