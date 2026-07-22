const app = document.getElementById("app");

// ---- tiny hash router: #/ , #/accounts/:id , #/accounts/:id/groups/:groupId
function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/").filter(Boolean);
  if (parts[0] === "accounts" && parts[1] && parts[2] === "groups" && parts[3]) {
    return { view: "group", accountId: parts[1], groupId: decodeURIComponent(parts[3]) };
  }
  if (parts[0] === "accounts" && parts[1]) {
    return { view: "account", accountId: parts[1] };
  }
  return { view: "list" };
}

window.addEventListener("hashchange", render);
window.addEventListener("DOMContentLoaded", render);

let pollTimer = null;
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  if (!res.ok) {
    let msg = "Something went wrong.";
    try {
      const body = await res.json();
      msg = body.error || msg;
    } catch (e) {}
    throw new Error(msg);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : null;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

async function render() {
  stopPolling();
  const route = currentRoute();
  if (route.view === "list") return renderList();
  if (route.view === "account") return renderAccount(route.accountId);
  if (route.view === "group") return renderGroupSettings(route.accountId, route.groupId);
}

// ---------------- Accounts list ----------------

async function renderList() {
  app.innerHTML = `
    <div class="topbar"><h1>WhatsApp Accounts</h1></div>
    <div id="list-body" class="center" style="padding:30px 0;color:var(--muted)">Loading…</div>
    <button class="fab" id="add-btn">+</button>
  `;
  document.getElementById("add-btn").onclick = openAddModal;
  await refreshList();
  pollTimer = setInterval(refreshList, 4000);
}

async function refreshList() {
  let accounts;
  try {
    accounts = await api("/api/accounts");
  } catch (e) {
    return;
  }
  const body = document.getElementById("list-body");
  if (!body) return;
  if (!accounts.length) {
    body.innerHTML = `<div class="empty">No WhatsApp accounts yet.<br>Tap + to add your first one.</div>`;
    return;
  }
  body.innerHTML = accounts
    .map(
      (a) => `
      <div class="card account-card" data-id="${a.id}">
        <div class="account-info">
          <div class="name">${escapeHtml(a.label)}</div>
          <div class="sub">${a.phone_number ? escapeHtml(a.phone_number) + " · " : ""}${a.status === "connected" ? a.groupCount + " group" + (a.groupCount === 1 ? "" : "s") : a.statusLabel}</div>
        </div>
        ${statusBadge(a)}
        <span class="chevron">›</span>
      </div>
    `
    )
    .join("");
  body.querySelectorAll(".account-card").forEach((el) => {
    el.onclick = () => (location.hash = `#/accounts/${el.dataset.id}`);
  });
}

function statusBadge(a) {
  return `<span class="badge" style="background:${a.color}"><span class="dot"></span>${escapeHtml(a.statusLabel)}</span>`;
}

// ---------------- Add account modal ----------------

function openAddModal() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <h2>Add WhatsApp Account</h2>
      <form id="add-form">
        <label>Label (just for you)</label>
        <input type="text" name="label" placeholder="e.g. Main group" />

        <label>How do you want to log in?</label>
        <div class="method-choice">
          <label id="choice-qr" class="active">
            <input type="radio" name="method" value="qr" checked />
            <span>Scan QR code</span>
          </label>
          <label id="choice-pairing">
            <input type="radio" name="method" value="pairing" />
            <span>Phone number</span>
          </label>
        </div>

        <div id="phone-field" style="display:none">
          <label>Phone number (with country code, no + or spaces)</label>
          <input type="text" name="phone_number" placeholder="2348121697423" />
        </div>

        <div class="modal-actions">
          <button type="button" class="secondary" id="cancel-btn">Cancel</button>
          <button type="submit" id="submit-btn">Add Account</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);

  const radios = overlay.querySelectorAll('input[name="method"]');
  radios.forEach((r) =>
    r.addEventListener("change", () => {
      overlay.querySelector("#phone-field").style.display = r.value === "pairing" && r.checked ? "block" : "none";
      overlay.querySelector("#choice-qr").classList.toggle("active", overlay.querySelector('input[value="qr"]').checked);
      overlay.querySelector("#choice-pairing").classList.toggle(
        "active",
        overlay.querySelector('input[value="pairing"]').checked
      );
    })
  );

  overlay.querySelector("#cancel-btn").onclick = () => overlay.remove();
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  overlay.querySelector("#add-form").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const label = fd.get("label") || "WhatsApp Account";
    const method = fd.get("method");
    const phone_number = fd.get("phone_number");
    const submitBtn = overlay.querySelector("#submit-btn");
    submitBtn.disabled = true;
    submitBtn.textContent = "Adding…";
    try {
      const { id } = await api("/api/accounts", {
        method: "POST",
        body: JSON.stringify({ label, method, phone_number })
      });
      overlay.remove();
      location.hash = `#/accounts/${id}`;
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Add Account";
      toast(err.message);
    }
  };
}

