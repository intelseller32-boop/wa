// @vkazee/baileys (fork of @whiskeysockets/baileys, added for real WhatsApp
// "group status" support via groupStatusMessageV2 — see sendGroupStatus()
// below) publishes as an ESM-only package ("type": "module", no CJS/require
// build). This file is CommonJS, so it can't `require()` it directly — it
// has to be loaded with a dynamic import() instead. That's async, so every
// exported function that touches these bindings awaits `baileysReady`
// first (see each function below); internal helper functions they call
// don't need their own await since by the time they run the import has
// already resolved.
let makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  jidNormalizedUser,
  generateWAMessageContent,
  prepareWAMessageMedia;

const baileysReady = import("@vkazee/baileys").then((mod) => {
  makeWASocket = mod.default;
  DisconnectReason = mod.DisconnectReason;
  fetchLatestBaileysVersion = mod.fetchLatestBaileysVersion;
  Browsers = mod.Browsers;
  jidNormalizedUser = mod.jidNormalizedUser;
  generateWAMessageContent = mod.generateWAMessageContent;
  prepareWAMessageMedia = mod.prepareWAMessageMedia;
}).catch((err) => {
  console.error("[accountManager] FAILED to load @vkazee/baileys:", err.message);
  throw err;
});

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
const MAX_RECONNECT_ATTEMPTS = 6;
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
    purpose: a.purpose === "ads" ? "ads" : "moderator",
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

