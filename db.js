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

  console.log("Connected to MySQL database and verified tables.");
}

module.exports = { getPool, isConfigured, initDb };
