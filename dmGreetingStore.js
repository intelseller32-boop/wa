const { getPool, isConfigured } = require("./db");

const DEFAULT_SETTINGS = { enabled: false, message: "", resetAfterDays: 3 };

// accountId -> settings
const memSettings = {};
// accountId -> { contactJid: lastGreetedAtMs }
const memContacts = {};

function memContactsFor(accountId) {
  if (!memContacts[accountId]) memContacts[accountId] = {};
  return memContacts[accountId];
}

async function getSettings(accountId) {
  if (!isConfigured()) return { ...DEFAULT_SETTINGS, ...(memSettings[accountId] || {}) };

  const pool = getPool();
  const [rows] = await pool.query(
    "SELECT enabled, message, reset_after_days FROM dm_greeting_settings WHERE account_id = ?",
    [accountId]
  );
  if (!rows.length) return { ...DEFAULT_SETTINGS };
  const row = rows[0];
  return {
    enabled: !!row.enabled,
    message: row.message || "",
    resetAfterDays: row.reset_after_days ?? 3
  };
}

async function updateSettings(accountId, { enabled, message, resetAfterDays }) {
  const clean = {
    enabled: !!enabled,
    message: String(message ?? "").slice(0, 2000),
    resetAfterDays: Math.max(0, parseInt(resetAfterDays, 10) || 0) || 3
  };

  if (!isConfigured()) {
    memSettings[accountId] = clean;
    return clean;
  }

  const pool = getPool();
  await pool.query(
    `INSERT INTO dm_greeting_settings (account_id, enabled, message, reset_after_days) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), message = VALUES(message), reset_after_days = VALUES(reset_after_days)`,
    [accountId, clean.enabled ? 1 : 0, clean.message, clean.resetAfterDays]
  );
  return clean;
}

// Returns true if this contact should get the greeting right now (never
// greeted before, or it's been resetAfterDays since they last got one) —
// and, if so, immediately records that they were just greeted so a burst
// of quick messages from the same person can't trigger it twice.
async function shouldGreetAndMark(accountId, contactJid, resetAfterDays) {
  const resetMs = Math.max(0, resetAfterDays) * 24 * 60 * 60 * 1000;
  const now = Date.now();

  if (!isConfigured()) {
    const contacts = memContactsFor(accountId);
    const last = contacts[contactJid];
    if (last !== undefined && now - last < resetMs) return false;
    contacts[contactJid] = now;
    return true;
  }

  const pool = getPool();
  const [rows] = await pool.query(
    "SELECT last_greeted_at FROM dm_contacts WHERE account_id = ? AND contact_jid = ?",
    [accountId, contactJid]
  );
  if (rows.length && rows[0].last_greeted_at) {
    const lastMs = new Date(rows[0].last_greeted_at).getTime();
    if (now - lastMs < resetMs) return false;
  }
  await pool.query(
    `INSERT INTO dm_contacts (account_id, contact_jid, last_greeted_at) VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE last_greeted_at = NOW()`,
    [accountId, contactJid]
  );
  return true;
}

module.exports = { getSettings, updateSettings, shouldGreetAndMark };