// ---------------- Account detail ----------------

async function renderAccount(id) {
  app.innerHTML = `
    <a class="back-link" id="back-link">‹ All accounts</a>
    <div id="account-body" class="center" style="padding:30px 0;color:var(--muted)">Loading…</div>
  `;
  document.getElementById("back-link").onclick = () => (location.hash = "#/");
  await refreshAccount(id);
  pollTimer = setInterval(() => refreshAccount(id), 2500);
}

async function refreshAccount(id) {
  let a;
  try {
    a = await api(`/api/accounts/${id}`);
  } catch (e) {
    stopPolling();
    const body = document.getElementById("account-body");
    if (body) body.innerHTML = `<div class="empty">This account no longer exists.</div>`;
    return;
  }
  const body = document.getElementById("account-body");
  if (!body) return;

  let inner = `<div class="topbar"><h1>${escapeHtml(a.label)}</h1>${statusBadge(a)}</div>`;

  if (a.status === "connected") {
    inner += `
      <div class="card">
        <div class="sub" style="color:var(--muted)">${a.phone_number ? escapeHtml(a.phone_number) : "Connected"}</div>
      </div>
      <div class="section-title">Groups (${a.groupCount})</div>
      <div class="card" id="groups-card">
        ${
          a.groups.length
            ? a.groups
                .map(
                  (g) => `
              <div class="group-row" data-gid="${escapeHtml(g.id)}">
                <span class="group-name">${escapeHtml(g.name)}</span>
                <span class="chevron">›</span>
              </div>
            `
                )
                .join("")
            : `<div class="empty">No groups found yet.<br>Make sure this WhatsApp account has joined at least one group, then tap Refresh below.</div>`
        }
      </div>
      <button class="secondary full" id="refresh-groups-btn">Refresh group list</button>
      <button class="secondary full" style="margin-top:10px" id="default-settings-btn">Edit default settings (applies to all groups)</button>
      <button class="danger full" style="margin-top:22px" id="remove-btn">Remove this account</button>
    `;
  } else if (a.status === "pairing" && a.pairingCode) {
    inner += `
      <div class="card center">
        <p class="helper">${a.helper}</p>
        <div class="pairing-code">${escapeHtml(a.pairingCode)}</div>
        <div class="help-box">Open WhatsApp → Settings → Linked Devices → Link a Device → "Link with phone number instead" → enter this code.</div>
      </div>
      <button class="danger full" id="remove-btn">Remove this account</button>
    `;
  } else if (a.status === "qr" && a.hasQr) {
    inner += `
      <div class="card center qr-box">
        <p class="helper">${a.helper}</p>
        <img src="/api/accounts/${id}/qr.png?t=${Date.now()}" />
        <div class="help-box">Open WhatsApp → Settings → Linked Devices → Link a Device → Scan this code.</div>
      </div>
      <button class="danger full" id="remove-btn">Remove this account</button>
    `;
  } else if (a.status === "disconnected" || a.status === "error") {
    inner += `
      <div class="card center">
        <p class="helper">${a.helper}</p>
        <button class="full" id="reconnect-btn">Reconnect</button>
      </div>
      <button class="danger full" style="margin-top:14px" id="remove-btn">Remove this account</button>
    `;
  } else {
    inner += `
      <div class="card center">
        <div class="spinner"></div>
        <p class="helper">${a.helper}</p>
      </div>
    `;
  }

  // Only replace DOM when content actually changed, to avoid flicker on the QR image etc.
  if (body.dataset.snapshot !== inner) {
    body.innerHTML = inner;
    body.dataset.snapshot = inner;
    wireAccountButtons(id);
  }
}

