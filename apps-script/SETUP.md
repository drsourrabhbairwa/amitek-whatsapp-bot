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
