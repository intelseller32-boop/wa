const path = require("path");
const express = require("express");
const QRCode = require("qrcode");
const accountManager = require("./accountManager");
const settingsStore = require("./settingsStore");
const { ADMIN_USERNAME, ADMIN_PASSWORD } = require("./config");

function requireAdmin(req, res, next) {
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
    error: { statusLabel: "Connection error", color: "#c62828", helper: "Something went wrong. Tap Reconnect to try again." }
  };
  return map[status] || { statusLabel: status, color: "#888", helper: "" };
}

function serializeAccount(a, runtime) {
  const status = runtime?.status || a.status;
  const groups = runtime
    ? Array.from(runtime.groups.entries()).map(([id, name]) => ({ id, name }))
    : [];
  return {
    id: a.id,
    label: a.label,
    phone_number: a.phone_number || runtime?.phoneNumber || "",
    status,
    ...describeStatus(status),
    hasQr: Boolean(runtime?.qr),
    pairingCode: runtime?.pairingCode || null,
    groupCount: groups.length,
    groups
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
    const { label, method, phone_number } = req.body || {};
    const id = await accountManager.createAccount(label);
    const phoneNumber = method === "pairing" ? String(phone_number || "").replace(/\D/g, "") : null;
    if (method === "pairing" && !phoneNumber) {
      return res.status(400).json({ error: "Phone number is required for pairing code login." });
    }
    accountManager.startAccount(id, phoneNumber).catch((err) => console.error("startAccount error:", err.message));
    res.json({ id });
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
    const { welcome_message, warning_message, kick_message, max_warnings, banned_words } = req.body || {};
    await settingsStore.updateSettings(id, groupId, {
      welcome_message,
      warning_message,
      kick_message,
      max_warnings: String(parseInt(max_warnings, 10) || 3),
      banned_words
    });
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
