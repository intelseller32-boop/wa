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

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function statusBadge(status) {
  const colors = {
    connected: "#2e7d32",
    connecting: "#f9a825",
    qr: "#f9a825",
    pairing: "#f9a825",
    disconnected: "#888",
    error: "#c62828"
  };
  const color = colors[status] || "#888";
  return `<span style="background:${color};color:#fff;padding:2px 10px;border-radius:12px;font-size:0.85em">${status}</span>`;
}

function page(body, autoRefresh) {
  return `
    <html>
      <head>
        ${autoRefresh ? '<meta http-equiv="refresh" content="5">' : ""}
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>WhatsApp Bot Dashboard</title>
        <style>
          body { font-family: sans-serif; background: #111; color: #eee; padding: 30px 16px; max-width: 700px; margin: auto; }
          h1 { font-size: 1.4em; }
          textarea, input, select {
            background: #1c1c1c; color: #eee; border: 1px solid #444; padding: 8px;
            margin: 6px 0; box-sizing: border-box; font-family: sans-serif; border-radius: 4px; width: 100%;
          }
          label { display: block; margin-top: 16px; font-weight: bold; }
          button {
            background: #2e7d32; color: #fff; border: none; padding: 10px 26px;
            border-radius: 4px; font-size: 1em; cursor: pointer; margin-top: 16px;
          }
          a { color: #8ab4f8; text-decoration: none; }
          .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 16px; margin: 12px 0; }
          .center { text-align: center; }
        </style>
      </head>
      <body>${body}</body>
    </html>
  `;
}

