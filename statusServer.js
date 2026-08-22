const path = require("path");
const express = require("express");
const QRCode = require("qrcode");
const accountManager = require("./accountManager");
const settingsStore = require("./settingsStore");
const usageStore = require("./usageStore");
const autoReplyStore = require("./autoReplyStore");
const dmAutoReplyStore = require("./dmAutoReplyStore");
const dmVariableStore = require("./dmVariableStore");
const dmGreetingStore = require("./dmGreetingStore");
const { ADMIN_USERNAME, ADMIN_PASSWORD, WABOT_API_KEY } = require("./config");

function requireAdmin(req, res, next) {
  // Server-to-server calls (e.g. another app's backend) authenticate with a
  // static API key instead of the human dashboard login. Checked first and
  // independently of ADMIN_PASSWORD being set, so the API still works even
  // on a deployment that has disabled the human dashboard.
  if (WABOT_API_KEY && req.headers["x-api-key"] === WABOT_API_KEY) {
    return next();
  }
  if (!ADMIN_PASSWORD) {
    return res
      .status(503)
      .send("Dashboard disabled: set the ADMIN_PASSWORD environment variable on Railway to enable it.");
  }
  const header = req.headers.authorization || "";
  const b64 = header.split(" ")[1] || "";
  const [login, password] = Buffer.from(b64, "base64").toString().split(":");
  if (login === ADMIN_USERNAME && password === ADMIN_PASSWORD) return next();
  res.set("WWW-Authenticate", 'Basic realm="Bot Dashboard"');
  return res.status(401).send("Authentication required.");
}

// Friendly status info shown in the UI instead of raw internal status codes.
function describeStatus(status) {
  const map = {
    connecting: { statusLabel: "Connecting…", color: "#f9a825", helper: "This can take a few seconds." },
    qr: { statusLabel: "Waiting for QR scan", color: "#f9a825", helper: "Scan the code below with WhatsApp." },
    pairing: { statusLabel: "Waiting for pairing code", color: "#f9a825", helper: "Enter the code below in WhatsApp." },
    connected: { statusLabel: "Connected", color: "#2e7d32", helper: "This account is live and moderating its groups." },
    disconnected: { statusLabel: "Disconnected", color: "#888", helper: "Tap Reconnect to bring it back online." },
    error: { statusLabel: "Connection error", color: "#c62828", helper: "Something went wrong. Tap Reconnect to try again." },
    paused: { statusLabel: "Paused", color: "#888", helper: "Paused until the plan is renewed." }
  };
  return map[status] || { statusLabel: status, color: "#888", helper: "" };
}

function serializeAccount(a, runtime) {
  const status = runtime?.status || a.status;
  const groups = runtime
    ? Array.from(runtime.groups.entries()).map(([id, name]) => ({ id, name }))
    : [];
  const base = describeStatus(status);
  return {
    id: a.id,
    label: a.label,
    phone_number: a.phone_number || runtime?.phoneNumber || "",
    status,
    ...base,
    helper: runtime?.lastError || base.helper,
    hasQr: Boolean(runtime?.qr),
    pairingCode: runtime?.pairingCode || null,
    groupCount: groups.length,
    groups,
    watermark: runtime?.watermark !== false,
    purpose: runtime?.purpose === "ads" ? "ads" : "moderator"
  };
}

