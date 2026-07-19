const crypto = require("crypto");
const { getPool, isConfigured } = require("./db");

// accountId -> array of { id, group_id, keyword, reply_text, match_type }
const memoryStore = {};

function memList(accountId) {
  if (!memoryStore[accountId]) memoryStore[accountId] = [];
  return memoryStore[accountId];
}

// Returns only the rows relevant to managing a specific groupId in the dashboard
// (i.e. exactly what was saved against that group_id, no merging).
async function listAutoReplies(accountId, groupId) {
  if (!isConfigured()) {
    return memList(accountId)
      .filter((r) => r.group_id === groupId)
      .map((r) => ({ ...r }));
  }

  const pool = getPool();
  const [rows] = await pool.query(
    "SELECT id, keyword, reply_text, match_type FROM auto_replies WHERE account_id = ? AND group_id = ? ORDER BY created_at ASC",
    [accountId, groupId]
  );
  return rows;
}

// Returns the merged set used at message-handling time: this group's own rules
// plus the account-wide '_default' rules (unless groupId IS '_default').
async function getMatchingRules(accountId, groupId) {
  if (!isConfigured()) {
    const all = memList(accountId);
    const defaults = all.filter((r) => r.group_id === "_default");
    if (groupId === "_default") return defaults;
    return [...defaults, ...all.filter((r) => r.group_id === groupId)];
  }

  const pool = getPool();
  const [defaultRows] = await pool.query(
    "SELECT id, keyword, reply_text, match_type FROM auto_replies WHERE account_id = ? AND group_id = '_default'",
    [accountId]
  );
  if (groupId === "_default") return defaultRows;

  const [groupRows] = await pool.query(
    "SELECT id, keyword, reply_text, match_type FROM auto_replies WHERE account_id = ? AND group_id = ?",
    [accountId, groupId]
  );
  return [...defaultRows, ...groupRows];
}

async function addAutoReply(accountId, groupId, keyword, replyText, matchType = "contains") {
  const id = crypto.randomUUID();
  const row = { id, group_id: groupId, keyword, reply_text: replyText, match_type: matchType };

  if (!isConfigured()) {
    memList(accountId).push(row);
    return row;
  }

  const pool = getPool();
  await pool.query(
    "INSERT INTO auto_replies (id, account_id, group_id, keyword, reply_text, match_type) VALUES (?, ?, ?, ?, ?, ?)",
    [id, accountId, groupId, keyword, replyText, matchType]
  );
  return row;
}

async function deleteAutoReply(accountId, ruleId) {
  if (!isConfigured()) {
    memoryStore[accountId] = memList(accountId).filter((r) => r.id !== ruleId);
    return;
  }

  const pool = getPool();
  await pool.query("DELETE FROM auto_replies WHERE account_id = ? AND id = ?", [accountId, ruleId]);
}

// Finds the first rule whose keyword matches the given text. Case-insensitive.
// match_type 'contains' (default): keyword appears anywhere in the message.
// match_type 'exact': the whole message (trimmed) equals the keyword.
function findMatch(rules, text) {
  if (!text) return null;
  const normalized = text.trim().toLowerCase();
  for (const rule of rules) {
    const keyword = (rule.keyword || "").trim().toLowerCase();
    if (!keyword) continue;
    if (rule.match_type === "exact") {
      if (normalized === keyword) return rule;
    } else if (normalized.includes(keyword)) {
      return rule;
    }
  }
  return null;
}

module.exports = { listAutoReplies, getMatchingRules, addAutoReply, deleteAutoReply, findMatch };
