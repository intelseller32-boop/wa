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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

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

  console.log("Connected to MySQL database and verified tables.");
}

module.exports = { getPool, isConfigured, initDb };
