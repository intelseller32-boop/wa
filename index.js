// Baileys needs globalThis.crypto (Web Crypto API), which is only a native
// Node.js global since Node 19. Polyfill it for older Node versions (e.g. Node 18).
if (typeof globalThis.crypto === "undefined") {
  globalThis.crypto = require("node:crypto").webcrypto;
}

const db = require("./db");
const statusServer = require("./statusServer");
const accountManager = require("./accountManager");

async function main() {
  await db.initDb();
  statusServer.startServer(process.env.PORT || 3000);
  await accountManager.resumeAccountsFromDB();
  console.log("Ready. Open the web dashboard to add/manage WhatsApp accounts.");
}

main().catch((err) => {
  console.error("Fatal error starting:", err);
  process.exit(1);
});
