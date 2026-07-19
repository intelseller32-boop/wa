const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} = require("@whiskeysockets/baileys");
const crypto = require("crypto");
const P = require("pino");
const { useDBAuthState } = require("./dbAuthState");
const { getPool, isConfigured } = require("./db");
const settingsStore = require("./settingsStore");
const warningStore = require("./warningStore");
const autoReplyStore = require("./autoReplyStore");
const { LINK_REGEX, WHITELISTED_LINK_DOMAINS } = require("./config");

const logger = P({ level: "silent" });
const MAX_RECONNECT_ATTEMPTS = 5;
const STALL_TIMEOUT_MS = 25000; // if nothing happens within this long, stop spinning and show an error

// accountId -> { label, status, qr, pairingCode, groups: Map(id->name), sock, reconnectAttempts, lastError }
const liveAccounts = new Map();

// fetchLatestBaileysVersion() calls out to GitHub before a QR can even be
// generated. On some hosts that call can hang or fail silently, which is a
// known cause of the dashboard spinning on "Connecting..." forever. Race it
// against a timeout and fall back to the version bundled with the library
// instead of hanging the whole connection attempt.
async function getBaileysVersion(id) {
  try {
    const versionPromise = fetchLatestBaileysVersion();
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 8000));
    const { version } = await Promise.race([versionPromise, timeout]);
    return version;
  } catch (err) {
    console.warn(`[${id}] could not fetch latest Baileys version (${err.message}), using bundled default.`);
    return undefined;
  }
}

function containsBannedWord(text, bannedWords) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return bannedWords.some((w) => w && lower.includes(w.toLowerCase()));
}

function containsLink(text) {
  if (!text) return false;
  const matches = text.match(new RegExp(LINK_REGEX.source, "gi"));
  if (!matches) return false;
  // Only a violation if at least one link isn't on the whitelist.
  return matches.some(
    (link) => !WHITELISTED_LINK_DOMAINS.some((domain) => link.toLowerCase().includes(domain.toLowerCase()))
  );
}

function fillTemplate(template, { user, count, max }) {
  return (template || "")
    .replace("{user}", user ? `@${user.split("@")[0]}` : "")
    .replace("{count}", count ?? "")
    .replace("{max}", max ?? "");
}

