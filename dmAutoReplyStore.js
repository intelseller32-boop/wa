const crypto = require("crypto");
const { getPool, isConfigured } = require("./db");

// accountId -> array of { id, keyword, reply_text, match_type }
const memoryStore = {};

function memList(accountId) {
  if (!memoryStore[accountId]) memoryStore[accountId] = [];
  return memoryStore[accountId];
}

async function listAutoReplies(accountId) {
  if (!isConfigured()) return memList(accountId).map((r) => ({ ...r }));

  const pool = getPool();
  const [rows] = await pool.query(
    "SELECT id, keyword, reply_text, match_type FROM dm_auto_replies WHERE account_id = ? ORDER BY created_at ASC",
    [accountId]
  );
  return rows;
}

async function addAutoReply(accountId, keyword, replyText, matchType = "contains") {
  const id = crypto.randomUUID();
  const row = { id, keyword, reply_text: replyText, match_type: matchType };

  if (!isConfigured()) {
    memList(accountId).push(row);
    return row;
  }

  const pool = getPool();
  await pool.query(
    "INSERT INTO dm_auto_replies (id, account_id, keyword, reply_text, match_type) VALUES (?, ?, ?, ?, ?)",
    [id, accountId, keyword, replyText, matchType]
  );
  return row;
}

async function updateAutoReply(accountId, ruleId, keyword, replyText, matchType = "contains") {
  if (!isConfigured()) {
    const list = memList(accountId);
    const row = list.find((r) => r.id === ruleId);
    if (!row) return null;
    row.keyword = keyword;
    row.reply_text = replyText;
    row.match_type = matchType;
    return row;
  }

  const pool = getPool();
  await pool.query(
    "UPDATE dm_auto_replies SET keyword = ?, reply_text = ?, match_type = ? WHERE account_id = ? AND id = ?",
    [keyword, replyText, matchType, accountId, ruleId]
  );
  const [rows] = await pool.query(
    "SELECT id, keyword, reply_text, match_type FROM dm_auto_replies WHERE account_id = ? AND id = ?",
    [accountId, ruleId]
  );
  return rows[0] || null;
}

async function deleteAutoReply(accountId, ruleId) {
  if (!isConfigured()) {
    memoryStore[accountId] = memList(accountId).filter((r) => r.id !== ruleId);
    return;
  }

  const pool = getPool();
  await pool.query("DELETE FROM dm_auto_replies WHERE account_id = ? AND id = ?", [accountId, ruleId]);
}

// Same matching semantics as the group auto-reply store, deliberately kept
// identical so behavior is predictable across both.
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

module.exports = { listAutoReplies, addAutoReply, updateAutoReply, deleteAutoReply, findMatch };