function wireAccountButtons(id) {
  const refreshBtn = document.getElementById("refresh-groups-btn");
  if (refreshBtn) {
    refreshBtn.onclick = async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = "Refreshing…";
      try {
        await api(`/api/accounts/${id}/refresh-groups`, { method: "POST" });
        toast("Group list refreshed");
      } catch (e) {
        toast(e.message);
      }
      refreshBtn.disabled = false;
      refreshBtn.textContent = "Refresh group list";
      const body = document.getElementById("account-body");
      if (body) body.dataset.snapshot = "";
      refreshAccount(id);
    };
  }

  const reconnectBtn = document.getElementById("reconnect-btn");
  if (reconnectBtn) {
    reconnectBtn.onclick = async () => {
      reconnectBtn.disabled = true;
      reconnectBtn.textContent = "Reconnecting…";
      try {
        await api(`/api/accounts/${id}/reconnect`, { method: "POST" });
      } catch (e) {
        toast(e.message);
      }
      const body = document.getElementById("account-body");
      if (body) body.dataset.snapshot = "";
      refreshAccount(id);
    };
  }

  const removeBtn = document.getElementById("remove-btn");
  if (removeBtn) {
    removeBtn.onclick = async () => {
      if (!confirm("Remove this WhatsApp account? It will stop moderating its groups.")) return;
      try {
        await api(`/api/accounts/${id}`, { method: "DELETE" });
        location.hash = "#/";
      } catch (e) {
        toast(e.message);
      }
    };
  }

  const defaultBtn = document.getElementById("default-settings-btn");
  if (defaultBtn) {
    defaultBtn.onclick = () => (location.hash = `#/accounts/${id}/groups/_default`);
  }

  document.querySelectorAll(".group-row").forEach((row) => {
    row.onclick = () => (location.hash = `#/accounts/${id}/groups/${encodeURIComponent(row.dataset.gid)}`);
  });
}

// ---------------- Group settings ----------------

