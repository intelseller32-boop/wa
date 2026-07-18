const { getPool, isConfigured } = require("./db");

const memoryWarnings = {};

function key(accountId, groupId, userId) {
  return `${accountId}_${groupId}_${userId}`;
}

async function increment(accountId, groupId, userId) {
  if (!isConfigured()) {
    const k = key(accountId, groupId, userId);
    memoryWarnings[k] = (memoryWarnings[k] || 0) + 1;
    return memoryWarnings[k];
  }

  const pool = getPool();
  await pool.query(
    `INSERT INTO warnings (account_id, group_id, user_id, count) VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE count = count + 1`,
    [accountId, groupId, userId]
  );
  const [rows] = await pool.query(
    "SELECT count FROM warnings WHERE account_id = ? AND group_id = ? AND user_id = ?",
    [accountId, groupId, userId]
  );
  return rows[0].count;
}

async function reset(accountId, groupId, userId) {
  if (!isConfigured()) {
    delete memoryWarnings[key(accountId, groupId, userId)];
    return;
  }

  const pool = getPool();
  await pool.query(
    "DELETE FROM warnings WHERE account_id = ? AND group_id = ? AND user_id = ?",
    [accountId, groupId, userId]
  );
}

module.exports = { increment, reset };
