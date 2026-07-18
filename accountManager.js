const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");
const crypto = require("crypto");
const P = require("pino");
const { useDBAuthState } = require("./dbAuthState");
const { getPool, isConfigured } = require("./db");
const settingsStore = require("./settingsStore");
const warningStore = require("./warningStore");
const { LINK_REGEX } = require("./config");

const logger = P({ level: "silent" });
const MAX_RECONNECT_ATTEMPTS = 5;

// accountId -> { label, status, qr, pairingCode, groups: Map(id->name), sock, reconnectAttempts }
const liveAccounts = new Map();

function containsBannedWord(text, bannedWords) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return bannedWords.some((w) => w && lower.includes(w.toLowerCase()));
}

function containsLink(text) {
  if (!text) return false;
  return LINK_REGEX.test(text);
}

function fillTemplate(template, { user, count, max }) {
  return (template || "")
    .replace("{user}", user ? `@${user.split("@")[0]}` : "")
    .replace("{count}", count ?? "")
    .replace("{max}", max ?? "");
}

async function listAccounts() {
  if (!isConfigured()) {
    return Array.from(liveAccounts.entries()).map(([id, a]) => ({
      id,
      label: a.label,
      phone_number: a.phoneNumber || "",
      status: a.status
    }));
  }
  const pool = getPool();
  const [rows] = await pool.query(
    "SELECT id, label, phone_number, status FROM accounts ORDER BY created_at"
  );
  return rows.map((r) => ({ ...r, status: liveAccounts.get(r.id)?.status || r.status }));
}

async function setAccountStatus(id, status) {
  const runtime = liveAccounts.get(id);
  if (runtime) runtime.status = status;
  if (isConfigured()) {
    await getPool().query("UPDATE accounts SET status = ? WHERE id = ?", [status, id]);
  }
}

function getAccountRuntime(id) {
  return liveAccounts.get(id);
}

async function createAccount(label) {
  const id = crypto.randomUUID();
  if (isConfigured()) {
    await getPool().query(
      "INSERT INTO accounts (id, label, status) VALUES (?, ?, 'connecting')",
      [id, label || "WhatsApp Account"]
    );
  }
  liveAccounts.set(id, {
    label: label || "WhatsApp Account",
    status: "connecting",
    qr: null,
    pairingCode: null,
    phoneNumber: null,
    groups: new Map(),
    reconnectAttempts: 0
  });
  return id;
}

async function refreshGroups(id) {
  const runtime = liveAccounts.get(id);
  if (!runtime?.sock) return;
  try {
    const groups = await runtime.sock.groupFetchAllParticipating();
    runtime.groups = new Map(Object.values(groups).map((g) => [g.id, g.subject]));
  } catch (err) {
    console.error(`[${id}] failed to fetch groups:`, err.message);
  }
}

