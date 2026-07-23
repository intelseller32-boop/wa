const { getPool, isConfigured } = require("./db");

// Reserved names — these are always supplied by the message context itself
// (see fillTemplate in accountManager.js), so a custom variable can't
// silently shadow them.
const RESERVED_NAMES = new Set(["user", "name", "count", "max"]);

// accountId -> { varName: varValue }
const memoryStore = {};

function memMap(accountId) {
  if (!memoryStore[accountId]) memoryStore[accountId] = {};
  return memoryStore[accountId];
}

function validateName(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) throw Object.assign(new Error("Variable name is required."), { code: "BAD_NAME" });
  if (!/^[a-zA-Z0-9_]{1,32}$/.test(trimmed)) {
    throw Object.assign(
      new Error("Variable names can only use letters, numbers, and underscores (max 32 characters)."),
      { code: "BAD_NAME" }
    );
  }
  if (RESERVED_NAMES.has(trimmed.toLowerCase())) {
    throw Object.assign(new Error(`"${trimmed}" is a built-in variable and can't be overridden.`), {
      code: "RESERVED_NAME"
    });
  }
  return trimmed;
}

// Returns { varName: varValue } for use as the vars object in fillTemplate.
async function listVariables(accountId) {
  if (!isConfigured()) return { ...memMap(accountId) };

  const pool = getPool();
  const [rows] = await pool.query("SELECT var_name, var_value FROM dm_variables WHERE account_id = ?", [accountId]);
  const map = {};
  for (const row of rows) map[row.var_name] = row.var_value;
  return map;
}

async function setVariable(accountId, name, value) {
  const cleanName = validateName(name);
  const cleanValue = String(value ?? "").slice(0, 512);

  if (!isConfigured()) {
    memMap(accountId)[cleanName] = cleanValue;
    return { name: cleanName, value: cleanValue };
  }

  const pool = getPool();
  await pool.query(
    `INSERT INTO dm_variables (account_id, var_name, var_value) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE var_value = VALUES(var_value)`,
    [accountId, cleanName, cleanValue]
  );
  return { name: cleanName, value: cleanValue };
}

async function deleteVariable(accountId, name) {
  if (!isConfigured()) {
    delete memMap(accountId)[name];
    return;
  }

  const pool = getPool();
  await pool.query("DELETE FROM dm_variables WHERE account_id = ? AND var_name = ?", [accountId, name]);
}

module.exports = { listVariables, setVariable, deleteVariable, RESERVED_NAMES };