// The in-memory liveAccounts map is the source of truth once the server is
// running (populated at boot by resumeAccountsFromDB, kept in sync by
// createAccount/deleteAccount). Listing never touches the database, so
// polling the dashboard doesn't cost you MySQL queries on Railway.
async function listAccounts() {
  return Array.from(liveAccounts.entries()).map(([id, a]) => ({
    id,
    label: a.label,
    phone_number: a.phoneNumber || "",
    status: a.status
  }));
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
    pinnedWelcome: new Map(),
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

async function startAccount(id, phoneNumber, isRetry = false) {
  let runtime = liveAccounts.get(id);
  if (!runtime) {
    runtime = {
      label: "WhatsApp Account",
      status: "connecting",
      qr: null,
      pairingCode: null,
      phoneNumber,
      groups: new Map(),
      pinnedWelcome: new Map(),
      reconnectAttempts: 0
    };
    liveAccounts.set(id, runtime);
  }
  runtime.phoneNumber = phoneNumber || runtime.phoneNumber;
  runtime.status = "connecting";
  runtime.lastError = null;
  runtime.qr = null;
  runtime.pairingCode = null;
  if (!isRetry) runtime.reconnectAttempts = 0;

  const { state, saveCreds } = await useDBAuthState(id);
  const version = await getBaileysVersion(id);

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    connectTimeoutMs: 30000,
    keepAliveIntervalMs: 20000
  });
  runtime.sock = sock;

  // Safety net: if WhatsApp never responds at all (no qr/pairing/open/close),
  // don't leave the dashboard spinning on "Connecting..." forever.
  const stallTimer = setTimeout(async () => {
    if (runtime.sock === sock && runtime.status === "connecting") {
      console.error(`[${id}] connection attempt stalled - no response from WhatsApp within ${STALL_TIMEOUT_MS / 1000}s.`);
      runtime.status = "error";
      runtime.lastError = "Couldn't reach WhatsApp's servers in time. Tap Reconnect to try again.";
      await setAccountStatus(id, "error");
    }
  }, STALL_TIMEOUT_MS);

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
    clearTimeout(stallTimer);
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
        runtime.lastError = statusCode === DisconnectReason.loggedOut
          ? "This device was logged out from WhatsApp. Remove it and add it again to relink."
          : `Connection closed: ${errorMsg}`;
        await setAccountStatus(id, "disconnected");
        return;
      }

      runtime.reconnectAttempts = (runtime.reconnectAttempts || 0) + 1;
      if (runtime.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        console.error(`[${id}] gave up reconnecting after ${MAX_RECONNECT_ATTEMPTS} attempts (${errorMsg}).`);
        runtime.status = "error";
        runtime.lastError = `Gave up after ${MAX_RECONNECT_ATTEMPTS} attempts: ${errorMsg}. Tap Reconnect to try again.`;
        await setAccountStatus(id, "error");
        return;
      }

      const delay = Math.min(30000, 2000 * 2 ** (runtime.reconnectAttempts - 1));
      console.log(`[${id}] connection closed (${errorMsg}). Retrying in ${delay / 1000}s.`);
      setTimeout(() => startAccount(id, runtime.phoneNumber, true), delay);
    } else if (connection === "open") {
      console.log(`[${id}] connected to WhatsApp.`);
      runtime.status = "connected";
      runtime.qr = null;
      runtime.pairingCode = null;
      runtime.reconnectAttempts = 0;
      runtime.lastError = null;
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
        let sent;
        try {
          sent = await sock.sendMessage(groupId, { text, mentions: [userId] });
        } catch (err) {
          console.error(`[${id}] failed to send welcome message:`, err.message);
          continue;
        }
        await pinWelcomeMessage(groupId, sent);
      }
    }
  });

  async function pinWelcomeMessage(groupId, sent) {
    if (!sent?.key) return;
    const previousKey = runtime.pinnedWelcome.get(groupId);
    if (previousKey) {
      try {
        await sock.sendMessage(groupId, { pin: { type: 0, time: 2592000, key: previousKey } });
      } catch (err) {
        console.error(`[${id}] failed to unpin previous welcome message:`, err.message);
      }
    }
    try {
      await sock.sendMessage(groupId, { pin: { type: 1, time: 2592000, key: sent.key } });
      runtime.pinnedWelcome.set(groupId, sent.key);
    } catch (err) {
      console.error(`[${id}] failed to pin welcome message (bot may not be admin):`, err.message);
    }
  }

  // groupId -> { admins: Set<jid>, fetchedAt: number }
  const groupAdminCache = new Map();
  const ADMIN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes; avoids hammering groupMetadata (rate-overlimit)

  async function isGroupAdmin(groupId, userId) {
    const cached = groupAdminCache.get(groupId);
    if (cached && Date.now() - cached.fetchedAt < ADMIN_CACHE_TTL_MS) {
      return cached.admins.has(userId);
    }

    try {
      const metadata = await sock.groupMetadata(groupId);
      const admins = new Set(
        metadata.participants
          .filter((p) => p.admin === "admin" || p.admin === "superadmin")
          .map((p) => p.id)
      );
      groupAdminCache.set(groupId, { admins, fetchedAt: Date.now() });
      return admins.has(userId);
    } catch (err) {
      console.error(`[${id}] failed to fetch group metadata for admin check:`, err.message);
      // Fail closed on the side of NOT moderating if we can't confirm admin status,
      // to avoid falsely punishing an admin when the lookup itself fails.
      return cached ? cached.admins.has(userId) : false;
    }
  }

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const groupId = msg.key.remoteJid;
      if (!groupId?.endsWith("@g.us")) continue;

      const senderId = msg.key.participant || msg.key.remoteJid;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "";

      // Auto-reply runs for everyone, admins included - it's not a moderation action.
      try {
        const rules = await autoReplyStore.getMatchingRules(id, groupId);
        const match = autoReplyStore.findMatch(rules, text);
        if (match) {
          await sock.sendMessage(groupId, { text: match.reply_text });
        }
      } catch (err) {
        console.error(`[${id}] auto-reply failed:`, err.message);
      }

      if (await isGroupAdmin(groupId, senderId)) continue;

      const settings = await settingsStore.getSettings(id, groupId);
      const bannedWords = settings.banned_words.split("\n").map((w) => w.trim()).filter(Boolean);
      const maxWarnings = parseInt(settings.max_warnings, 10) || 3;

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

async function deleteAccount(id) {
  const runtime = liveAccounts.get(id);
  if (runtime?.sock) {
    try {
      await runtime.sock.logout();
    } catch (err) {
      // ignore - account may already be disconnected
    }
    try {
      runtime.sock.end(undefined);
    } catch (err) {
      // ignore
    }
  }
  liveAccounts.delete(id);

  if (isConfigured()) {
    const pool = getPool();
    await pool.query("DELETE FROM accounts WHERE id = ?", [id]);
    await pool.query("DELETE FROM auth_data WHERE account_id = ?", [id]);
    await pool.query("DELETE FROM settings WHERE account_id = ?", [id]);
    await pool.query("DELETE FROM warnings WHERE account_id = ?", [id]);
  }
}

// On startup, load every saved account into the in-memory map (so the
// dashboard can list them without hitting the database), and reconnect any
// that were previously connected/connecting using their saved session -
// no re-scan needed. Accounts saved as 'disconnected' are listed but not
// auto-started; the user reconnects them manually from the dashboard.
async function resumeAccountsFromDB() {
  if (!isConfigured()) return;
  const pool = getPool();
  const [rows] = await pool.query("SELECT id, label, phone_number, status FROM accounts");
  for (const row of rows) {
    liveAccounts.set(row.id, {
      label: row.label,
      status: row.status === "disconnected" ? "disconnected" : "connecting",
      qr: null,
      pairingCode: null,
      phoneNumber: row.phone_number,
      groups: new Map(),
      pinnedWelcome: new Map(),
      reconnectAttempts: 0
    });
    if (row.status !== "disconnected") {
      startAccount(row.id, row.phone_number).catch((err) =>
        console.error(`Failed to resume account ${row.id}:`, err.message)
      );
    }
  }
}

module.exports = {
  listAccounts,
  createAccount,
  startAccount,
  getAccountRuntime,
  refreshGroups,
  resumeAccountsFromDB,
  deleteAccount
};
