// Baileys needs globalThis.crypto (Web Crypto API), which is only a native
// Node.js global since Node 19. Polyfill it for older Node versions (e.g. Node 18).
if (typeof globalThis.crypto === "undefined") {
  globalThis.crypto = require("node:crypto").webcrypto;
}

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");
const P = require("pino");
const qrcode = require("qrcode-terminal");
const {
  MAX_WARNINGS,
  BANNED_WORDS,
  LINK_REGEX,
  WELCOME_MESSAGE,
  WARNING_MESSAGE,
  KICK_MESSAGE,
  AUTH_FOLDER
} = require("./config");
const warningStore = require("./warningStore");

const logger = P({ level: "silent" }); // set to "info" if you want verbose logs

function containsBannedWord(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return BANNED_WORDS.some((w) => lower.includes(w.toLowerCase()));
}

function containsLink(text) {
  if (!text) return false;
  return LINK_REGEX.test(text);
}

function fillTemplate(template, { user, count, max }) {
  return template
    .replace("{user}", user ? `@${user.split("@")[0]}` : "")
    .replace("{count}", count ?? "")
    .replace("{max}", max ?? "");
}

let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false // we handle QR manually below for clearer output
  });

  sock.ev.on("creds.update", saveCreds);

  // Connection lifecycle: shows QR code, handles reconnects with backoff + a hard stop
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("Scan this QR code with WhatsApp (Linked Devices):");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMsg = lastDisconnect?.error?.message || "unknown error";

      const fatalReasons = [
        DisconnectReason.loggedOut,
        DisconnectReason.badSession,
        DisconnectReason.connectionReplaced,
        DisconnectReason.multideviceMismatch
      ];

      if (fatalReasons.includes(statusCode)) {
        console.error(
          `Fatal disconnect (code ${statusCode}): ${errorMsg}. Not reconnecting - delete the auth_info folder/volume and redeploy to re-scan the QR code.`
        );
        return;
      }

      reconnectAttempts++;
      if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        console.error(
          `Gave up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts (last error: ${errorMsg}). Stopping to avoid a reconnect loop.`
        );
        return;
      }

      const delayMs = Math.min(30000, 2000 * 2 ** (reconnectAttempts - 1));
      console.log(
        `Connection closed (code ${statusCode}, ${errorMsg}). Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delayMs / 1000}s.`
      );
      setTimeout(startBot, delayMs);
    } else if (connection === "open") {
      console.log("Bot connected to WhatsApp.");
      reconnectAttempts = 0;
    }
  });

  // Welcome / goodbye on group membership changes
  sock.ev.on("group-participants.update", async (event) => {
    const { id: groupId, participants, action } = event;

    if (action === "add") {
      for (const userId of participants) {
        const text = fillTemplate(WELCOME_MESSAGE, { user: userId });
        await sock.sendMessage(groupId, {
          text,
          mentions: [userId]
        });
      }
    }
  });

  // Message moderation
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const groupId = msg.key.remoteJid;
      const isGroup = groupId?.endsWith("@g.us");
      if (!isGroup) continue; // only moderate group chats

      const senderId = msg.key.participant || msg.key.remoteJid;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "";

      const violatesLink = containsLink(text);
      const violatesWord = containsBannedWord(text);

      if (!violatesLink && !violatesWord) continue;

      // Delete the offending message
      try {
        await sock.sendMessage(groupId, {
          delete: {
            remoteJid: groupId,
            fromMe: false,
            id: msg.key.id,
            participant: senderId
          }
        });
      } catch (err) {
        console.error("Failed to delete message:", err.message);
      }

      // Increment warning count and notify
      const count = warningStore.increment(groupId, senderId);
      const warnText = fillTemplate(WARNING_MESSAGE, {
        user: senderId,
        count,
        max: MAX_WARNINGS
      });
      await sock.sendMessage(groupId, { text: warnText, mentions: [senderId] });

      // Kick if threshold reached
      if (count >= MAX_WARNINGS) {
        const kickText = fillTemplate(KICK_MESSAGE, {
          user: senderId,
          max: MAX_WARNINGS
        });
        await sock.sendMessage(groupId, { text: kickText, mentions: [senderId] });

        try {
          await sock.groupParticipantsUpdate(groupId, [senderId], "remove");
        } catch (err) {
          console.error("Failed to remove user (bot may not be admin):", err.message);
        }

        warningStore.reset(groupId, senderId);
      }
    }
  });
}

startBot().catch((err) => {
  console.error("Fatal error starting bot:", err);
  process.exit(1);
});