async function startAccount(id, phoneNumber) {
  let runtime = liveAccounts.get(id);
  if (!runtime) {
    runtime = {
      label: "WhatsApp Account",
      status: "connecting",
      qr: null,
      pairingCode: null,
      phoneNumber,
      groups: new Map(),
      reconnectAttempts: 0
    };
    liveAccounts.set(id, runtime);
  }
  runtime.phoneNumber = phoneNumber || runtime.phoneNumber;

  const { state, saveCreds } = await useDBAuthState(id);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({ version, auth: state, logger, printQRInTerminal: false });
  runtime.sock = sock;

  sock.ev.on("creds.update", saveCreds);

  if (phoneNumber && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        runtime.pairingCode = code;
        runtime.status = "pairing";
      } catch (err) {
        console.error(`[${id}] failed to request pairing code:`, err.message);
      }
    }, 3000);
  }

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      runtime.qr = qr;
      runtime.status = "qr";
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
        console.error(`[${id}] fatal disconnect (${statusCode}): ${errorMsg}`);
        runtime.status = "disconnected";
        await setAccountStatus(id, "disconnected");
        return;
      }

      runtime.reconnectAttempts = (runtime.reconnectAttempts || 0) + 1;
      if (runtime.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        console.error(`[${id}] gave up reconnecting after ${MAX_RECONNECT_ATTEMPTS} attempts.`);
        runtime.status = "error";
        await setAccountStatus(id, "error");
        return;
      }

      const delay = Math.min(30000, 2000 * 2 ** (runtime.reconnectAttempts - 1));
      console.log(`[${id}] connection closed (${errorMsg}). Retrying in ${delay / 1000}s.`);
      setTimeout(() => startAccount(id, runtime.phoneNumber), delay);
    } else if (connection === "open") {
      console.log(`[${id}] connected to WhatsApp.`);
      runtime.status = "connected";
      runtime.qr = null;
      runtime.pairingCode = null;
      runtime.reconnectAttempts = 0;
      await setAccountStatus(id, "connected");
      refreshGroups(id);
    }
  });

  sock.ev.on("groups.update", () => refreshGroups(id));

  sock.ev.on("group-participants.update", async (event) => {
    const { id: groupId, participants, action } = event;
    if (action === "add") {
      const settings = await settingsStore.getSettings(id, groupId);
      for (const userId of participants) {
        const text = fillTemplate(settings.welcome_message, { user: userId });
        await sock.sendMessage(groupId, { text, mentions: [userId] });
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const groupId = msg.key.remoteJid;
      if (!groupId?.endsWith("@g.us")) continue;

      const settings = await settingsStore.getSettings(id, groupId);
      const bannedWords = settings.banned_words.split("\n").map((w) => w.trim()).filter(Boolean);
      const maxWarnings = parseInt(settings.max_warnings, 10) || 3;
      const senderId = msg.key.participant || msg.key.remoteJid;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "";

      const violatesLink = containsLink(text);
      const violatesWord = containsBannedWord(text, bannedWords);
      if (!violatesLink && !violatesWord) continue;

      try {
        await sock.sendMessage(groupId, {
          delete: { remoteJid: groupId, fromMe: false, id: msg.key.id, participant: senderId }
        });
      } catch (err) {
        console.error(`[${id}] failed to delete message:`, err.message);
      }

      const count = await warningStore.increment(id, groupId, senderId);
      const warnText = fillTemplate(settings.warning_message, { user: senderId, count, max: maxWarnings });
      await sock.sendMessage(groupId, { text: warnText, mentions: [senderId] });

      if (count >= maxWarnings) {
        const kickText = fillTemplate(settings.kick_message, { user: senderId, max: maxWarnings });
        await sock.sendMessage(groupId, { text: kickText, mentions: [senderId] });

        try {
          await sock.groupParticipantsUpdate(groupId, [senderId], "remove");
        } catch (err) {
          console.error(`[${id}] failed to remove user (bot may not be admin):`, err.message);
        }

        await warningStore.reset(id, groupId, senderId);
      }
    }
  });
}

// On startup, reconnect any accounts that were previously connected/connecting,
// using their saved session in the database - no re-scan needed.
async function resumeAccountsFromDB() {
  if (!isConfigured()) return;
  const pool = getPool();
  const [rows] = await pool.query(
    "SELECT id, label, phone_number FROM accounts WHERE status != 'disconnected'"
  );
  for (const row of rows) {
    liveAccounts.set(row.id, {
      label: row.label,
      status: "connecting",
      qr: null,
      pairingCode: null,
      phoneNumber: row.phone_number,
      groups: new Map(),
      reconnectAttempts: 0
    });
    startAccount(row.id, row.phone_number).catch((err) =>
      console.error(`Failed to resume account ${row.id}:`, err.message)
    );
  }
}

module.exports = {
  listAccounts,
  createAccount,
  startAccount,
  getAccountRuntime,
  refreshGroups,
  resumeAccountsFromDB
};
