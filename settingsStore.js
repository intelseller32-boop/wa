const { getPool, isConfigured } = require("./db");
const defaults = require("./config");

const DEFAULT_SETTINGS = {
  // New/never-configured groups must start OFF — the dashboard's own
  // toggle-loading code (public/wabot's group-enable-checkbox handler,
  // in the marketplace project) explicitly says "groups are off by
  // default, the owner has to deliberately opt each one in". This used
  // to be "1" here, which contradicted that: any group the bot was ever
  // added to — including ones the owner never opened the dashboard for —
  // silently started moderating and demanding admin rights the moment
  // it saw a violating message, before the owner had a chance to say yes.
  enabled: "0",
  welcome_message: defaults.WELCOME_MESSAGE,
  warning_message: defaults.WARNING_MESSAGE,
  kick_message: defaults.KICK_MESSAGE,
  max_warnings: String(defaults.MAX_WARNINGS),
  banned_words: defaults.BANNED_WORDS.join("\n"),
  allowed_urls: "",
  ban_links: "1",
  ban_stickers: "0",
  ban_status_mentions: defaults.BAN_STATUS_MENTIONS,
  respect_admins: "1"
};

const memoryStore = {}; // `${accountId}:${groupId}` -> partial settings object

function memKey(accountId, groupId) {
  return `${accountId}:${groupId}`;
}

// groupId = '_default' reads/writes the account-wide defaults.
// Any other groupId reads account defaults first, then applies that group's overrides on top.
async function getSettings(accountId, groupId) {
  if (!isConfigured()) {
    const base = { ...DEFAULT_SETTINGS, ...(memoryStore[memKey(accountId, "_default")] || {}) };
    if (groupId === "_default") return base;
    return { ...base, ...(memoryStore[memKey(accountId, groupId)] || {}) };
  }

  const pool = getPool();
  const [defaultRows] = await pool.query(
    "SELECT setting_key, setting_value FROM settings WHERE account_id = ? AND group_id = '_default'",
    [accountId]
  );
  // A prior bug could write SQL NULL for a setting (partial-update payloads
  // that included an explicit `undefined` field). If we blindly overwrite
  // the default with that NULL, callers like accountManager.js crash trying
  // to call .split() on it. Treat a stored NULL as "no override" so the
  // default takes effect.
  const settings = { ...DEFAULT_SETTINGS };
  for (const row of defaultRows) {
    if (row.setting_value !== null) settings[row.setting_key] = row.setting_value;
  }

  if (groupId !== "_default") {
    const [groupRows] = await pool.query(
      "SELECT setting_key, setting_value FROM settings WHERE account_id = ? AND group_id = ?",
      [accountId, groupId]
    );
    for (const row of groupRows) {
      if (row.setting_value !== null) settings[row.setting_key] = row.setting_value;
    }
  }

  return settings;
}

async function updateSettings(accountId, groupId, updates) {
  if (!isConfigured()) {
    const key = memKey(accountId, groupId);
    memoryStore[key] = { ...(memoryStore[key] || {}), ...updates };
    return;
  }

  const pool = getPool();
  for (const [key, value] of Object.entries(updates)) {
    await pool.query(
      `INSERT INTO settings (account_id, group_id, setting_key, setting_value) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_value = ?`,
      [accountId, groupId, key, value, value]
    );
  }
}

module.exports = { getSettings, updateSettings, DEFAULT_SETTINGS };
