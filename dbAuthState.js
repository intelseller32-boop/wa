// A MySQL-backed replacement for Baileys' file-based useMultiFileAuthState.
// Stores WhatsApp login/session data as rows in the auth_data table instead of
// files on disk, so a session survives redeploys/restarts without a volume,
// and multiple accounts can each have their own isolated session.
// @vkazee/baileys (see accountManager.js for why) is ESM-only, so it can't
// be require()'d directly from this CommonJS file — loaded via dynamic
// import() instead, resolved once and awaited at the top of useDBAuthState.
let proto, initAuthCreds, BufferJSON;
const baileysReady = import("@vkazee/baileys").then((mod) => {
  proto = mod.proto;
  initAuthCreds = mod.initAuthCreds;
  BufferJSON = mod.BufferJSON;
});
const { getPool, isConfigured } = require("./db");

// In-memory fallback if no DATABASE_URL is set (session will NOT survive restarts)
const memoryStores = new Map();

async function useDBAuthState(accountId) {
  await baileysReady;
  const usingDb = isConfigured();
  const pool = usingDb ? getPool() : null;
  const mem = usingDb ? null : (memoryStores.get(accountId) || new Map());
  if (!usingDb) memoryStores.set(accountId, mem);

  async function readData(key) {
    if (!usingDb) {
      const raw = mem.get(key);
      return raw ? JSON.parse(raw, BufferJSON.reviver) : null;
    }
    const [rows] = await pool.query(
      "SELECT data_value FROM auth_data WHERE account_id = ? AND data_key = ?",
      [accountId, key]
    );
    if (!rows.length) return null;
    try {
      return JSON.parse(rows[0].data_value, BufferJSON.reviver);
    } catch {
      return null;
    }
  }

  async function writeData(key, value) {
    const json = JSON.stringify(value, BufferJSON.replacer);
    if (!usingDb) {
      mem.set(key, json);
      return;
    }
    await pool.query(
      `INSERT INTO auth_data (account_id, data_key, data_value) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE data_value = ?`,
      [accountId, key, json, json]
    );
  }

  async function removeData(key) {
    if (!usingDb) {
      mem.delete(key);
      return;
    }
    await pool.query("DELETE FROM auth_data WHERE account_id = ? AND data_key = ?", [accountId, key]);
  }

  const creds = (await readData("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => writeData("creds", creds),
    clearAll: async () => {
      if (!usingDb) {
        mem.clear();
        return;
      }
      await pool.query("DELETE FROM auth_data WHERE account_id = ?", [accountId]);
    }
  };
}

module.exports = { useDBAuthState };
