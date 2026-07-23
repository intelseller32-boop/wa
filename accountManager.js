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
const usageStore = require("./usageStore");
const dmAutoReplyStore = require("./dmAutoReplyStore");
const dmVariableStore = require("./dmVariableStore");
const dmGreetingStore = require("./dmGreetingStore");
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

function containsLink(text, extraAllowedDomains = []) {
  if (!text) return false;
  const matches = text.match(new RegExp(LINK_REGEX.source, "gi"));
  if (!matches) return false;
  const allDomains = [...WHITELISTED_LINK_DOMAINS, ...extraAllowedDomains];
  // Only a violation if at least one link isn't on the whitelist.
  return matches.some(
    (link) => !allDomains.some((domain) => domain && link.toLowerCase().includes(domain.toLowerCase()))
  );
}

// When someone tags this group in their WhatsApp status, WhatsApp drops a
// special protocol message into the group chat itself (not normal text) so
// members can tap through to view it. Baileys surfaces that as a
// `groupMentionedMessage` field on the message object.
function isGroupStatusMention(msg) {
  const m = msg.message;
  if (!m) return false;
  return !!(
    m.groupMentionedMessage ||
    m.groupStatusMentionMessage ||
    m.groupStatusMessage ||
    m.groupStatusMessageV2 ||
    m.statusMentionMessage
  );
}

// Replaces every {key} in the template with vars[key], for every key
// provided — not just the fixed {user}/{count}/{max} set. Uses split/join
// instead of a RegExp so variable values never need escaping, and so a
// placeholder can appear more than once in the same template (the old
// single-.replace() version silently only filled in the first occurrence).
function fillTemplate(template, vars = {}) {
  let result = template || "";
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined || value === null) continue;
    const rendered = key === "user" && value ? `@${String(value).split("@")[0]}` : String(value);
    result = result.split(`{${key}}`).join(rendered);
  }
  return result;
}

const WATERMARK_TEXT = "\n\n_Bot powered by intelseller.com_";