function startServer(port) {
  const app = express();
  app.use(express.json());
  app.use(requireAdmin);

  // ---- JSON API ----

  app.get("/api/accounts", async (req, res) => {
    const accounts = await accountManager.listAccounts();
    res.json(accounts.map((a) => serializeAccount(a, accountManager.getAccountRuntime(a.id))));
  });

  app.get("/api/accounts/:id", async (req, res) => {
    const runtime = accountManager.getAccountRuntime(req.params.id);
    if (!runtime) return res.status(404).json({ error: "Account not found" });
    res.json(serializeAccount({ id: req.params.id, label: runtime.label }, runtime));
  });

  app.post("/api/accounts", async (req, res) => {
    const { label, method, phone_number, watermark, purpose } = req.body || {};
    const id = await accountManager.createAccount(label, watermark !== false, purpose === "ads" ? "ads" : "moderator");
    const phoneNumber = method === "pairing" ? String(phone_number || "").replace(/\D/g, "") : null;
    if (method === "pairing" && !phoneNumber) {
      return res.status(400).json({ error: "Phone number is required for pairing code login." });
    }
    accountManager.startAccount(id, phoneNumber).catch((err) => console.error("startAccount error:", err.message));
    res.json({ id });
  });

  // Flips the watermark on/off for an existing account — called by an
  // external billing layer whenever the owner's premium status changes.
  app.post("/api/accounts/:id/watermark", async (req, res) => {
    const { watermark } = req.body || {};
    const result = await accountManager.setWatermark(req.params.id, watermark);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  });

  app.delete("/api/accounts/:id", async (req, res) => {
    await accountManager.deleteAccount(req.params.id);
    res.json({ ok: true });
  });

  app.post("/api/accounts/:id/reconnect", async (req, res) => {
    const runtime = accountManager.getAccountRuntime(req.params.id);
    if (!runtime) return res.status(404).json({ error: "Account not found" });
    accountManager.startAccount(req.params.id, runtime.phoneNumber).catch((err) =>
      console.error("reconnect error:", err.message)
    );
    res.json({ ok: true });
  });

  // Stops the connection without deleting its session — called by an
  // external billing layer (e.g. a marketplace app) when a plan lapses.
  // Resuming later (reconnect) does not require a new QR/pairing scan.
  app.post("/api/accounts/:id/pause", async (req, res) => {
    const result = await accountManager.pauseAccount(req.params.id);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  });

  app.post("/api/accounts/:id/refresh-groups", async (req, res) => {
    await accountManager.refreshGroups(req.params.id);
    const runtime = accountManager.getAccountRuntime(req.params.id);
    const groups = runtime ? Array.from(runtime.groups.entries()).map(([id, name]) => ({ id, name })) : [];
    res.json({ groups });
  });

  // ── Ad-Hub: group + channel posting ──
  // Used by the marketplace's ad-hub module to post scheduled/instant ads.
  // wa-main just sends whatever text it's given; the caller composes the
  // ad text (footer, link, etc.) itself.

  // Groups the account is already a member of are listed via the existing
  // GET /api/accounts/:id (its `groups` field) — no separate route needed.

  app.post("/api/accounts/:id/groups/:groupId/send", async (req, res) => {
    const { id, groupId } = req.params;
    const text = String(req.body?.text || "").trim();
    const imageUrl = req.body?.imageUrl ? String(req.body.imageUrl).trim() : "";
    // Optional: [{ text, url }, ...] — real tappable CTA buttons (e.g. a
    // fixed "Learn more" plus the advertiser's own custom button text).
    // Validated/cleaned again inside sendMessageWithOptionalImage, so a
    // malformed entry here just gets dropped rather than breaking the send.
    const buttons = Array.isArray(req.body?.buttons) ? req.body.buttons : undefined;
    if (!text) return res.status(400).json({ error: "text is required" });
    try {
      const result = await accountManager.sendGroupMessage(id, groupId, text, imageUrl, buttons);
      res.json({ ok: true, messageId: result.id });
    } catch (err) {
      console.error(`[${id}] ad send to group ${groupId} failed:`, err.message);
      const status = err.code === "NOT_CONNECTED" ? 409 : err.code === "NOT_A_MEMBER" ? 404 : 500;
      res.status(status).json({ ok: false, error: err.message, code: err.code });
    }
  });

  // Real WhatsApp "group status" (native beta feature) — visible only to
  // the group's members, disappears after 24h. Distinct from the ordinary
  // group message endpoint above. body: { kind: "text"|"image"|"video",
  // text?, mediaUrl?, caption?, backgroundColor?, font? }
  app.post("/api/accounts/:id/groups/:groupId/status", async (req, res) => {
    const { id, groupId } = req.params;
    const { kind, text, mediaUrl, caption, backgroundColor, font } = req.body || {};
    if (!["text", "image", "video"].includes(kind)) {
      return res.status(400).json({ ok: false, error: 'kind must be "text", "image", or "video"' });
    }
    try {
      const result = await accountManager.sendGroupStatus(id, groupId, {
        kind, text, mediaUrl, caption, backgroundColor, font
      });
      res.json({ ok: true, messageId: result.id });
    } catch (err) {
      console.error(`[${id}] group status send to ${groupId} failed:`, err.message);
      const status = err.code === "NOT_CONNECTED" ? 409
        : err.code === "NOT_A_MEMBER" ? 404
        : err.code === "BAD_INPUT" ? 400
        : 500;
      res.status(status).json({ ok: false, error: err.message, code: err.code });
    }
  });

  // Looks up a WhatsApp Channel by invite link/code/jid and reports whether
  // this account can post to it. Does NOT create an ad-hub link/DB row, but
  // it may follow the channel on WhatsApp as a side effect (see
  // accountManager.lookupChannel) — that's required to read this account's
  // true Owner/Admin role instead of the public guest-preview role.
  app.post("/api/accounts/:id/channels/lookup", async (req, res) => {
    const { id } = req.params;
    const input = req.body?.input;
    try {
      const channel = await accountManager.lookupChannel(id, input);
      res.json({ ok: true, channel });
    } catch (err) {
      console.error(`[${id}] channel lookup failed:`, err.message);
      const status = err.code === "NOT_CONNECTED" ? 409 : err.code === "BAD_CHANNEL_INPUT" ? 400 : 404;
      res.status(status).json({ ok: false, error: err.message, code: err.code });
    }
  });

  // Auto-detect: every WhatsApp Channel this account is known to follow,
  // each with its live role (Owner/Admin/Subscriber) so the caller can tell
  // which ones this account can actually post ads to. See
  // accountManager.listMyChannels for how the channel list itself is
  // collected (passively, from Baileys' chat sync — no link/code needed).
  app.get("/api/accounts/:id/channels/mine", async (req, res) => {
    const { id } = req.params;
    try {
      const channels = await accountManager.listMyChannels(id);
      res.json({ ok: true, channels });
    } catch (err) {
      console.error(`[${id}] listMyChannels failed:`, err.message);
      const status = err.code === "NOT_CONNECTED" ? 409 : 500;
      res.status(status).json({ ok: false, error: err.message, code: err.code });
    }
  });

  app.post("/api/accounts/:id/channels/:channelId/send", async (req, res) => {
    const { id } = req.params;
    const channelId = decodeURIComponent(req.params.channelId);
    const text = String(req.body?.text || "").trim();
    const imageUrl = req.body?.imageUrl ? String(req.body.imageUrl).trim() : "";
    const buttons = Array.isArray(req.body?.buttons) ? req.body.buttons : undefined;
    if (!text) return res.status(400).json({ error: "text is required" });
    try {
      const result = await accountManager.sendChannelMessage(id, channelId, text, imageUrl, buttons);
      res.json({ ok: true, messageId: result.id });
    } catch (err) {
      console.error(`[${id}] ad send to channel ${channelId} failed:`, err.message);
      const status = err.code === "NOT_CONNECTED" ? 409 : 500;
      res.status(status).json({ ok: false, error: err.message, code: err.code });
    }
  });

  app.get("/api/accounts/:id/qr.png", async (req, res) => {
    const runtime = accountManager.getAccountRuntime(req.params.id);
    if (!runtime?.qr) return res.status(404).send("No QR available right now.");
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    QRCode.toFileStream(res, runtime.qr, { width: 320, margin: 2 });
  });

  app.get("/api/accounts/:id/groups/:groupId/settings", async (req, res) => {
    const { id, groupId } = req.params;
    const runtime = accountManager.getAccountRuntime(id);
    const groupName = groupId === "_default" ? "Default (all groups)" : runtime?.groups.get(groupId) || groupId;
    const settings = await settingsStore.getSettings(id, groupId);
    res.json({ groupName, settings });
  });

  app.post("/api/accounts/:id/groups/:groupId/settings", async (req, res) => {
    const { id, groupId } = req.params;
    const body = req.body || {};

    // The quick on/off toggle in the dashboard only sends `{ enabled }` —
    // it doesn't include the other fields (welcome_message, banned_words,
    // etc). Those come back `undefined` here. Previously we passed them
    // straight through to settingsStore.updateSettings(), which ran a MySQL
    // write per key — and mysql2 THROWS on an `undefined` bind param. That
    // throw was unhandled (no try/catch here), which crashes the whole
    // wa-main process on Node's unhandled-rejection behavior. Railway then
    // restarts the service, and if DATABASE_URL isn't set the in-memory
    // settings store resets to defaults — which is why a disabled group
    // would look "enabled" again after a reload.
    //
    // Fix: only include fields that were actually present in this request,
    // and only touch DB rows for keys that were sent — a partial toggle
    // payload should never wipe or crash on the fields it didn't include.
    const updates = {};
    if ("enabled" in body) updates.enabled = body.enabled === "0" ? "0" : "1";
    if ("welcome_enabled" in body) updates.welcome_enabled = body.welcome_enabled === "0" ? "0" : "1";
    if ("welcome_message" in body) updates.welcome_message = body.welcome_message;
    if ("warning_message" in body) updates.warning_message = body.warning_message;
    if ("kick_message" in body) updates.kick_message = body.kick_message;
    if ("max_warnings" in body) updates.max_warnings = String(parseInt(body.max_warnings, 10) || 3);
    if ("banned_words" in body) updates.banned_words = body.banned_words;
    if ("allowed_urls" in body) updates.allowed_urls = body.allowed_urls || "";
    if ("ban_links" in body) updates.ban_links = body.ban_links === "0" ? "0" : "1";
    if ("ban_stickers" in body) updates.ban_stickers = body.ban_stickers === "1" ? "1" : "0";
    if ("ban_status_mentions" in body) updates.ban_status_mentions = body.ban_status_mentions === "1" ? "1" : "0";
    if ("respect_admins" in body) updates.respect_admins = body.respect_admins === "0" ? "0" : "1";

    try {
      await settingsStore.updateSettings(id, groupId, updates);
      res.json({ ok: true });
    } catch (err) {
      console.error(`[${id}] failed to update group settings:`, err.message);
      res.status(500).json({ error: "Failed to save group settings." });
    }
  });

  // Read-only, doesn't mark anything as billed — safe to poll for display.
  app.get("/api/accounts/:id/usage", async (req, res) => {
    try {
      const usage = await usageStore.peek(req.params.id);
      res.json(usage);
    } catch (err) {
      console.error(`[${req.params.id}] failed to read usage:`, err.message);
      res.status(500).json({ error: "Failed to read usage." });
    }
  });

  // Returns the unbilled delta AND marks it as billed. This is meant to be
  // called by wabot's usage-sync job, not the dashboard UI — calling it
  // twice will only return the new usage the second time.
  app.post("/api/accounts/:id/usage/pull", async (req, res) => {
    try {
      const usage = await usageStore.pull(req.params.id);
      res.json(usage);
    } catch (err) {
      console.error(`[${req.params.id}] failed to pull usage:`, err.message);
      res.status(500).json({ error: "Failed to pull usage." });
    }
  });

  app.get("/api/accounts/:id/groups/:groupId/auto-replies", async (req, res) => {
    const { id, groupId } = req.params;
    const rules = await autoReplyStore.listAutoReplies(id, groupId);
    res.json({ rules });
  });

  app.post("/api/accounts/:id/groups/:groupId/auto-replies", async (req, res) => {
    const { id, groupId } = req.params;
    const { keyword, reply_text, match_type } = req.body || {};
    if (!keyword || !keyword.trim()) return res.status(400).json({ error: "Keyword is required." });
    if (!reply_text || !reply_text.trim()) return res.status(400).json({ error: "Reply text is required." });
    const rule = await autoReplyStore.addAutoReply(
      id,
      groupId,
      keyword.trim(),
      reply_text.trim(),
      match_type === "exact" ? "exact" : "contains"
    );
    res.json({ rule });
  });

  app.put("/api/accounts/:id/groups/:groupId/auto-replies/:ruleId", async (req, res) => {
    const { id, ruleId } = req.params;
    const { keyword, reply_text, match_type } = req.body || {};
    if (!keyword || !keyword.trim()) return res.status(400).json({ error: "Keyword is required." });
    if (!reply_text || !reply_text.trim()) return res.status(400).json({ error: "Reply text is required." });
    const rule = await autoReplyStore.updateAutoReply(
      id,
      ruleId,
      keyword.trim(),
      reply_text.trim(),
      match_type === "exact" ? "exact" : "contains"
    );
    if (!rule) return res.status(404).json({ error: "Auto-reply not found." });
    res.json({ rule });
  });

  app.delete("/api/accounts/:id/groups/:groupId/auto-replies/:ruleId", async (req, res) => {
    const { id, ruleId } = req.params;
    await autoReplyStore.deleteAutoReply(id, ruleId);
    res.json({ ok: true });
  });

  // ==================== Personal chat (1:1 DM) ====================

  app.get("/api/accounts/:id/dm/auto-replies", async (req, res) => {
    const rules = await dmAutoReplyStore.listAutoReplies(req.params.id);
    res.json({ rules });
  });

  app.post("/api/accounts/:id/dm/auto-replies", async (req, res) => {
    const { id } = req.params;
    const { keyword, reply_text, match_type } = req.body || {};
    if (!keyword || !keyword.trim()) return res.status(400).json({ error: "Keyword is required." });
    if (!reply_text || !reply_text.trim()) return res.status(400).json({ error: "Reply text is required." });
    const rule = await dmAutoReplyStore.addAutoReply(
      id,
      keyword.trim(),
      reply_text.trim(),
      match_type === "exact" ? "exact" : "contains"
    );
    res.json({ rule });
  });

  app.put("/api/accounts/:id/dm/auto-replies/:ruleId", async (req, res) => {
    const { id, ruleId } = req.params;
    const { keyword, reply_text, match_type } = req.body || {};
    if (!keyword || !keyword.trim()) return res.status(400).json({ error: "Keyword is required." });
    if (!reply_text || !reply_text.trim()) return res.status(400).json({ error: "Reply text is required." });
    const rule = await dmAutoReplyStore.updateAutoReply(
      id,
      ruleId,
      keyword.trim(),
      reply_text.trim(),
      match_type === "exact" ? "exact" : "contains"
    );
    if (!rule) return res.status(404).json({ error: "Auto-reply not found." });
    res.json({ rule });
  });

  app.delete("/api/accounts/:id/dm/auto-replies/:ruleId", async (req, res) => {
    await dmAutoReplyStore.deleteAutoReply(req.params.id, req.params.ruleId);
    res.json({ ok: true });
  });

  // Custom variables — returned as { variables: [{name, value}] } (array,
  // not the raw map fillTemplate uses internally) so the dashboard can
  // render/order them predictably.
  app.get("/api/accounts/:id/dm/variables", async (req, res) => {
    const map = await dmVariableStore.listVariables(req.params.id);
    res.json({ variables: Object.entries(map).map(([name, value]) => ({ name, value })) });
  });

  app.post("/api/accounts/:id/dm/variables", async (req, res) => {
    const { name, value } = req.body || {};
    try {
      const saved = await dmVariableStore.setVariable(req.params.id, name, value);
      res.json({ variable: saved });
    } catch (err) {
      res.status(400).json({ error: err.message, code: err.code });
    }
  });

  app.delete("/api/accounts/:id/dm/variables/:name", async (req, res) => {
    await dmVariableStore.deleteVariable(req.params.id, req.params.name);
    res.json({ ok: true });
  });

  // First-message greeting — sent once per contact (see dmGreetingStore for
  // the re-greet-after-silence logic).
  app.get("/api/accounts/:id/dm/greeting", async (req, res) => {
    const settings = await dmGreetingStore.getSettings(req.params.id);
    res.json(settings);
  });

  app.post("/api/accounts/:id/dm/greeting", async (req, res) => {
    const { enabled, message, resetAfterDays } = req.body || {};
    const settings = await dmGreetingStore.updateSettings(req.params.id, { enabled, message, resetAfterDays });
    res.json(settings);
  });

  // ---- Admin: session maintenance ----

  // Read-only preview of orphaned sessions (auth_data rows with no matching
  // account row) — safe to call anytime, never deletes anything by itself.
  app.get("/api/admin/orphaned-sessions", async (req, res) => {
    try {
      const accounts = await accountManager.findOrphanedSessionAccountIds();
      res.json({ count: accounts.length, accounts });
    } catch (err) {
      console.error("Failed to list orphaned sessions:", err.message);
      res.status(500).json({ error: "Failed to check for orphaned sessions." });
    }
  });

  // Permanently deletes ONLY auth_data rows that have no matching account —
  // never touches a session belonging to an account still in the `accounts`
  // table, connected or not, so this can't disconnect a live bot. Still a
  // hard, un-undoable delete, so it requires an explicit { confirm: true }
  // in the body rather than firing off a bare POST.
  app.post("/api/admin/clear-orphaned-sessions", async (req, res) => {
    if (req.body?.confirm !== true) {
      return res.status(400).json({ error: "Pass { confirm: true } to proceed with this permanent action." });
    }
    try {
      const result = await accountManager.clearOrphanedSessions();
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("Failed to clear orphaned sessions:", err.message);
      res.status(500).json({ error: "Failed to clear orphaned sessions." });
    }
  });

  // ---- Single-page dashboard (no more full-page reloads) ----
  app.use(express.static(path.join(__dirname, "public")));
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  app.listen(port, "0.0.0.0", () => {
    console.log(`Dashboard listening on port ${port}`);
  });
}

module.exports = { startServer };
