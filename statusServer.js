const path = require("path");
const express = require("express");
const QRCode = require("qrcode");
const accountManager = require("./accountManager");
const settingsStore = require("./settingsStore");
const usageStore = require("./usageStore");
const autoReplyStore = require("./autoReplyStore");
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
    watermark: runtime?.watermark !== false
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
    const { label, method, phone_number, watermark } = req.body || {};
    const id = await accountManager.createAccount(label, watermark !== false);
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
