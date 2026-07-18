# WhatsApp Group Moderation Bot

Welcome messages, link/banned-word filtering, warnings, and auto-kick — built with Baileys (no Chromium needed, fits ModVC's free tier).

## Setup

1. Edit `config.js`:
   - `BANNED_WORDS` — your list
   - `MAX_WARNINGS` — how many strikes before removal
   - Message templates

2. **The bot account must be a group admin** to delete others' messages and remove members.

## Run locally (optional, for testing)

```
npm install
npm start
```

Scan the QR code printed in the terminal with WhatsApp → Linked Devices.

## Deploy on ModVC

1. Push this folder to your GitHub repo.
2. In ModVC panel: pull/upload the repo, select Node.js 18 runtime.
3. Start the app — dependencies auto-install via `npm install` (package.json is already set up).
4. Open the **live console** — it will print a QR code as ASCII art.
5. On your phone: WhatsApp → Settings → Linked Devices → Link a Device → scan the QR shown in the console.
6. Once connected, the console prints "✅ Bot connected to WhatsApp." Session credentials are saved to the `auth_info/` folder so you won't need to re-scan on restart (as long as that folder persists between deploys — check ModVC's storage persistence for your tier).

## Notes

- `warnings.json` and `auth_info/` are created automatically at runtime — don't delete them unless you want to reset warnings/session.
- If ModVC's free 128MB tier struggles, Baileys itself is lightweight; growth in RAM usage is usually from many concurrent groups/messages, not the library itself.
