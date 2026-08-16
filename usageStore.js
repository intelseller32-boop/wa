const { getPool, isConfigured } = require("./db");

/**
 * USAGE METERING — tracks, per WhatsApp account on THIS service, how many
 * messages the bot has sent into groups and how many moderation actions
 * (message delete, kick) it has taken. wabot polls pull() periodically to
 * fold the unbilled delta into its own owner-level usage ledger (which
 * survives even if this account gets deleted or the owner switches to a
 * different WhatsApp number — see accountManager.js in the wabot project).
 *
 * Counters here are CUMULATIVE and never reset. reported_* records how much
 * has already been handed to wabot, so pull() just returns
 * (current - reported) and advances reported — no fragile "reset to zero"
 * race with increment() calls that might land in between.
 */

const memoryStore = {}; // accountId -> { messages, actions, statusPosts, reported* }

function memRow(accountId) {
  if (!memoryStore[accountId]) {
    memoryStore[accountId] = {
      messages: 0, actions: 0, statusPosts: 0,
      reportedMessages: 0, reportedActions: 0, reportedStatusPosts: 0
    };
  }
  return memoryStore[accountId];
}

async function increment(accountId, { messages = 0, actions = 0, statusPosts = 0 } = {}) {
  if (!messages && !actions && !statusPosts) return;

  if (!isConfigured()) {
    const row = memRow(accountId);
    row.messages += messages;
    row.actions += actions;
    row.statusPosts += statusPosts;
    return;
  }

  const pool = getPool();
  await pool.query(
    `INSERT INTO usage_counters (account_id, messages_sent, actions_count, status_posts) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE messages_sent = messages_sent + VALUES(messages_sent),
                             actions_count = actions_count + VALUES(actions_count),
                             status_posts = status_posts + VALUES(status_posts)`,
    [accountId, messages, actions, statusPosts]
  );
}

// Read-only view of the currently unbilled delta — for dashboard display.
async function peek(accountId) {
  if (!isConfigured()) {
    const row = memRow(accountId);
    return {
      messages: row.messages - row.reportedMessages,
      actions: row.actions - row.reportedActions,
      statusPosts: row.statusPosts - row.reportedStatusPosts
    };
  }

  const pool = getPool();
  const [rows] = await pool.query(
    "SELECT messages_sent, actions_count, status_posts, reported_messages, reported_actions, reported_status_posts FROM usage_counters WHERE account_id = ?",
    [accountId]
  );
  if (!rows.length) return { messages: 0, actions: 0, statusPosts: 0 };
  const row = rows[0];
  return {
    messages: Number(row.messages_sent) - Number(row.reported_messages),
    actions: Number(row.actions_count) - Number(row.reported_actions),
    statusPosts: Number(row.status_posts || 0) - Number(row.reported_status_posts || 0)
  };
}

// Returns the unbilled delta AND marks it as reported. Call this from the
// billing sync job (wabot), not from anything display-only.
async function pull(accountId) {
  if (!isConfigured()) {
    const row = memRow(accountId);
    const delta = {
      messages: row.messages - row.reportedMessages,
      actions: row.actions - row.reportedActions,
      statusPosts: row.statusPosts - row.reportedStatusPosts
    };
    row.reportedMessages = row.messages;
    row.reportedActions = row.actions;
    row.reportedStatusPosts = row.statusPosts;
    return delta;
  }

  const pool = getPool();
  const [rows] = await pool.query(
    "SELECT messages_sent, actions_count, status_posts, reported_messages, reported_actions, reported_status_posts FROM usage_counters WHERE account_id = ?",
    [accountId]
  );
  if (!rows.length) return { messages: 0, actions: 0, statusPosts: 0 };
  const row = rows[0];
  const delta = {
    messages: Number(row.messages_sent) - Number(row.reported_messages),
    actions: Number(row.actions_count) - Number(row.reported_actions),
    statusPosts: Number(row.status_posts || 0) - Number(row.reported_status_posts || 0)
  };
  if (delta.messages > 0 || delta.actions > 0 || delta.statusPosts > 0) {
    await pool.query(
      "UPDATE usage_counters SET reported_messages = messages_sent, reported_actions = actions_count, reported_status_posts = status_posts WHERE account_id = ?",
      [accountId]
    );
  }
  return delta;
}

module.exports = { increment, peek, pull };
