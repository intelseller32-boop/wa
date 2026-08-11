const mysql = require("mysql2/promise");

let pool = null;

function isConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

function getPool() {
  if (!isConfigured()) return null;
  if (!pool) {
    pool = mysql.createPool(process.env.DATABASE_URL);
  }
  return pool;
}

async function initDb() {
  const p = getPool();
  if (!p) {
    console.warn(
      "DATABASE_URL not set - accounts, settings and warnings will use in-memory storage only (lost on every restart). Add DATABASE_URL in Railway's Variables tab."
    );
    return;
  }

  // One row per WhatsApp account added via the dashboard
  await p.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id VARCHAR(36) PRIMARY KEY,
      label VARCHAR(128),
      phone_number VARCHAR(32),
      status VARCHAR(32) DEFAULT 'pending',
      watermark TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'If 1, append the "Bot powered by" watermark to outgoing messages',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const [wmCol] = await p.query(
    `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accounts' AND COLUMN_NAME = 'watermark'`
  );
  if (Number(wmCol[0].n) === 0) {
    await p.query(`ALTER TABLE accounts ADD COLUMN watermark TINYINT(1) NOT NULL DEFAULT 1`);
  }
  // 'moderator' (default) = full group moderation (banned words/links,
  // welcome messages, warnings/kicks, admin-rights nagging) — used by the
  // wabot module. 'ads' = outbound-only, used by ad-hub's promote.html:
  // the account only ever sends whatever it's told via the /send API and
  // never reacts to group activity on its own.
  const [purposeCol] = await p.query(
    `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accounts' AND COLUMN_NAME = 'purpose'`
  );
  if (Number(purposeCol[0].n) === 0) {
    await p.query(`ALTER TABLE accounts ADD COLUMN purpose VARCHAR(16) NOT NULL DEFAULT 'moderator'`);
  }

  // WhatsApp login session data (replaces the old file-based auth_info folder)
  await p.query(`
    CREATE TABLE IF NOT EXISTS auth_data (
      account_id VARCHAR(36) NOT NULL,
      data_key VARCHAR(255) NOT NULL,
      data_value LONGTEXT,
      PRIMARY KEY (account_id, data_key)
    )
  `);

  // Settings are per account + group. group_id = '_default' means "applies to all
  // groups on this account unless a group has its own override".
  await p.query(`
    CREATE TABLE IF NOT EXISTS settings (
      account_id VARCHAR(36) NOT NULL,
      group_id VARCHAR(128) NOT NULL DEFAULT '_default',
      setting_key VARCHAR(64) NOT NULL,
      setting_value TEXT,
      PRIMARY KEY (account_id, group_id, setting_key)
    )
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS warnings (
      account_id VARCHAR(36) NOT NULL,
      group_id VARCHAR(128) NOT NULL,
      user_id VARCHAR(128) NOT NULL,
      count INT NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, group_id, user_id)
    )
  `);

  // Auto-reply keyword -> response pairs. group_id = '_default' means "applies to
  // all groups on this account unless a group has its own entries", same pattern as `settings`.
  await p.query(`
    CREATE TABLE IF NOT EXISTS auto_replies (
      id VARCHAR(36) PRIMARY KEY,
      account_id VARCHAR(36) NOT NULL,
      group_id VARCHAR(128) NOT NULL DEFAULT '_default',
      keyword VARCHAR(255) NOT NULL,
      reply_text TEXT NOT NULL,
      match_type VARCHAR(16) NOT NULL DEFAULT 'contains',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_account_group (account_id, group_id)
    )
  `);

  // ── Personal chat (1:1 DM) auto-reply — same shape as group auto_replies
  // but account-scoped only (a personal account has no "groups" to key on).
  await p.query(`
    CREATE TABLE IF NOT EXISTS dm_auto_replies (
      id VARCHAR(36) PRIMARY KEY,
      account_id VARCHAR(36) NOT NULL,
      keyword VARCHAR(255) NOT NULL,
      reply_text TEXT NOT NULL,
      match_type VARCHAR(16) NOT NULL DEFAULT 'contains',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_account (account_id)
    )
  `);

  // Owner-defined custom variables usable in DM templates as {name}.
  await p.query(`
    CREATE TABLE IF NOT EXISTS dm_variables (
      account_id VARCHAR(36) NOT NULL,
      var_name VARCHAR(64) NOT NULL,
      var_value VARCHAR(512) NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (account_id, var_name)
    )
  `);

  // First-message ("greeting") config — mirrors WhatsApp's own official
  // away/greeting message feature: sent once to a contact, then again only
  // after reset_after_days of silence from them.
  await p.query(`
    CREATE TABLE IF NOT EXISTS dm_greeting_settings (
      account_id VARCHAR(36) PRIMARY KEY,
      enabled TINYINT(1) NOT NULL DEFAULT 0,
      message TEXT,
      reset_after_days INT NOT NULL DEFAULT 3
    )
  `);

  // Tracks who's already been greeted and when, per account.
  await p.query(`
    CREATE TABLE IF NOT EXISTS dm_contacts (
      account_id VARCHAR(36) NOT NULL,
      contact_jid VARCHAR(64) NOT NULL,
      first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_greeted_at TIMESTAMP NULL,
      PRIMARY KEY (account_id, contact_jid)
    )
  `);

  // Lifetime usage counters per account — messages the bot has sent into
  // groups, and moderation actions taken (delete/kick). These are CUMULATIVE
  // (never reset) — reported_* tracks how much has already been pulled/
  // billed by wabot, so pull() can hand back only the unbilled delta without
  // needing a fragile reset-to-zero race. See usageStore.js.
  await p.query(`
    CREATE TABLE IF NOT EXISTS usage_counters (
      account_id VARCHAR(36) PRIMARY KEY,
      messages_sent BIGINT NOT NULL DEFAULT 0,
      actions_count BIGINT NOT NULL DEFAULT 0,
      reported_messages BIGINT NOT NULL DEFAULT 0,
      reported_actions BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  console.log("Connected to MySQL database and verified tables.");
}

module.exports = { getPool, isConfigured, initDb };
