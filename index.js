// Baileys needs globalThis.crypto (Web Crypto API), which is only a native
// Node.js global since Node 19. Polyfill it for older Node versions (e.g. Node 18).
if (typeof globalThis.crypto === "undefined") {
  globalThis.crypto = require("node:crypto").webcrypto;
}

// Baileys' bundled libsignal implementation calls console.log directly
// whenever it closes/replaces a Signal Protocol session (a routine part of
// normal key ratcheting, not an error) — this completely bypasses the pino
// "silent" logger passed to makeWASocket below, since it's hard-coded in
// the dependency itself. It dumps the full session record, including raw
// key material (ephemeral keypair, chain key, root key), which then gets
// split into dozens of separate log lines by Railway's log shipper. That's
// pure noise, and cryptographic key bytes have no business sitting in log
// output at all. Filter just these known-benign lines; everything else
// (including our own console.log/console.error calls) is untouched.
const NOISY_LIBSIGNAL_PATTERNS = [
  /^Closing (open |stale open )?session/,
  /^Closing session: SessionEntry/,
];
const originalConsoleLog = console.log.bind(console);
console.log = (...args) => {
  const first = args[0];
  if (typeof first === "string" && NOISY_LIBSIGNAL_PATTERNS.some((re) => re.test(first))) {
    return;
  }
  originalConsoleLog(...args);
};

// Baileys sometimes throws from deep inside its own internals in a way that
// never passes through any of our try/catch blocks — e.g. a decrypt-retry
// request (sendRetryRequest, triggered by a burst of "Bad MAC" session
// errors) racing a socket that's mid-close, which throws a raw "Connection
// Closed" Boom error with nothing awaiting it. Node's default behavior for
// an uncaught exception/rejection is to kill the entire process — which
// takes every connected account down at once, not just the one Baileys was
// upset about. Log it and keep running instead; whichever single account
// was mid-reconnect when this happened will just retry via its own
// connection.update handler like any other disconnect.
process.on("uncaughtException", (err) => {
  console.error("uncaughtException (kept process alive):", err.stack || err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection (kept process alive):", reason?.stack || reason);
});

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
