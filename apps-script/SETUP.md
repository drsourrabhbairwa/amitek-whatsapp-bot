# Setup: Amitek WhatsApp bot (Google Sheet + Android app)

You need two files, both on the [latest release](https://github.com/drsourrabhbairwa/amitek-whatsapp-bot/releases/latest):
- `Amitek_Bot.gs`: the whole bot in one file
- `Amitek-Leads.apk`: the Android app

And your keys: a Claude API key (console.anthropic.com > API keys), or for free testing a Google Gemini key
(aistudio.google.com > Get API key), Groq key (console.groq.com) or OpenRouter key (openrouter.ai); and from BlueTick > Bulk Campaign >
Create API Campaign > API Details: the access token and the Phone Number ID. Never paste keys into chat or email;
they go only into the app's Setup screen.

## 1. The sheet (2 minutes)
1. Upload `Amitek_Lead_Bot.xlsx` (your leads) to Google Drive, open it, then **File > Save as Google Sheets**.
   (No lead file? Any new blank Google Sheet works; the tabs are created for you.)
2. In that Google Sheet: **Extensions > Apps Script**.
3. Delete everything in `Code.gs`, paste the whole of `Amitek_Bot.gs`, and click **Save**.

## 2. Publish it (2 minutes)
1. **Deploy > New deployment**. Click the gear next to "Select type" and pick **Web app**.
2. Execute as: **Me**. Who has access: **Anyone**. Click **Deploy**.
3. Google asks for permission: **Authorize access**, pick your account, **Advanced > Go to project (unsafe) > Allow**.
   ("Unsafe" only means Google has not reviewed your own private script.)
4. Copy the **Web app URL** (it ends with `/exec`).

## 3. The app (1 minute)
1. Install `Amitek-Leads.apk` on your Android phone (allow "Install unknown apps" when asked).
2. Open it, paste the Web app URL, and choose a PIN for your team. The app sets up the sheet tabs and timers.
3. On the **Setup** screen: pick the AI (Claude, or Gemini / Groq / OpenRouter for free testing), paste its key, BlueTick token and Phone Number ID, tap **Save keys**,
   add the salesperson's WhatsApp number, then tap **Test AI** and **Test WhatsApp**.
4. Tap **Copy webhook link**. In BlueTick > **Webhooks > Add Webhook**, paste it, tick **Incoming Messages**
   and **Outgoing Messages**, and save.
5. Send "hi" to your business number from your own phone. The Setup screen shows ✓ when messages arrive.
6. The bot starts in test mode (replies are written to the sheet, not sent). When the replies look right,
   turn on **Send on WhatsApp** in Settings.

### If BlueTick says "failed to verify channel"
Google's link answers with a redirect, which BlueTick's check does not accept. Put a free relay in between (5 minutes):
1. Sign up free at **dash.cloudflare.com** (no card needed).
2. **Workers & Pages > Create > Create Worker**, name it `amitek-relay`, click **Deploy**.
3. Click **Edit code**, delete everything, paste the whole of `worker.js` (from the release), click **Deploy**.
4. Copy the worker link (like `https://amitek-relay.yourname.workers.dev`).
5. In the app: **Settings > Setup > BlueTick says "failed to verify"?**, paste the worker link, tap **Save relay link**.
6. Tap **Copy webhook link** again and paste this new link in BlueTick.

Other team members install the same APK and enter the same link and PIN.
No Android phone? Open the Web app URL in any browser; it is the same app.

## Messaging all your leads (Send tab)
WhatsApp only lets a business write first with a **template approved by Meta**.
1. In BlueTick > **Templates > Create**, category **Marketing**, write the message (use `{{1}}` for the name if you like) and submit. Wait for **Approved**.
2. In the app, **Send > New campaign**: type the template name exactly, pick the language, choose who gets it (category, state, cities, max), Save.
3. Tap **Test to me**, check the message on the salesperson phone, then **Start**.
   Messages go out 40 every 5 minutes, at most 250 a day (change it to match your Meta limit). People who said STOP, won/lost leads,
   "Can Message = No" leads and anyone who already got it are always skipped. When someone replies, the bot answers them.
4. **Welcome message**: tick "keep running and greet every new lead" on a campaign and start it. Every lead you add in the app
   from then on gets that template right away. Your existing list is not messaged by it.

## Pitch by category, and telling the bot who to message
- **Settings > Pitch by category**: for each type of lead (applicator, end client, builder, architect, contractor, dealer) set the approved BlueTick template its first message uses and what the bot offers them in the chat (applicators: third-party manufacturing; end clients: our products; builders and architects: waterproofing, seamless flooring, home automation, CCTV and other solutions). The defaults are ready; edit the text freely.
- **Send tab > "Tell the bot"** (or WhatsApp the bot from the main salesperson number): write who and when, for example `applicators ko monday 11 baje message bhejo` or `builders aur architects jaipur kal 4 baje`. The bot shows the plan (leads per category, template, time); reply YES to confirm or NO to cancel. Nothing is sent before YES. `CAMPAIGNS` shows what is running or scheduled.
- Scheduled campaigns start by themselves at the time (checked every 5 minutes). Times are India time; no time means 10 AM; `abhi` means now.
- **How the bot talks:** like a person from your team. It reacts to what the lead said, asks at most one question, never repeats a question it already asked (a guard rewrites the reply if it tries), knows what the template said (paste it in Settings > Pitch by category, "What the first message says"), and as soon as a lead shows interest (haan, details bhejo, rate, call) it stops asking and passes the lead to you with a hot alert.
- **One template is enough to start:** every category defaults to the common opener `amitek_intro` (Hindi `hi`; make an English `en` copy if you like). After the lead replies, the bot brings up the offer for that lead's category. You can still give a category its own template in Settings > Pitch by category.
- **No template at all:** the Send tab has "Let leads message you first": a WhatsApp link and QR per category (needs your business number in Settings). When a lead writes first, the bot can reply freely.
- **Sort leads (Learn tab):** the bot reads names and business types of leads with no clear category and suggests one; you approve. Campaigns can also pick each lead's template by category ("Pick the template by category").
- Template texts to copy into BlueTick: `campaigns/category_templates.md` in the project files.

## Team on Telegram (employees only)

Employees can use a private Telegram bot instead of the app: add leads, get lead alerts, look up a lead, reply to a lead on
WhatsApp from the company number, and (if you tick it) plan campaigns. The bot also explains itself: /start shows the guide,
and any question in Hindi or English gets an answer from the guide.

1. The relay link must be set (Setup screen), because Telegram, like BlueTick, needs a plain answer.
2. In Telegram open **@BotFather**, send `/newbot`, choose a name. Copy the token it gives you.
3. App > Settings > Telegram (team): paste the token, tap **Connect**. Share the t.me link with employees.
4. Each employee opens the link and presses Start. You get a WhatsApp message; tap **Allow** for company people only.
   Tick "Can send WhatsApp campaigns" only for people who may message all leads (they still have to reply YES).

How employees give leads: one per line, `name, mobile, category, city, note`, or a CSV file
(columns like Name, Phone, Category, City). Excel: save as CSV first. New leads wait for the next campaign;
existing numbers are left as they are. Groups are ignored, strangers get no data.

## Campaigns the team answers (bot stays quiet)

- In the app's campaign form tick **Team replies, bot stays quiet**, or say it in the plan: "dealers ko message bhejo, bot reply mat karna".
- Bulk messages an employee sends from BlueTick with a template: the bot stays quiet for those leads too (turn on the
  "Outgoing Messages" event in BlueTick's webhook so the bot sees them). Setting TEAM_TEMPLATES_QUIET=false turns this off.
- Every reply from such a lead comes to the team as an alert (WhatsApp and Telegram). STOP still works.
  To let the bot talk to one lead again: open the lead in the app and resume the bot.
- To stop the bot for everyone: Settings > "Bot replies automatically" off.

## Teaching the bot (Learn tab)
- **Teach the bot**: paste (or pick a text/CSV file) your company profile, product list, price list or an old campaign export.
  "Let AI learn from it" pulls out the useful points; "Save as it is" adds the whole text.
- **Learn from chats**: the AI reads recent chats and campaign results and suggests what the bot should know. It also does this every Monday.
- Nothing is used until you tap **Teach the bot** on it, so the bot never learns a wrong price by itself. Edit or delete anything under "What the bot knows".

## What the app does
- **Today**: hot leads, overdue follow-ups, customers waiting for a reply, what's coming up.
- **Lead**: the WhatsApp chat, Call and WhatsApp buttons, Done / Later / Won / Lost, edit details,
  change history, and a reply box to answer as the team (the bot then stays quiet for that customer for 12 hours).
  WhatsApp allows typed replies only within 24 hours of the customer's last message.
- **Leads**: search by name, number or city, filter by status. **Add**: add a walk-in or phone lead.
- **Team by category** (Settings): give a WhatsApp number per lead category (Applicator, Dealer, …). That person gets alerts, the 9 AM summary and LIST for those leads only; the main salesperson still gets everything.
- **Send**: campaigns and welcome messages. **Learn**: what the bot knows and what it learned.
- **Settings**: setup checklist and keys, test mode, bot on/off, gentle or sales mode, salesperson number, PIN.

The salesperson also gets WhatsApp alerts (hot leads, unanswered chats, due follow-ups, 9 AM summary) and can
reply to them with `DONE 98xxxxxxxx`, `LATER 98xxxxxxxx 5`, `WON ...`, `LOST ... reason`, `LIST`, `HELP`.

The Google Sheet is the database: **Leads**, **Messages**, **Log** (every change and who made it), **Board**,
**Knowledge** (what the bot knows; edit it any time) and **Settings**.

## Updating later
- New script: paste the new `Amitek_Bot.gs`, save, then **Deploy > Manage deployments > Edit (pencil) >
  Version: New version > Deploy**. The link stays the same.
- New app: uninstall the old app first, then install the new APK, and enter the link and PIN again.
  Nothing is lost; all data lives in the sheet.

## Safety
- After 10 wrong PINs the app locks for an hour. Change the PIN in Settings if someone leaves the team.
- Keys are stored in the script's private Script Properties. The app can replace them but never shows them.
- STOP / not interested opts a customer out; the bot never messages them again unless they write START.

## For developers
Source files are `Code.gs`, `App.gs` and `App.html`; `node apps-script/build.js` makes `dist/Amitek_Bot.gs`.
Tests: `node apps-script/test/test.js` (and `DIST=1` for the built file). The Android app is in `android/`
and is built by GitHub Actions on every push.
