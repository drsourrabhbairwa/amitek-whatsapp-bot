# Setup: Amitek WhatsApp bot on Google Sheets

Everything runs inside one Google Sheet. No server, no hosting bill. About 20 minutes.

You need:
- The sheet file `Amitek_Lead_Bot.xlsx` (shared privately, it is not in this public repo)
- A Claude API key from https://console.anthropic.com (Settings > API keys)
- From BlueTick > API Details: the access token and the Phone Number ID
- The salesperson's WhatsApp number

Never paste keys or tokens into chat, email, or this repo. They go only into Script Properties (step 3).

## 1. Put the sheet in Google Drive
1. Upload `Amitek_Lead_Bot.xlsx` to Google Drive.
2. Open it, then **File > Save as Google Sheets**. Work in this new Google Sheets copy from now on.
3. You can delete the uploaded .xlsx from Drive.

## 2. Add the script
1. In the sheet: **Extensions > Apps Script**.
2. Delete what is in `Code.gs` and paste the whole of [`Code.gs`](Code.gs) from this folder. Save (Ctrl+S).
3. Click **Project Settings** (gear icon), tick **Show "appsscript.json" manifest file in editor**, go back to the editor,
   open `appsscript.json` and replace it with [`appsscript.json`](appsscript.json). Save.

## 3. Add the secrets
**Project Settings > Script Properties > Add script property**, one row each:

| Property | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your Claude API key |
| `WA_ACCESS_TOKEN` | BlueTick access token |
| `WA_PHONE_NUMBER_ID` | BlueTick Phone Number ID |

Save. (`WEBHOOK_SECRET` is created for you in the next step.)

## 4. Run setup once
1. In the editor, pick `setup` in the function dropdown and click **Run**.
2. Google asks for permission: **Review permissions**, choose your account, **Advanced > Go to project (unsafe) > Allow**.
   ("Unsafe" only means Google has not reviewed your own private script.)
3. This creates the hourly check, the 9 AM summary, and a `WEBHOOK_SECRET` in Script Properties.

## 5. Fill in Settings
In the sheet's **Settings** tab:
- `SALES_WHATSAPP`: salesperson number with 91, e.g. `919812345678`
- Leave `SEND_ENABLED` as `false` for now (test mode).
- Check `WA_API_URL` and `WA_API_VERSION` match BlueTick > API Details.

## 6. Test without WhatsApp
In the editor, run `testMessage`. Open the **Messages** tab: you should see a test customer message and the bot's
reply. Nothing is sent while `SEND_ENABLED` is `false`. If it fails, the error shows in **Executions**.

## 7. Publish the webhook
1. **Deploy > New deployment**, type **Web app**.
   Execute as: **Me**. Who has access: **Anyone**. Click **Deploy** and copy the Web app URL
   (`https://script.google.com/macros/s/.../exec`).
2. Your webhook URL is that URL plus `?key=` plus the `WEBHOOK_SECRET` from Script Properties:
   `https://script.google.com/macros/s/XXXX/exec?key=YOUR_WEBHOOK_SECRET`
3. In BlueTick > **Webhooks > Add Webhook**: paste the URL, tick **Incoming Messages** and **Outgoing Messages**, save.

## 8. Try it with your own phone
1. From your personal WhatsApp, message the Amitek business number.
2. Check the sheet: **Webhook Log** shows the raw message, **Messages** shows the reply the bot would send,
   **Leads** gets your row.
3. When the replies look right, set `SEND_ENABLED` to `true`. Message again; now the bot replies on WhatsApp.

## Everyday use
- **Leads** tab is the lead list. **Board** tab shows engaged leads, hot and overdue first (refreshed hourly).
- **Log** tab records every status / follow-up change and who made it.
- The salesperson gets WhatsApp alerts for hot leads, unanswered chats and due follow-ups, plus a 9 AM summary,
  and can reply with:
  - `DONE 98xxxxxxxx note` - I contacted them (next check in 3 days)
  - `LATER 98xxxxxxxx 5 note` - follow up in 5 days
  - `WON 98xxxxxxxx note` / `LOST 98xxxxxxxx reason`
  - `LIST` - everything pending, `HELP` - this list
- When someone from the team replies to a customer from the business number, the bot stays quiet for 12 hours.
- STOP / not interested opts the customer out; START brings them back.
- **Knowledge** tab is what the bot knows. Edit it any time (add prices here later; it stays private in your sheet).

## Updating the code later
Paste the new `Code.gs`, save, then **Deploy > Manage deployments > Edit (pencil) > Version: New version > Deploy**.
This keeps the same webhook URL.