async function createAccount(label, watermark = true, purpose = "moderator") {
  const id = crypto.randomUUID();
  const safePurpose = purpose === "ads" ? "ads" : "moderator";
  if (isConfigured()) {
    await getPool().query(
      "INSERT INTO accounts (id, label, status, watermark, purpose) VALUES (?, ?, 'connecting', ?, ?)",
      [id, label || "WhatsApp Account", watermark ? 1 : 0, safePurpose]
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
    watermark: watermark !== false,
    purpose: safePurpose
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

async function refreshGroups(id, attempt = 0) {
  const runtime = liveAccounts.get(id);
  if (!runtime?.sock) return;
  try {
    const groups = await runtime.sock.groupFetchAllParticipating();
    runtime.groups = new Map(Object.values(groups).map((g) => [g.id, g.subject]));
    console.log(`[${id}] refreshed group list: ${runtime.groups.size} group(s)`);
  } catch (err) {
    console.error(`[${id}] failed to fetch groups (attempt ${attempt + 1}):`, err.message);
    // Rate limits / timeouts right after a (re)connect are common and
    // transient — retry a few times with backoff instead of permanently
    // leaving runtime.groups empty, which would make every group look like
    // "not a member" until the next lucky groups.update/connection.open event.
    if (attempt < 4) {
      const delay = [5000, 15000, 30000, 60000][attempt] || 60000;
      setTimeout(() => refreshGroups(id, attempt + 1), delay);
    }
  }
}

async function startAccount(id, phoneNumber, isRetry = false) {
  await baileysReady;
  let runtime = liveAccounts.get(id);
  if (!runtime) {
    runtime = {
      label: "WhatsApp Account",
      status: "connecting",
      qr: null,
      pairingCode: null,
      phoneNumber,
      groups: new Map(),
      channels: new Map(), // WhatsApp Channels ("newsletters") this account is known to follow — jid -> { name }, populated from chats.upsert/update + messaging-history.set (see registerChannelSync)
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
  // Baileys still fires periodic 'qr' connection.update events (an
  // automatic refresh roughly every 20-60s) even while a pairing code has
  // already been requested and is waiting to be entered — the QR is just
  // an alternate, always-live login path that Baileys keeps warm in the
  // background. Without this flag, the connection.update handler below
  // would treat that refresh as "the login screen is QR now" and flip
  // status back to 'qr', overwriting the pairing code the owner is
  // actively looking at. Sending it once per startAccount call (not
  // once at module load) means this correctly resets if the owner
  // switches back to plain QR login later via a fresh startAccount call.
  runtime.usePairing = Boolean(phoneNumber);
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
    keepAliveIntervalMs: 20000,
    // Baileys' default "web" sync only sends a shallow/recent slice of
    // chats on connect — WhatsApp Channels the account follows are often
    // NOT included in that shallow slice at all, which is why
    // runtime.channels (and therefore /whatsapp/channels/mine) can come
    // back completely empty even for an account that visibly follows
    // channels on its phone. syncFullHistory asks for the fuller sync that
    // actually includes them. This only takes effect from the NEXT fresh
    // connection (see the trackChannelChats note below) — flipping this on
    // doesn't retroactively populate already-connected sessions.
    syncFullHistory: true
  });
  runtime.sock = sock;

  // messageId -> { jid, origJid, sentAt }. Populated by sendHumanlike() right
  // after Baileys accepts a send, cleared by the messages.update ack handler
  // below (or by the sweep) once we know what actually happened to it. This
  // is what lets the logs distinguish "Baileys accepted it but WhatsApp
  // never delivered it" from a genuinely successful send.
  const pendingSends = new Map();

  // Sweep for sends that never got any ack at all within a reasonable
  // window — a stuck/pending send with zero ack is itself a signal (usually
  // a dead/desynced session), distinct from an explicit error ack.
  const pendingSweep = setInterval(() => {
    const now = Date.now();
    for (const [msgId, info] of pendingSends.entries()) {
      if (now - info.sentAt > 20000) {
        console.error(`[${id}] send to ${info.jid} (orig ${info.origJid}, id=${msgId}) got NO delivery ack within 20s — message likely never reached WhatsApp/the recipient.`);
        pendingSends.delete(msgId);
      }
    }
  }, 10000);

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

    if (qr && !runtime.usePairing) {
      runtime.qr = qr;
      runtime.status = "qr";
    }

    if (connection === "close") {
      clearInterval(pendingSweep);
      if (runtime.paused) {
        // Explicitly paused (e.g. plan expired) — don't auto-retry. Whoever
        // paused it is responsible for calling startAccount to resume.
        return;
      }
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMsg = lastDisconnect?.error?.message || "unknown error";

      // Only an actual logout (the user removed/unlinked the device from
      // their phone, or WhatsApp invalidated the session server-side) should
      // ever force a full disconnect requiring a new QR/pairing scan. Every
      // other close reason — including badSession (500) and
      // multideviceMismatch, which are frequently just a transient
      // stream/signal-session hiccup (e.g. a "Bad MAC" burst on a @lid
      // session forcing WhatsApp to close the socket, or momentary network
      // trouble) rather than a real logout — should fall through to the
      // normal retry-with-backoff path below. Treating those as fatal was
      // the cause of accounts getting force-disconnected on their own
      // without anyone actually logging out.
      const fatalReasons = [DisconnectReason.loggedOut];

      if (fatalReasons.includes(statusCode)) {
        console.error(`[${id}] fatal disconnect (${statusCode}): ${errorMsg}`);
        runtime.status = "disconnected";
        runtime.lastError = "This device was logged out from WhatsApp. Remove it and add it again to relink.";
        await setAccountStatus(id, "disconnected");
        return;
      }

      if (statusCode === DisconnectReason.connectionReplaced || statusCode === DisconnectReason.multideviceMismatch) {
        // Not a manual logout, but also not something blindly retrying will
        // usually fix on its own (another device is holding the session, or
        // the device list is out of sync). Log it distinctly for
        // visibility, but still go through the normal retry path below
        // instead of forcing "disconnected" — the session/creds are left
        // intact, so if it does resolve itself no re-scan is needed.
        console.warn(`[${id}] disconnect needs attention (${statusCode}): ${errorMsg} — will still retry, no re-scan required.`);
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

  // Passively collect every WhatsApp Channel ("newsletter") this account is
  // known to follow, straight from Baileys' own chat sync — no polling, no
  // extra API calls. This only tells us WHICH channels exist for this
  // account, not the account's role in each (chat-list entries don't carry
  // that) — role is resolved on demand per channel via lookupChannel/
  // getMyRoleInChannel, see listMyChannels().
  //
  // IMPORTANT: this only starts collecting from the moment this specific
  // startAccount() call's socket connects. An account that was ALREADY
  // connected before this code shipped is still running its old socket
  // with none of these listeners attached — it needs a Reconnect (or a
  // natural reconnect) before its channels start showing up at all.
  let historySyncSeen = false;
  const trackChannelChats = (source, chats) => {
    if (!chats || !chats.length) return;
    const before = runtime.channels.size;
    for (const chat of chats) {
      if (chat?.id && chat.id.endsWith("@newsletter")) {
        runtime.channels.set(chat.id, { name: chat.name || runtime.channels.get(chat.id)?.name || "" });
      }
    }
    const added = runtime.channels.size - before;
    console.log(`[${id}][channel-sync] ${source}: ${chats.length} chat(s) received, ${added} new @newsletter entrie(s) (total tracked: ${runtime.channels.size})`);
  };
  sock.ev.on("messaging-history.set", ({ chats, isLatest }) => {
    historySyncSeen = true;
    trackChannelChats(`messaging-history.set${isLatest ? " (final batch)" : ""}`, chats);
    if (isLatest && runtime.channels.size === 0) {
      console.warn(`[${id}][channel-sync] history sync finished with ZERO @newsletter chats seen. If this account really does follow channels on its phone, WhatsApp isn't including them in this sync — try unmuting/reopening the channel on the phone once while connected, which usually forces a chats.upsert for it.`);
    }
  });
  sock.ev.on("chats.upsert", (chats) => trackChannelChats("chats.upsert", chats));
  sock.ev.on("chats.update", (chats) => trackChannelChats("chats.update", chats));

  sock.ev.on("group-participants.update", async (event) => {
    // "ads"-purpose accounts (linked from ad-hub's promote.html) only ever
    // send whatever they're told to via the /send API — they never welcome
    // joiners on their own. Only "moderator"-purpose accounts (linked from
    // the wabot module) do that.
    if (runtime.purpose === "ads") return;
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

  // Checks whether the bot itself currently has admin rights in a group.
  // Moderation actions (delete-for-everyone, removing a member) silently
  // no-op on WhatsApp's side when the bot isn't admin — Baileys doesn't
  // always throw, so we can't just rely on a catch block to notice.
  // Reuses the same admin cache/TTL as isGroupAdmin above.
  async function isBotGroupAdmin(groupId) {
    if (!sock.user?.id) return false;
    const botJid = jidNormalizedUser(sock.user.id);
    return isGroupAdmin(groupId, botJid);
  }

  // groupId -> last time we posted the "I need admin rights" notice.
  // Prevents spamming the group once per violating message.
  const noAdminNoticeAt = new Map();
  const NO_ADMIN_NOTICE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

  async function notifyMissingAdminRights(groupId, runtime) {
    const last = noAdminNoticeAt.get(groupId) || 0;
    if (Date.now() - last < NO_ADMIN_NOTICE_COOLDOWN_MS) return;
    noAdminNoticeAt.set(groupId, Date.now());
    try {
      await sock.sendMessage(groupId, {
        text: withWatermark(
          "⚠️ I need admin rights in this group to delete messages and remove members. Please make me an admin so I can enforce the moderation rules.",
          runtime
        )
      });
      usageStore.increment(id, { messages: 1 }).catch(() => {});
    } catch (err) {
      console.error(`[${id}] failed to send missing-admin-rights notice:`, err.message);
    }
  }

  function randomDelay(minMs, maxMs) {
    return new Promise((resolve) => setTimeout(resolve, minMs + Math.random() * (maxMs - minMs)));
  }

  // WhatsApp is rolling @lid (Linked ID) addressing out everywhere, and
  // Baileys' handling of sending TO a raw @lid is still shaky in the 6.x
  // line (see WhiskeySockets/Baileys #1539, #2079) — sendMessage can resolve
  // successfully with no thrown error while the message never actually
  // reaches the other side. If Baileys has already learned the real
  // phone-number JID behind this @lid (it does once the socket has
  // exchanged enough traffic with them), prefer sending to that instead —
  // it uses the normal, well-tested session path.
  async function resolvePreferredJid(jid) {
    if (!jid?.endsWith("@lid")) return jid;
    try {
      const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(jid);
      if (pn) {
        console.log(`[${id}] lid-mapping HIT for ${jid} -> ${pn}`);
        return pn;
      }
      console.log(`[${id}] lid-mapping MISS for ${jid} (no phone-number JID known yet) — will send to raw @lid`);
    } catch (err) {
      console.warn(`[${id}] lid-mapping lookup threw for ${jid}: ${err.message} — will send to raw @lid`);
    }
    return jid;
  }

  // Shows a brief "typing…" presence before sending — cheap anti-ban
  // hygiene. An instant, zero-delay reply to every message is one of the
  // clearer "this is a bot" signals WhatsApp's behavioral detection looks
  // for; a short human-like pause costs nothing and reduces that signal.
  async function sendHumanlike(jid, content) {
    const sendJid = await resolvePreferredJid(jid);
    if (sendJid !== jid) {
      console.log(`[${id}] resolved ${jid} -> ${sendJid} for sending`);
    }
    try {
      await sock.sendPresenceUpdate("composing", sendJid);
      await randomDelay(700, 2200);
      await sock.sendPresenceUpdate("paused", sendJid);
    } catch (err) {
      // presence updates are best-effort — never block the actual reply on this
    }
    // Don't let a send failure disappear into an unhandled rejection deep in
    // a fire-and-forget call chain — log it explicitly here, in addition to
    // whatever the caller's own catch does, so a delivery failure is always
    // visible in the logs rather than looking like nothing happened.
    try {
      const result = await sock.sendMessage(sendJid, content);
      const sentId = result?.key?.id;
      if (!sentId) {
        // sendMessage resolved without throwing, but returned nothing usable
        // — this is exactly the silent-no-op case the @lid comment above
        // warns about. Flag it loudly instead of letting it look identical
        // to a normal successful send.
        console.error(`[${id}] sendMessage to ${sendJid} (orig ${jid}) returned no message key — send likely did NOT reach WhatsApp despite no error being thrown.`);
      } else {
        console.log(`[${id}] sendMessage to ${sendJid} (orig ${jid}) accepted by Baileys, id=${sentId}. Waiting for delivery ack...`);
        pendingSends.set(sentId, { jid: sendJid, origJid: jid, sentAt: Date.now() });
      }
      return result;
    } catch (err) {
      console.error(`[${id}] sendMessage to ${sendJid} (orig ${jid}) failed:`, err.stack || err.message);
      throw err;
    }
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

    console.log(
      `[${id}] DM in from ${contactJid} (pushName="${msg.pushName || ""}"): "${text.slice(0, 120)}"`
    );

    try {
      const greetingSettings = await dmGreetingStore.getSettings(id);
      const customVars = await dmVariableStore.listVariables(id);
      // {user} keeps the same @mention rendering as groups (harmless in a
      // DM, just renders as text); {name} is the contact's own WhatsApp
      // display name; {number} is their raw phone number. Custom variables
      // are spread in last so they can't be shadowed by the built-ins —
      // dmVariableStore already blocks reserved names at save-time too.
      const vars = { user: contactJid, name: senderName, number: contactJid.split("@")[0], ...customVars };

      console.log(
        `[${id}] DM greeting settings: enabled=${greetingSettings.enabled} hasMessage=${Boolean(greetingSettings.message)}`
      );

      if (greetingSettings.enabled && greetingSettings.message) {
        const shouldGreet = await dmGreetingStore.shouldGreetAndMark(id, contactJid, greetingSettings.resetAfterDays);
        console.log(`[${id}] DM shouldGreet(${contactJid}) = ${shouldGreet}`);
        if (shouldGreet) {
          const greetingText = withWatermark(fillTemplate(greetingSettings.message, vars), runtime);
          await sendHumanlike(contactJid, { text: greetingText });
          console.log(`[${id}] DM greeting sent to ${contactJid}`);
          usageStore.increment(id, { messages: 1 }).catch(() => {});
        }
      }

      const rules = await dmAutoReplyStore.listAutoReplies(id);
      console.log(`[${id}] DM auto-reply rules loaded: ${rules.length}`);
      const match = dmAutoReplyStore.findMatch(rules, text);
      if (match) {
        console.log(`[${id}] DM auto-reply matched rule "${match.keyword}" (${match.match_type})`);
        const replyText = withWatermark(fillTemplate(match.reply_text, vars), runtime);
        await sendHumanlike(contactJid, { text: replyText });
        console.log(`[${id}] DM auto-reply sent to ${contactJid}`);
        usageStore.increment(id, { messages: 1 }).catch(() => {});
      } else {
        console.log(`[${id}] DM auto-reply: no rule matched text "${text.slice(0, 60)}"`);
      }
    } catch (err) {
      console.error(`[${id}] DM auto-reply failed for ${contactJid}:`, err.stack || err.message);
    }
  }

  // Baileys reports what happened to a sent message (server-ack, delivered,
  // read, or an error) via messages.update, keyed by the same message id
  // sendMessage() returned. This is the other half of the pendingSends
  // tracking above — it's what actually confirms (or disproves) delivery,
  // instead of trusting that "sendMessage didn't throw" means "it arrived".
  sock.ev.on("messages.update", (updates) => {
    for (const u of updates) {
      const msgId = u.key?.id;
      if (!msgId || !pendingSends.has(msgId)) continue;
      const info = pendingSends.get(msgId);
      const status = u.update?.status;
      if (status !== undefined) {
        // status: 0=ERROR, 1=PENDING, 2=SERVER_ACK, 3=DELIVERY_ACK, 4=READ
        const statusNames = { 0: "ERROR", 1: "PENDING", 2: "SERVER_ACK", 3: "DELIVERY_ACK", 4: "READ" };
        console.log(`[${id}] delivery update for ${info.jid} (id=${msgId}): status=${statusNames[status] || status}`);
        if (status === 0) {
          console.error(`[${id}] message to ${info.jid} (id=${msgId}) came back as ERROR — it did NOT reach the recipient.`);
        }
        if (status >= 2) pendingSends.delete(msgId); // reached WhatsApp's server at minimum; stop tracking
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    console.log(`[${id}] messages.upsert type=${type} count=${messages.length}`);
    if (type !== "notify") return;

    for (const msg of messages) {
      const remoteJid = msg.key.remoteJid;

      if (!msg.message) {
        console.log(`[${id}] skip: empty msg.message (remoteJid=${remoteJid}, likely a protocol/reaction/receipt event)`);
        continue;
      }
      if (msg.key.fromMe) {
        console.log(`[${id}] skip: fromMe (remoteJid=${remoteJid})`);
        continue;
      }

      console.log(`[${id}] inbound message remoteJid=${remoteJid} participant=${msg.key.participant || "-"}`);

      // 1:1 personal chat — auto-reply/greeting only, never moderation.
      // NOTE: WhatsApp has been rolling out "LID" (Linked ID) identifiers,
      // so a real 1:1 DM can arrive with remoteJid ending in "@lid" instead
      // of the classic "@s.whatsapp.net" — Baileys issue #1718/#1714/#1872.
      // Treating only "@s.whatsapp.net" as a DM silently drops those chats
      // (they don't match "@g.us" either, so they fall through unlogged).
      if (remoteJid?.endsWith("@s.whatsapp.net") || remoteJid?.endsWith("@lid")) {
        handleDirectMessage(msg).catch((err) => console.error(`[${id}] handleDirectMessage error:`, err.stack || err.message));
        continue;
      }

      const groupId = remoteJid;
      if (!groupId?.endsWith("@g.us")) {
        console.log(`[${id}] skip: remoteJid ${remoteJid} is neither a DM nor a group (status/broadcast/newsletter/bot)`);
        continue; // never engage statuses, broadcasts, newsletters, etc.
      }

      // "ads"-purpose accounts are for posting ads only — they never react
      // to group activity on their own (no auto-reply, no banned-word/link
      // moderation, no deleting/kicking, no "make me admin" nagging). They
      // only ever send what the /send API explicitly tells them to.
      if (runtime.purpose === "ads") {
        console.log(`[${id}] skip: purpose=ads, ignoring inbound group message (remoteJid=${remoteJid})`);
        continue;
      }

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

      // Without admin rights, "delete for everyone" and removing a member
      // both silently fail on WhatsApp's side (Baileys won't necessarily
      // throw). Check up front and tell the group why nothing happened,
      // instead of pretending the message was deleted / warning was enforced.
      if (!(await isBotGroupAdmin(groupId))) {
        await notifyMissingAdminRights(groupId, runtime);
        continue;
      }

      let deleted = false;
      try {
        await sock.sendMessage(groupId, {
          delete: { remoteJid: groupId, fromMe: false, id: msg.key.id, participant: senderId }
        });
        deleted = true;
        usageStore.increment(id, { actions: 1 }).catch(() => {});
      } catch (err) {
        console.error(`[${id}] failed to delete message:`, err.message);
      }

      if (!deleted) {
        // Admin check passed but the delete call itself still failed
        // (e.g. rights were revoked in the moment, or a transient error).
        await notifyMissingAdminRights(groupId, runtime);
        continue;
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
          await notifyMissingAdminRights(groupId, runtime);
        }

        await warningStore.reset(id, groupId, senderId);
      }
      } catch (err) {
        console.error(`[${id}] moderation check failed for group ${groupId}:`, err.message);
      }
    }
  });
}

// ==================== Ad-Hub messaging (groups + channels) ====================
// These are called by the marketplace's ad-hub module (a separate project)
// through the same wa-client/x-api-key proxy used for everything else here.
// wa-main stays a dumb pipe: it doesn't know what an "ad" is, doesn't store
// ad content, and doesn't schedule anything — it just sends whatever text
// it's handed to a group or channel jid on a connected account, right now.
// Composition (footer/branding, link, scheduling) is entirely the caller's
// job, same as how it already builds the Telegram post text.

function assertSendable(runtime, id) {
  if (!runtime || !runtime.sock) {
    console.error(`[${id}][ad-hub send] blocked: no runtime/socket for this account id — it may not exist on this wa-main instance at all (check the remote_id stored on the caller side matches an account actually created here)`);
    const err = new Error("Account is not connected.");
    err.code = "NOT_CONNECTED";
    throw err;
  }
  if (runtime.status !== "connected") {
    console.error(`[${id}][ad-hub send] blocked: status=${runtime.status} (needs to be "connected") — the WhatsApp session for this account is disconnected, still connecting/scanning QR, or was logged out`);
    const err = new Error(`Account is ${runtime.status}, not connected.`);
    err.code = "NOT_CONNECTED";
    throw err;
  }
}

// Sends a plain-text ad post into a group this account is a member of.
// `groupId` is the group's normal @g.us jid. If `imageUrl` is given, sends
// it as an image with `text` as the caption instead of a plain text message.
async function sendGroupMessage(id, groupId, text, imageUrl) {
  await baileysReady;
  const runtime = liveAccounts.get(id);
  console.log(`[${id}][ad-hub send] group=${groupId} status=${runtime?.status || "unknown"} purpose=${runtime?.purpose || "unknown"} knownGroups=${runtime?.groups?.size ?? "n/a"} hasImage=${!!imageUrl}`);
  assertSendable(runtime, id);
  if (!runtime.groups.has(groupId)) {
    // The cached group list can be empty/stale right after a reconnect (e.g.
    // a rate-limited fetch on connect) even though the account really is
    // still a member. Before giving up, do one live refresh and re-check
    // rather than trusting a possibly-stale/empty cache.
    console.warn(`[${id}][ad-hub send] group ${groupId} not in cached list (size=${runtime.groups.size}) — refreshing group list before failing`);
    await refreshGroups(id);
    if (!runtime.groups.has(groupId)) {
      console.error(`[${id}][ad-hub send] group ${groupId} still not found after live refresh (now ${runtime.groups.size} known) — account is genuinely not a member, or was removed`);
      const err = new Error("This account is no longer a member of that group.");
      err.code = "NOT_A_MEMBER";
      throw err;
    }
    console.log(`[${id}][ad-hub send] group ${groupId} found after refresh — proceeding`);
  }
  const result = await sendMessageWithOptionalImage(runtime.sock, groupId, text, imageUrl, id);
  console.log(`[${id}][ad-hub send] OK group=${groupId} msgId=${result.key.id}`);
  return { id: result.key.id };
}

// Sends a plain-text ad post into a WhatsApp Channel (Baileys calls these
// "newsletters") that this account owns or admins. `channelJid` is the
// channel's @newsletter jid. Same optional `imageUrl` behavior as above.
async function sendChannelMessage(id, channelJid, text, imageUrl) {
  await baileysReady;
  const runtime = liveAccounts.get(id);
  console.log(`[${id}][ad-hub send] channel=${channelJid} status=${runtime?.status || "unknown"} purpose=${runtime?.purpose || "unknown"} hasImage=${!!imageUrl}`);
  assertSendable(runtime, id);
  const result = await sendMessageWithOptionalImage(runtime.sock, channelJid, text, imageUrl, id);
  console.log(`[${id}][ad-hub send] OK channel=${channelJid} msgId=${result.key.id}`);
  return { id: result.key.id };
}

// Posts a REAL WhatsApp "group status" — the native feature (still a
// WhatsApp beta as of writing) that shows up in the group's own Status
// entry, visible only to that group's members, disappearing after 24h.
// This is NOT the same as sendGroupMessage (an ordinary chat message) and
// NOT the same as a personal status shared with a group mentioned in it —
// see groupStatusMessageV2 in @vkazee/baileys. `kind` is "text" | "image" |
// "video". For text, `text` is required (backgroundColor/font optional,
// e.g. backgroundColor: "#25D366", font: 0-8). For image/video, `mediaUrl`
// is required and is downloaded the same way sendMessageWithOptionalImage
// does; `caption` is optional.
async function sendGroupStatus(id, groupId, { kind, text, mediaUrl, caption, backgroundColor, font }) {
  await baileysReady;
  const runtime = liveAccounts.get(id);
  console.log(`[${id}][group-status] group=${groupId} kind=${kind} status=${runtime?.status || "unknown"}`);
  assertSendable(runtime, id);
  if (!runtime.groups.has(groupId)) {
    await refreshGroups(id);
    if (!runtime.groups.has(groupId)) {
      console.error(`[${id}][group-status] group ${groupId} not found after refresh — not a member`);
      const err = new Error("This account is no longer a member of that group.");
      err.code = "NOT_A_MEMBER";
      throw err;
    }
  }

  const sock = runtime.sock;
  const genOptions = {
    upload: sock.waUploadToServer,
    logger,
    // Baileys resolves link previews via a network call unless disabled —
    // status text doesn't need it and it only adds latency/failure surface.
    getUrlInfo: async () => undefined
  };

  let innerMessage;
  if (kind === "text") {
    const rawText = String(text || "").trim();
    if (!rawText) {
      const err = new Error("text is required for a text status.");
      err.code = "BAD_INPUT";
      throw err;
    }
    const cleanText = withWatermark(rawText, runtime);
    innerMessage = await generateWAMessageContent(
      { text: cleanText },
      { ...genOptions, backgroundColor, font }
    );
  } else if (kind === "image" || kind === "video") {
    const cleanUrl = typeof mediaUrl === "string" ? mediaUrl.trim() : "";
    if (!/^https?:\/\//i.test(cleanUrl)) {
      const err = new Error("A valid mediaUrl is required for an image/video status.");
      err.code = "BAD_INPUT";
      throw err;
    }
    console.log(`[${id}][group-status] fetching media: ${cleanUrl}`);
    const mediaRes = await fetch(cleanUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://imgbb.com/",
        "Accept": "*/*"
      }
    });
    if (!mediaRes.ok) {
      throw new Error(`media host returned ${mediaRes.status} for ${cleanUrl}`);
    }
    const buffer = Buffer.from(await mediaRes.arrayBuffer());
    const watermarkedCaption = withWatermark(String(caption || "").trim(), runtime);
    innerMessage = await prepareWAMessageMedia(
      kind === "image" ? { image: buffer, caption: watermarkedCaption } : { video: buffer, caption: watermarkedCaption },
      genOptions
    );
  } else {
    const err = new Error('kind must be "text", "image", or "video".');
    err.code = "BAD_INPUT";
    throw err;
  }

  const result = await sock.sendMessage(groupId, {
    groupStatusMessageV2: { message: innerMessage }
  });
  if (!result?.key?.id) {
    const err = new Error("sendMessage (group status) returned no message key — send likely did not go through.");
    err.code = "SEND_FAILED";
    throw err;
  }
  // Billed separately from ordinary bot messages (see config.js
  // USAGE_PRICE_PER_STATUS_POST on the wabot/billing side) — same accrual
  // ledger mechanism, just its own counter so it isn't priced like a
  // ₦2 welcome/warning message.
  usageStore.increment(id, { statusPosts: 1 }).catch(() => {});
  console.log(`[${id}][group-status] OK group=${groupId} msgId=${result.key.id}`);
  return { id: result.key.id };
}

// Shared by sendGroupMessage/sendChannelMessage. If imageUrl looks like a
// valid http(s) URL, downloads it ourselves and sends it as an image with
// `text` as its caption. We fetch the bytes ourselves (rather than handing
// Baileys the bare URL via { image: { url } }) because Baileys' own fetch
// sends no special headers, and hosts like imgbb hotlink-block bare
// requests like that (returns 404) — the same reason this project already
// has an /api/image-proxy route with a spoofed User-Agent/Referer for imgbb.
// On any failure to fetch/send the image, falls back to a plain text
// message so the ad still goes out rather than silently disappearing.
async function sendMessageWithOptionalImage(sock, jid, text, imageUrl, id) {
  const cleanUrl = typeof imageUrl === "string" ? imageUrl.trim() : "";
  const hasImage = /^https?:\/\//i.test(cleanUrl);
  if (hasImage) {
    try {
      console.log(`[${id}][ad-hub send] fetching image: ${cleanUrl}`);
      const imgRes = await fetch(cleanUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://imgbb.com/",
          "Accept": "image/webp,image/apng,image/*,*/*;q=0.8"
        }
      });
      if (!imgRes.ok) {
        throw new Error(`image host returned ${imgRes.status} for ${cleanUrl}`);
      }
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      const result = await sock.sendMessage(jid, { image: buffer, caption: text });
      if (!result?.key?.id) {
        throw new Error("sendMessage (image) returned no message key");
      }
      return result;
    } catch (err) {
      console.error(`[${id}][ad-hub send] image send failed (${err.message}) — falling back to text-only for ${jid}`);
    }
  }
  const result = await sock.sendMessage(jid, { text });
  if (!result?.key?.id) {
    const err = new Error("sendMessage returned no message key — send likely did not go through.");
    err.code = "SEND_FAILED";
    throw err;
  }
  return result;
}

// Parses whatever the owner pasted (a full https://whatsapp.com/channel/<code>
// link, a bare invite code, or a raw <digits>@newsletter jid) into the
// {mode, key} pair sock.newsletterMetadata() expects.
function parseChannelInput(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (value.endsWith("@newsletter")) return { mode: "jid", key: value };
  const linkMatch = value.match(/whatsapp\.com\/channel\/([A-Za-z0-9]+)/i);
  if (linkMatch) return { mode: "invite", key: linkMatch[1] };
  // Bare invite code (no slashes/spaces) — anything else is unrecognized.
  if (/^[A-Za-z0-9]+$/.test(value)) return { mode: "invite", key: value };
  return null;
}

// Looks up a channel by invite link/code/jid and reports whether this
// account can post to it (must be OWNER or ADMIN — regular followers can't
// send).
//
// IMPORTANT: a lookup done via invite link/code (mode:"invite") hits
// WhatsApp's public "guest preview" of the channel — the same thing anyone
// gets from just clicking the link without joining. That endpoint doesn't
// check the requester's real relationship to the channel at all, so
// viewer_metadata.role comes back as "GUEST" even when the connected
// account is genuinely the channel's Owner or an Admin. This is why real
// admins were being told "You must be the Owner or an Admin" — the code
// only ever did the guest-preview lookup and trusted its role verbatim.
//
// The only way to get a truthful role is to look the channel up again by
// its jid once we're a known participant, which means following it first
// if we aren't already. That follow is not a side effect we're smuggling
// in — this account has to follow the channel to post there at all, so
// it happens regardless once linking succeeds.
async function lookupChannel(id, rawInput) {
  const runtime = liveAccounts.get(id);
  assertSendable(runtime, id);
  const parsed = parseChannelInput(rawInput);
  if (!parsed) {
    const err = new Error("Couldn't recognize that as a WhatsApp Channel link, code, or ID.");
    err.code = "BAD_CHANNEL_INPUT";
    throw err;
  }

  let meta = await runtime.sock.newsletterMetadata(parsed.mode, parsed.key);
  if (!meta) {
    const err = new Error("Channel not found.");
    err.code = "CHANNEL_NOT_FOUND";
    throw err;
  }

  let role = meta.viewer_metadata?.role || meta.role || null;

  // Guest-preview role (or no role at all) from an invite/code lookup
  // doesn't tell us anything real — re-check by jid as a participant.
  if (parsed.mode !== "jid" && (!role || String(role).toUpperCase() === "GUEST")) {
    try {
      // Try the jid-based lookup FIRST, without following. If this account
      // already owns/admins/follows the channel — which is the normal case
      // for a promoter linking their OWN channel, since creating a channel
      // auto-follows you as its Owner — this alone already returns the
      // truthful role. Only fall back to newsletterFollow() below if that
      // truly isn't the case (channel not yet followed at all), since
      // calling newsletterFollow on a channel this account already follows
      // throws ("already following"/similar) — that error used to be
      // swallowed by the catch below with the role check never re-run,
      // which is why real Owners/Admins were being told they weren't.
      const jidMeta = await runtime.sock.newsletterMetadata("jid", meta.id);
      let jidRole = jidMeta?.viewer_metadata?.role || jidMeta?.role || null;
      if (jidMeta && jidRole && String(jidRole).toUpperCase() !== "GUEST") {
        meta = jidMeta;
        role = jidRole;
      } else {
        await runtime.sock.newsletterFollow(meta.id);
        const followedMeta = await runtime.sock.newsletterMetadata("jid", meta.id);
        if (followedMeta) {
          meta = followedMeta;
          role = followedMeta.viewer_metadata?.role || followedMeta.role || null;
        }
      }
    } catch (followErr) {
      console.warn(`[${id}][ad-hub lookupChannel] follow/re-check failed for ${meta.id}: ${followErr.message}`);
      // Fall through with whatever we already had from the guest preview —
      // canPost will correctly end up false rather than throwing here.
    }
  }

  const roleUpper = role ? String(role).toUpperCase() : null;
  const canPost = roleUpper === "OWNER" || roleUpper === "ADMIN";
  if (meta.id) runtime.channels.set(meta.id, { name: meta.thread_metadata?.name?.text || meta.name || runtime.channels.get(meta.id)?.name || "" });
  return {
    jid: meta.id,
    name: meta.thread_metadata?.name?.text || meta.name || "",
    description: meta.thread_metadata?.description?.text || "",
    subscriberCount: meta.thread_metadata?.subscribers_count ?? meta.subscribers_count ?? 0,
    pictureUrl: meta.thread_metadata?.picture?.url || null,
    role: roleUpper,
    canPost
  };
}

// Auto-detect: every WhatsApp Channel this account is known to follow (from
// runtime.channels, populated passively by the chat-sync listeners above),
// each resolved with its live role (Owner / Admin / Subscriber) so the UI
// can show what the promoter actually holds instead of asking them to paste
// a link. Resolves channels sequentially rather than in parallel — hammering
// newsletterMetadata for many channels at once is a good way to get
// rate-limited by WhatsApp.
async function listMyChannels(id) {
  const runtime = liveAccounts.get(id);
  assertSendable(runtime, id);
  const jids = [...runtime.channels.keys()];
  const results = [];
  for (const jid of jids) {
    try {
      const meta = await runtime.sock.newsletterMetadata("jid", jid);
      if (!meta) continue;
      const roleUpper = (meta.viewer_metadata?.role || meta.role || null);
      const role = roleUpper ? String(roleUpper).toUpperCase() : "SUBSCRIBER";
      results.push({
        jid: meta.id || jid,
        name: meta.thread_metadata?.name?.text || meta.name || runtime.channels.get(jid)?.name || "",
        subscriberCount: meta.thread_metadata?.subscribers_count ?? meta.subscribers_count ?? 0,
        pictureUrl: meta.thread_metadata?.picture?.url || null,
        role,
        canPost: role === "OWNER" || role === "ADMIN"
      });
    } catch (err) {
      console.warn(`[${id}][listMyChannels] couldn't resolve role for ${jid}: ${err.message}`);
    }
  }
  return results;
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
// ==================== Admin session maintenance ====================
// "Unused" sessions = rows in auth_data whose account_id has no matching
// row in `accounts` anymore — leftover login data for accounts that got
// removed outside the normal deleteAccount() flow (a crash mid-delete, a
// manual DB edit, restoring an old backup, etc). Ordinary operation never
// creates or touches these, so left alone they only ever accumulate.
//
// IMPORTANT: this only ever looks at/deletes auth_data rows with NO
// matching account. It never touches a session belonging to an account
// still listed in `accounts` — connected, disconnected, or paused — so it
// cannot disconnect a live bot no matter when it's run.
async function findOrphanedSessionAccountIds() {
  if (!isConfigured()) return [];
  const pool = getPool();
  const [rows] = await pool.query(`
    SELECT ad.account_id AS id, COUNT(*) AS row_count
    FROM auth_data ad
    LEFT JOIN accounts a ON a.id = ad.account_id
    WHERE a.id IS NULL
    GROUP BY ad.account_id
  `);
  return rows.map((r) => ({ id: r.id, rowCount: Number(r.row_count) }));
}

async function clearOrphanedSessions() {
  if (!isConfigured()) return { cleared: 0, accountIds: [] };
  const orphans = await findOrphanedSessionAccountIds();
  if (!orphans.length) return { cleared: 0, accountIds: [] };
  const pool = getPool();
  const ids = orphans.map((o) => o.id);
  await pool.query(`DELETE FROM auth_data WHERE account_id IN (${ids.map(() => "?").join(",")})`, ids);
  return { cleared: ids.length, accountIds: ids };
}

async function resumeAccountsFromDB() {
  if (!isConfigured()) return;
  const pool = getPool();
  const [rows] = await pool.query("SELECT id, label, phone_number, status, watermark, purpose FROM accounts");
  for (const row of rows) {
    liveAccounts.set(row.id, {
      label: row.label,
      status: row.status === "disconnected" || row.status === "paused" ? row.status : "connecting",
      qr: null,
      pairingCode: null,
      phoneNumber: row.phone_number,
      groups: new Map(),
      channels: new Map(), // see startAccount for what populates this
      pinnedWelcome: new Map(),
      reconnectAttempts: 0,
      paused: row.status === "paused",
      watermark: row.watermark !== 0,
      purpose: row.purpose === "ads" ? "ads" : "moderator"
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
  deleteAccount,
  findOrphanedSessionAccountIds,
  clearOrphanedSessions,
  sendGroupMessage,
  sendChannelMessage,
  sendGroupStatus,
  lookupChannel,
  listMyChannels
};