async function renderGroupSettings(accountId, groupId) {
  app.innerHTML = `
    <a class="back-link" id="back-link">‹ Back to account</a>
    <div id="group-body" class="center" style="padding:30px 0;color:var(--muted)">Loading…</div>
  `;
  document.getElementById("back-link").onclick = () => (location.hash = `#/accounts/${accountId}`);

  let data;
  try {
    data = await api(`/api/accounts/${accountId}/groups/${encodeURIComponent(groupId)}/settings`);
  } catch (e) {
    document.getElementById("group-body").innerHTML = `<div class="empty">Could not load settings.</div>`;
    return;
  }

  const s = data.settings;
  document.getElementById("group-body").innerHTML = `
    <div class="topbar"><h1>${escapeHtml(data.groupName)}</h1></div>

    <form id="settings-form" style="margin-top:22px">
      <label>Bot status in this group</label>
      <select name="enabled">
        <option value="1" ${s.enabled !== "0" ? "selected" : ""}>Enabled — welcome, moderation & auto-reply are active</option>
        <option value="0" ${s.enabled === "0" ? "selected" : ""}>Disabled — bot stays in the group but does nothing</option>
      </select>

      <label>Welcome message (use {user} for the mention)</label>
      <textarea name="welcome_message" rows="3">${escapeHtml(s.welcome_message)}</textarea>

      <label>Warning message (use {user}, {count}, {max})</label>
      <textarea name="warning_message" rows="3">${escapeHtml(s.warning_message)}</textarea>

      <label>Kick message (use {user}, {max})</label>
      <textarea name="kick_message" rows="3">${escapeHtml(s.kick_message)}</textarea>

      <label>Max warnings before removal</label>
      <input type="number" name="max_warnings" min="1" value="${escapeHtml(s.max_warnings)}" />

      <label>Banned words (one per line)</label>
      <textarea name="banned_words" rows="8">${escapeHtml(s.banned_words)}</textarea>

      <label style="margin-top:14px">Always-allowed links (one per line — exempt even when link banning is on)</label>
      <textarea name="allowed_urls" rows="2" placeholder="e.g. yourdomain.com">${escapeHtml(s.allowed_urls || "")}</textarea>

      <label class="checkbox-row" style="display:flex;align-items:center;gap:8px;margin-top:14px">
        <input type="checkbox" name="ban_links" ${s.ban_links !== "0" ? "checked" : ""} />
        <span>Ban links in messages</span>
      </label>

      <label class="checkbox-row" style="display:flex;align-items:center;gap:8px;margin-top:8px">
        <input type="checkbox" name="ban_stickers" ${s.ban_stickers === "1" ? "checked" : ""} />
        <span>Ban stickers</span>
      </label>

      <label class="checkbox-row" style="display:flex;align-items:center;gap:8px;margin-top:8px">
        <input type="checkbox" name="ban_status_mentions" ${s.ban_status_mentions === "1" ? "checked" : ""} />
        <span>Treat status mentions as banned content (delete + warn if someone tags this group in their WhatsApp status)</span>
      </label>

      <label class="checkbox-row" style="display:flex;align-items:center;gap:8px;margin-top:8px">
        <input type="checkbox" name="respect_admins" ${s.respect_admins !== "0" ? "checked" : ""} />
        <span>Respect group admins (never warn or kick them)</span>
      </label>

      <button type="submit" class="full" style="margin-top:20px">Save Settings</button>
    </form>

    <div class="section-title" style="margin-top:28px">Auto-Reply Messages</div>
    <p class="helper" style="margin:0 0 12px">When a message contains one of these keywords, the bot replies automatically. Use {user} in the reply to mention whoever sent the message.</p>

    <form id="auto-reply-form" class="card" style="display:block">
      <input type="hidden" name="rule_id" value="" />
      <label>Keyword (e.g. hello)</label>
      <input type="text" name="keyword" placeholder="hello" required />

      <label>Match type</label>
      <select name="match_type">
        <option value="contains">Message contains this word</option>
        <option value="exact">Message is exactly this word</option>
      </select>

      <label>Auto-reply text (use {user} for the mention)</label>
      <textarea name="reply_text" rows="3" placeholder="Hi {user}! How can I help?" required></textarea>

      <div style="display:flex;gap:10px;margin-top:14px">
        <button type="submit" class="full" id="auto-reply-submit-btn">Add Auto-Reply</button>
        <button type="button" class="full secondary" id="auto-reply-cancel-btn" style="display:none">Cancel</button>
      </div>
    </form>

    <div id="auto-reply-list" style="margin-top:14px">Loading…</div>
  `;

  document.getElementById("settings-form").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    ["ban_links", "ban_stickers", "ban_status_mentions", "respect_admins"].forEach((field) => {
      const el = e.target.querySelector(`[name="${field}"]`);
      if (el) body[field] = el.checked ? "1" : "0";
    });
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      await api(`/api/accounts/${accountId}/groups/${encodeURIComponent(groupId)}/settings`, {
        method: "POST",
        body: JSON.stringify(body)
      });
      toast("Settings saved");
    } catch (err) {
      toast(err.message);
    }
    btn.disabled = false;
    btn.textContent = "Save Settings";
  };

  const autoReplyForm = document.getElementById("auto-reply-form");
  const cancelBtn = document.getElementById("auto-reply-cancel-btn");

  function resetAutoReplyForm() {
    autoReplyForm.reset();
    autoReplyForm.querySelector("[name=rule_id]").value = "";
    document.getElementById("auto-reply-submit-btn").textContent = "Add Auto-Reply";
    cancelBtn.style.display = "none";
  }

  cancelBtn.onclick = () => resetAutoReplyForm();

  autoReplyForm.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const { rule_id, ...body } = Object.fromEntries(fd.entries());
    const isEdit = !!rule_id;
    const btn = document.getElementById("auto-reply-submit-btn");
    btn.disabled = true;
    btn.textContent = isEdit ? "Saving…" : "Adding…";
    try {
      const url = isEdit
        ? `/api/accounts/${accountId}/groups/${encodeURIComponent(groupId)}/auto-replies/${rule_id}`
        : `/api/accounts/${accountId}/groups/${encodeURIComponent(groupId)}/auto-replies`;
      await api(url, {
        method: isEdit ? "PUT" : "POST",
        body: JSON.stringify(body)
      });
      resetAutoReplyForm();
      toast(isEdit ? "Auto-reply updated" : "Auto-reply added");
      await refreshAutoReplies(accountId, groupId);
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = isEdit ? "Save Changes" : "Add Auto-Reply";
    }
  };

  await refreshAutoReplies(accountId, groupId);
}

