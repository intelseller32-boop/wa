# WhatsApp Group Moderation Bot - Multi-Account Dashboard

Add and manage multiple WhatsApp accounts from a web dashboard. Each account can be linked via QR code or phone-number pairing code, chosen right on the site. Sessions, settings, and warning counts are all stored in your MySQL database, so nothing is lost on redeploy/restart.

## Railway Environment Variables

Set these in your Railway service -> Variables tab:

| Variable | Required? | Example | Purpose |
|---|---|---|---|
| DATABASE_URL | Strongly recommended | mysql://user:pass@host:port/dbname | Persists accounts, sessions, settings, warnings. Without it, everything works but resets on every restart. |
| ADMIN_PASSWORD | Required to open the dashboard | any strong password | The whole dashboard (including QR/pairing codes) is locked behind this. |
| ADMIN_USERNAME | Optional | admin (default) | Dashboard login username. |
| PORT | Auto-set by Railway | - | Do not set manually. |

Note: paste your MySQL connection string directly into Railway's Variables tab -- never share it in chat or commit it to GitHub. You do NOT need a PHONE_NUMBER variable anymore -- phone numbers are entered per-account on the dashboard itself.

## After deploying

1. Railway -> Settings -> Networking -> Generate Domain (needed to reach the dashboard)
2. Visit https://your-domain.up.railway.app/ -- log in with ADMIN_USERNAME / ADMIN_PASSWORD
3. Fill in the "Add WhatsApp Account" form:
   - Give it a label (e.g. "Main group")
   - Choose "Scan QR code" or "Enter phone number (pairing code)"
   - If pairing code, type the number with country code, no + or spaces (e.g. 2348121697423)
4. You're taken to that account's page, which shows the QR image or pairing code (auto-refreshing) until it connects
5. Once connected, the account page lists every group that WhatsApp account belongs to
6. Click "Edit settings for this group" on any group to customize its welcome/warning/kick messages and banned words, OR click "Edit default settings" to set values that apply to every group on that account unless a group has its own override

## Adding more accounts

Go back to the dashboard root (/), fill the "Add WhatsApp Account" form again. Each account runs independently with its own session, groups, and settings.

## Bot must be group admin

Each linked WhatsApp account must be an admin in a group for the bot to delete others' messages and remove members there.

## Local testing (optional)

npm install
npm start

Then open http://localhost:3000

## Notes

- Message templates support {user}, {count}, {max} placeholders where relevant.
- Without DATABASE_URL, the dashboard still works, but every account, session, setting, and warning count is wiped on restart -- add the database as soon as you can.
- No Railway volume is needed anymore -- WhatsApp sessions now live in the database, not on disk.