// Appends the "powered by" watermark to outgoing group messages for
// non-premium accounts. Whether an account carries the watermark is set by
// whatever billing layer owns it (e.g. a marketplace app calling the API)
// via the `watermark` field on create/update — this project has no concept
// of "premium" on its own.
function withWatermark(text, runtime) {
  return runtime?.watermark === false ? text : `${text}${WATERMARK_TEXT}`;
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

async function createAccount(label, watermark = true) {
  const id = crypto.randomUUID();
  if (isConfigured()) {
    await getPool().query(
      "INSERT INTO accounts (id, label, status, watermark) VALUES (?, ?, 'connecting', ?)",
      [id, label || "WhatsApp Account", watermark ? 1 : 0]
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
    reconnectAttempts: 0,
    watermark: watermark !== false
  });
  return id;
}

// Called whenever the owning billing layer's premium status changes (e.g. a
// marketplace app polling premium status). Takes effect on the very next
// message — no reconnect needed.
async function setWatermark(id, watermark) {
  const runtime = liveAccounts.get(id);
  if (!runtime) return { ok: false, error: "Account not found." };
  runtime.watermark = watermark !== false;
  if (isConfigured()) {
    await getPool().query("UPDATE accounts SET watermark = ? WHERE id = ?", [runtime.watermark ? 1 : 0, id]);
  }
  return { ok: true, watermark: runtime.watermark };
}

// Stops the live connection WITHOUT deleting its saved session — used when
// a plan/subscription lapses. Unlike deleteAccount, resuming later via
// startAccount/reconnect does NOT require a new QR/pairing scan. The
// `paused` flag also stops the automatic reconnect-retry loop in
// connection.update from undoing this the moment WhatsApp's own socket
// close event fires.
async function pauseAccount(id) {
  const runtime = liveAccounts.get(id);
  if (!runtime) return { ok: false, error: "Account not found." };
  runtime.paused = true;
  if (runtime.sock) {
    try {
      runtime.sock.ev.removeAllListeners();
      runtime.sock.end(undefined);
    } catch (err) {
      // ignore — socket may already be dead
    }
    runtime.sock = null;
  }
  runtime.status = "paused";
  runtime.qr = null;
  runtime.pairingCode = null;
  runtime.lastError = "Paused until the plan is renewed.";
  await setAccountStatus(id, "paused");
  return { ok: true };
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
      reconnectAttempts: 0,
      watermark: true
    };
    liveAccounts.set(id, runtime);
  }
  runtime.phoneNumber = phoneNumber || runtime.phoneNumber;
  runtime.status = "connecting";
  runtime.lastError = null;
  runtime.qr = null;
  runtime.pairingCode = null;
  runtime.paused = false;
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
      if (runtime.paused) {
        // Explicitly paused (e.g. plan expired) — don't auto-retry. Whoever
        // paused it is responsible for calling startAccount to resume.
        return;
      }
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
    try {
      const { id: groupId, participants, action } = event;
      if (action === "add") {
        const settings = await settingsStore.getSettings(id, groupId);
        if (settings.enabled === "0") return;
        for (const userId of participants) {
          const text = withWatermark(fillTemplate(settings.welcome_message || "", { user: userId }), runtime);
          let sent;
          try {
            sent = await sock.sendMessage(groupId, { text, mentions: [userId] });
            usageStore.increment(id, { messages: 1 }).catch(() => {});
          } catch (err) {
            console.error(`[${id}] failed to send welcome message:`, err.message);
            continue;
          }
          await pinWelcomeMessage(groupId, sent);
        }
      }
    } catch (err) {
      console.error(`[${id}] group-participants.update handler failed:`, err.message);
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

  function randomDelay(minMs, maxMs) {
    return new Promise((resolve) => setTimeout(resolve, minMs + Math.random() * (maxMs - minMs)));
  }

  // Shows a brief "typing…" presence before sending — cheap anti-ban
  // hygiene. An instant, zero-delay reply to every message is one of the
  // clearer "this is a bot" signals WhatsApp's behavioral detection looks
  // for; a short human-like pause costs nothing and reduces that signal.
  async function sendHumanlike(jid, content) {
    try {
      await sock.sendPresenceUpdate("composing", jid);
      await randomDelay(700, 2200);
      await sock.sendPresenceUpdate("paused", jid);
    } catch (err) {
      // presence updates are best-effort — never block the actual reply on this
    }
    return sock.sendMessage(jid, content);
  }

  // Personal-chat (1:1 DM) auto-reply + first-message greeting. Deliberately
  // REPLY-ONLY: this only ever fires in response to a message the contact
  // sent first, the same trigger WhatsApp's own official "away message" /
  // "greeting message" feature uses. It never initiates a conversation with
  // anyone, and never touches groups, statuses, broadcasts, or newsletters —
  // see the JID check at the call site below.
  async function handleDirectMessage(msg) {
    const contactJid = msg.key.remoteJid;
    const senderName = msg.pushName || contactJid.split("@")[0];

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      "";

    try {
      const greetingSettings = await dmGreetingStore.getSettings(id);
      const customVars = await dmVariableStore.listVariables(id);
      // {user} keeps the same @mention rendering as groups (harmless in a
      // DM, just renders as text); {name} is the contact's own WhatsApp
      // display name; {number} is their raw phone number. Custom variables
      // are spread in last so they can't be shadowed by the built-ins —
      // dmVariableStore already blocks reserved names at save-time too.
      const vars = { user: contactJid, name: senderName, number: contactJid.split("@")[0], ...customVars };

      if (greetingSettings.enabled && greetingSettings.message) {
        const shouldGreet = await dmGreetingStore.shouldGreetAndMark(id, contactJid, greetingSettings.resetAfterDays);
        if (shouldGreet) {
          const greetingText = withWatermark(fillTemplate(greetingSettings.message, vars), runtime);
          await sendHumanlike(contactJid, { text: greetingText });
          usageStore.increment(id, { messages: 1 }).catch(() => {});
        }
      }

      const rules = await dmAutoReplyStore.listAutoReplies(id);
      const match = dmAutoReplyStore.findMatch(rules, text);
      if (match) {
        const replyText = withWatermark(fillTemplate(match.reply_text, vars), runtime);
        await sendHumanlike(contactJid, { text: replyText });
        usageStore.increment(id, { messages: 1 }).catch(() => {});
      }
    } catch (err) {
      console.error(`[${id}] DM auto-reply failed:`, err.message);
    }
  }

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;

      // 1:1 personal chat — auto-reply/greeting only, never moderation.
      if (remoteJid?.endsWith("@s.whatsapp.net")) {
        handleDirectMessage(msg).catch((err) => console.error(`[${id}] handleDirectMessage error:`, err.message));
        continue;
      }

      const groupId = remoteJid;
      if (!groupId?.endsWith("@g.us")) continue; // never engage statuses, broadcasts, newsletters, etc.

      const senderId = msg.key.participant || msg.key.remoteJid;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "";
      const isSticker = Boolean(msg.message.stickerMessage);

      const settings = await settingsStore.getSettings(id, groupId);
      if (settings.enabled === "0") continue;

      // Auto-reply runs for everyone, admins included - it's not a moderation action.
      try {
        const rules = await autoReplyStore.getMatchingRules(id, groupId);
        const match = autoReplyStore.findMatch(rules, text);
        if (match) {
          const replyText = withWatermark(fillTemplate(match.reply_text, { user: senderId }), runtime);
          await sock.sendMessage(groupId, { text: replyText, mentions: [senderId] });
          usageStore.increment(id, { messages: 1 }).catch(() => {});
        }
      } catch (err) {
        console.error(`[${id}] auto-reply failed:`, err.message);
      }

      if (settings.respect_admins !== "0" && (await isGroupAdmin(groupId, senderId))) continue;

      // Defensive: a bad/partial settings write can still leave a stored
      // value as SQL NULL for an old row. That should never be able to
      // crash the whole process (it did — repeatedly, see the previous
      // undefined-payload bug) — fall back to sane defaults instead.
      try {
      const bannedWords = (settings.banned_words || "").split("\n").map((w) => w.trim()).filter(Boolean);
      const maxWarnings = parseInt(settings.max_warnings, 10) || 3;
      const allowedUrls = (settings.allowed_urls || "").split("\n").map((u) => u.trim()).filter(Boolean);

      const violatesLink = settings.ban_links !== "0" && containsLink(text, allowedUrls);
      const violatesWord = containsBannedWord(text, bannedWords);
      const violatesSticker = settings.ban_stickers === "1" && isSticker;
      const violatesStatusMention = settings.ban_status_mentions === "1" && isGroupStatusMention(msg);
      if (!violatesLink && !violatesWord && !violatesSticker && !violatesStatusMention) continue;

      try {
        await sock.sendMessage(groupId, {
          delete: { remoteJid: groupId, fromMe: false, id: msg.key.id, participant: senderId }
        });
        usageStore.increment(id, { actions: 1 }).catch(() => {});
      } catch (err) {
        console.error(`[${id}] failed to delete message:`, err.message);
      }

      const count = await warningStore.increment(id, groupId, senderId);
      const warnText = withWatermark(fillTemplate(settings.warning_message || "", { user: senderId, count, max: maxWarnings }), runtime);
      await sock.sendMessage(groupId, { text: warnText, mentions: [senderId] });
      usageStore.increment(id, { messages: 1 }).catch(() => {});

      if (count >= maxWarnings) {
        const kickText = withWatermark(fillTemplate(settings.kick_message || "", { user: senderId, max: maxWarnings }), runtime);
        await sock.sendMessage(groupId, { text: kickText, mentions: [senderId] });
        usageStore.increment(id, { messages: 1 }).catch(() => {});

        try {
          await sock.groupParticipantsUpdate(groupId, [senderId], "remove");
          usageStore.increment(id, { actions: 1 }).catch(() => {});
        } catch (err) {
          console.error(`[${id}] failed to remove user (bot may not be admin):`, err.message);
        }

        await warningStore.reset(id, groupId, senderId);
      }
      } catch (err) {
        console.error(`[${id}] moderation check failed for group ${groupId}:`, err.message);
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
    // usage_counters is intentionally NOT deleted here. wabot syncs usage
    // right before it calls this delete, but leaving the row around is a
    // safety net — a delete-then-immediate-pull race, or a sync that failed
    // right before deletion, would otherwise silently lose billable usage
    // an owner already ran up. The row is tiny and harmless to keep.
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
  const [rows] = await pool.query("SELECT id, label, phone_number, status, watermark FROM accounts");
  for (const row of rows) {
    liveAccounts.set(row.id, {
      label: row.label,
      status: row.status === "disconnected" || row.status === "paused" ? row.status : "connecting",
      qr: null,
      pairingCode: null,
      phoneNumber: row.phone_number,
      groups: new Map(),
      pinnedWelcome: new Map(),
      reconnectAttempts: 0,
      paused: row.status === "paused",
      watermark: row.watermark !== 0
    });
    if (row.status !== "disconnected" && row.status !== "paused") {
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
  pauseAccount,
  setWatermark,
  getAccountRuntime,
  refreshGroups,
  resumeAccountsFromDB,
  deleteAccount
};
