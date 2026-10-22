# Lead autopilot — the PC side

Put an Excel or CSV file of leads into one folder. Everything after that happens on its own.

```
  Excel/CSV in the inbox folder   (you)
            |
       this PC watcher            sends the leads to the bot, retries if the net is down
            |
        the bot (cloud)           files each lead into a category with the AI
            |
     welcome campaign             greets them with the approved template
            |
     customer replies             the bot answers, the team gets an alert
     customer stays quiet         follow-ups go out on the days you set
```

The PC only hands over the leads. The part that must never sleep — answering customers, campaigns,
alerts, follow-ups — stays in Google Apps Script, so it keeps working when this PC is off.

## Setup (once)

1. Install Python from <https://www.python.org/downloads/>, ticking **Add python.exe to PATH**.
2. Double-click **install_windows.bat** and answer three questions:
   - the bot's web app link (the one ending in `/exec`, from the app's Settings screen)
   - the app PIN
   - which folder to watch (Enter = the `inbox` folder next to these files)
3. That's it. It starts now and at every login from then on.

After a power cut or a restart it starts again by itself. A file that did not go through stays in the
inbox and is tried again until it does.

## Turning on the hands-free part of the bot

In the bot's Sheet, **Settings** tab:

| Setting | Value | What it does |
|---|---|---|
| `AUTOPILOT` | `true` | every hour the AI files new leads into categories, so nobody has to tap Approve |
| `FOLLOWUP_STEPS` | e.g. `3:tpl_a, 8:tpl_b` | days and the approved template for people who never replied (blank = off) |
| `CAMPAIGN_DAILY_LIMIT` | e.g. `250` | the most messages a day, whatever else is set |
| `CAMPAIGN_HOURS` | `9-20` | nobody is messaged at night |

Then in the app, **Send → New campaign**, tick **"Welcome message: keep running and greet every new
lead you add later"**, and Start it. Every lead that arrives from then on is greeted on its own.
Your existing list is not touched by it.

## The inbox folder

| Folder | What is in it |
|---|---|
| `inbox` | drop your files here (`.xlsx`, `.xlsm`, `.csv`) |
| `inbox\done` | imported successfully |
| `inbox\problem` | could not be read (no phone column, empty file) |

Headings can be on any of the first 10 lines, in any order. Recognised: **Phone** (or Mobile, Number,
Contact, WhatsApp), Name, Business (Firm, Company, Shop), Category, City, State.

Numbers are tidied up automatically: `9876543210`, `+91 98765 43210` and `09876543210` all become the
same lead. Landlines, short numbers and repeats within the file are left out. Leads the bot already
has are counted as "already known" and not messaged again.

`autopilot.log` in this folder says what happened and when.

## Things worth knowing

- **Only message people who agreed to hear from you.** Numbers collected from the web are not that,
  and sending to them risks the WhatsApp number being blocked.
- A **bulk campaign that is running holds imports back**, on purpose, so a freshly imported list is
  never blasted by surprise. Pause it, import, then resume. An always-on welcome campaign does not
  hold imports back, because greeting new leads is exactly its job.
- The daily limit and the sending hours apply to everything, including follow-ups.
- Anyone who replies **STOP** is out of all of it, for good.

## If something is not working

| What you see | What to do |
|---|---|
| `Set up config.json first` | run `install_windows.bat` again |
| `could not reach the bot` | the PC has no internet, or the web app link is wrong. Files wait and are retried |
| `Wrong PIN` | fix `pin` in `config.json` |
| `A campaign is running` | pause the bulk campaign in the app's Send screen |
| nothing is being greeted | check `AUTOPILOT` is `true`, "Send on WhatsApp" is on, and a welcome campaign is Running |