async function refreshAutoReplies(accountId, groupId) {
  const listEl = document.getElementById("auto-reply-list");
  if (!listEl) return;

  let rules;
  try {
    ({ rules } = await api(`/api/accounts/${accountId}/groups/${encodeURIComponent(groupId)}/auto-replies`));
  } catch (e) {
    listEl.innerHTML = `<div class="empty">Could not load auto-replies.</div>`;
    return;
  }

  if (!rules.length) {
    listEl.innerHTML = `<div class="empty">No auto-replies yet. Add one above.</div>`;
    return;
  }

  listEl.innerHTML = rules
    .map(
      (r) => `
      <div class="card" data-rid="${escapeHtml(r.id)}" style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div>
          <div class="name">${escapeHtml(r.keyword)} <span class="sub">(${r.match_type === "exact" ? "exact" : "contains"})</span></div>
          <div class="sub">${escapeHtml(r.reply_text)}</div>
        </div>
        <div style="display:flex;gap:8px">
          <button type="button" class="auto-reply-edit-btn" data-rid="${escapeHtml(r.id)}">Edit</button>
          <button type="button" class="danger auto-reply-delete-btn" data-rid="${escapeHtml(r.id)}">Delete</button>
        </div>
      </div>
    `
    )
    .join("");

  listEl.querySelectorAll(".auto-reply-edit-btn").forEach((btn) => {
    btn.onclick = () => {
      const rule = rules.find((r) => r.id === btn.dataset.rid);
      if (!rule) return;
      const form = document.getElementById("auto-reply-form");
      form.querySelector("[name=rule_id]").value = rule.id;
      form.querySelector("[name=keyword]").value = rule.keyword;
      form.querySelector("[name=match_type]").value = rule.match_type === "exact" ? "exact" : "contains";
      form.querySelector("[name=reply_text]").value = rule.reply_text;
      document.getElementById("auto-reply-submit-btn").textContent = "Save Changes";
      document.getElementById("auto-reply-cancel-btn").style.display = "";
      form.scrollIntoView({ behavior: "smooth", block: "start" });
    };
  });

  listEl.querySelectorAll(".auto-reply-delete-btn").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm("Delete this auto-reply?")) return;
      btn.disabled = true;
      try {
        await api(
          `/api/accounts/${accountId}/groups/${encodeURIComponent(groupId)}/auto-replies/${btn.dataset.rid}`,
          { method: "DELETE" }
        );
        toast("Auto-reply deleted");
        await refreshAutoReplies(accountId, groupId);
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    };
  });
}