function startServer(port) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(requireAdmin);

  // ---- Dashboard: list accounts + add new ----
  app.get("/", async (req, res) => {
    const accounts = await accountManager.listAccounts();
    const rows = accounts
      .map(
        (a) => `
        <div class="card">
          <strong>${escapeHtml(a.label)}</strong> ${statusBadge(a.status)}
          ${a.phone_number ? `<br><small>${escapeHtml(a.phone_number)}</small>` : ""}
          <br><a href="/accounts/${a.id}">Manage &rarr;</a>
        </div>
      `
      )
      .join("") || "<p>No accounts yet. Add one below.</p>";

    res.send(
      page(
        `
        <h1>WhatsApp Bot Dashboard</h1>
        ${rows}
        <div class="card">
          <h2 style="font-size:1.1em">Add WhatsApp Account</h2>
          <form method="POST" action="/accounts">
            <label>Account label (just for you, e.g. "Main group")</label>
            <input type="text" name="label" placeholder="Main group" />

            <label>Login method</label>
            <select name="method" id="method" onchange="document.getElementById('phoneField').style.display = this.value === 'pairing' ? 'block' : 'none'">
              <option value="qr">Scan QR code</option>
              <option value="pairing">Enter phone number (pairing code)</option>
            </select>

            <div id="phoneField" style="display:none">
              <label>Phone number (digits only, with country code, no +)</label>
              <input type="text" name="phone_number" placeholder="2348121697423" />
            </div>

            <button type="submit">Add Account</button>
          </form>
        </div>
        `,
        true
      )
    );
  });

  app.post("/accounts", async (req, res) => {
    const { label, method, phone_number } = req.body;
    const id = await accountManager.createAccount(label);
    const phoneNumber = method === "pairing" ? (phone_number || "").replace(/\D/g, "") : null;
    accountManager.startAccount(id, phoneNumber).catch((err) => console.error("startAccount error:", err.message));
    res.redirect(`/accounts/${id}`);
  });

  // ---- Per-account status / QR / pairing / group list ----
  app.get("/accounts/:id", async (req, res) => {
    const runtime = accountManager.getAccountRuntime(req.params.id);
    if (!runtime) return res.status(404).send(page("<h1>Account not found</h1><a href='/'>Back</a>", false));

    let body = `<h1>${escapeHtml(runtime.label)} ${statusBadge(runtime.status)}</h1>`;

    if (runtime.status === "connected") {
      const groupEntries = Array.from(runtime.groups.entries());
      const groupList =
        groupEntries
          .map(
            ([gid, name]) => `
            <div class="card">
              ${escapeHtml(name)}
              <br><a href="/accounts/${req.params.id}/groups/${encodeURIComponent(gid)}">Edit settings for this group &rarr;</a>
            </div>
          `
          )
          .join("") || "<p>No groups found yet. Make sure this WhatsApp account is in at least one group, then refresh.</p>";

      body += `
        <p>✅ Connected. <a href="/accounts/${req.params.id}/groups/_default">Edit default settings (applies to all groups)</a></p>
        <p><a href="/accounts/${req.params.id}/refresh-groups">Refresh group list</a></p>
        <h2 style="font-size:1.1em">Groups</h2>
        ${groupList}
      `;
    } else if (runtime.status === "pairing" && runtime.pairingCode) {
      body += `
        <div class="card center">
          <p>Pairing Code</p>
          <p style="font-size:2.5em;letter-spacing:4px;font-weight:bold">${runtime.pairingCode}</p>
          <p>WhatsApp &gt; Settings &gt; Linked Devices &gt; Link a Device &gt;<br>"Link with phone number instead" &gt; enter this code</p>
        </div>
      `;
    } else if (runtime.status === "qr" && runtime.qr) {
      body += `
        <div class="card center">
          <p>Scan this QR code</p>
          <img src="/accounts/${req.params.id}/qr.png" style="width:280px;height:280px" />
          <p>WhatsApp &gt; Settings &gt; Linked Devices &gt; Link a Device &gt; Scan this code</p>
        </div>
      `;
    } else if (runtime.status === "error" || runtime.status === "disconnected") {
      body += `<p>This account is disconnected. <a href="/accounts/${req.params.id}/reconnect">Try reconnecting</a></p>`;
    } else {
      body += `<p>Connecting...</p>`;
    }

    body += `<p><a href="/">&larr; All accounts</a></p>`;
    res.send(page(body, runtime.status !== "connected"));
  });

  app.get("/accounts/:id/qr.png", async (req, res) => {
    const runtime = accountManager.getAccountRuntime(req.params.id);
    if (!runtime?.qr) return res.status(404).send("No QR available right now.");
    res.setHeader("Content-Type", "image/png");
    QRCode.toFileStream(res, runtime.qr, { width: 320, margin: 2 });
  });

  app.get("/accounts/:id/refresh-groups", async (req, res) => {
    await accountManager.refreshGroups(req.params.id);
    res.redirect(`/accounts/${req.params.id}`);
  });

  app.get("/accounts/:id/reconnect", async (req, res) => {
    accountManager.startAccount(req.params.id).catch((err) => console.error("reconnect error:", err.message));
    res.redirect(`/accounts/${req.params.id}`);
  });

  // ---- Per-group (or account default) settings editor ----
  app.get("/accounts/:id/groups/:groupId", async (req, res) => {
    const { id, groupId } = req.params;
    const runtime = accountManager.getAccountRuntime(id);
    const groupName = groupId === "_default" ? "Default (all groups)" : runtime?.groups.get(groupId) || groupId;
    const settings = await settingsStore.getSettings(id, groupId);
    const saved = req.query.saved ? `<p style="color:#8f8">✅ Settings saved.</p>` : "";

    res.send(
      page(
        `
        <h1>${escapeHtml(groupName)}</h1>
        ${saved}
        <form method="POST" action="/accounts/${id}/groups/${encodeURIComponent(groupId)}">
          <label>Welcome message (use {user} for the mention)</label>
          <textarea name="welcome_message" rows="2">${escapeHtml(settings.welcome_message)}</textarea>

          <label>Warning message (use {user}, {count}, {max})</label>
          <textarea name="warning_message" rows="2">${escapeHtml(settings.warning_message)}</textarea>

          <label>Kick message (use {user}, {max})</label>
          <textarea name="kick_message" rows="2">${escapeHtml(settings.kick_message)}</textarea>

          <label>Max warnings before removal</label>
          <input type="number" name="max_warnings" min="1" value="${escapeHtml(settings.max_warnings)}" />

          <label>Banned words (one per line)</label>
          <textarea name="banned_words" rows="8">${escapeHtml(settings.banned_words)}</textarea>

          <button type="submit">Save Settings</button>
        </form>
        <p><a href="/accounts/${id}">&larr; Back to account</a></p>
        `,
        false
      )
    );
  });

  app.post("/accounts/:id/groups/:groupId", async (req, res) => {
    const { id, groupId } = req.params;
    const { welcome_message, warning_message, kick_message, max_warnings, banned_words } = req.body;
    await settingsStore.updateSettings(id, groupId, {
      welcome_message,
      warning_message,
      kick_message,
      max_warnings: String(parseInt(max_warnings, 10) || 3),
      banned_words
    });
    res.redirect(`/accounts/${id}/groups/${encodeURIComponent(groupId)}?saved=1`);
  });

  app.listen(port, "0.0.0.0", () => {
    console.log(`Dashboard listening on port ${port}`);
  });
}

module.exports = { startServer };
