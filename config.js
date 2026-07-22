module.exports = {
  // Default max warnings before removal (used as a fallback / starting point;
  // editable per-account and per-group from the web dashboard)
  MAX_WARNINGS: 3,

  // Default banned words list (editable from the dashboard)
  BANNED_WORDS: [
    "badword1",
    "badword2",
    "spamword"
  ],

  // Regex to detect links (covers http/https, www., and common shorteners)
  LINK_REGEX: /(https?:\/\/|www\.)[^\s]+/i,

  // Domains that are always allowed, even though they're links. A message is
  // only treated as a link violation if it contains a link NOT on this list.
  WHITELISTED_LINK_DOMAINS: [
    "intelseller.com"
  ],

  // Default message templates (editable from the dashboard). {user}, {count}, {max} placeholders.
  WELCOME_MESSAGE: "👋 Welcome {user}! Please read the group rules. No links or banned words allowed.",
  WARNING_MESSAGE: "⚠️ {user} your message was removed (banned content). Warning {count}/{max}.",
  KICK_MESSAGE: "🚫 {user} has been removed after reaching {max} warnings.",

  // Whether tagging this group in a WhatsApp status counts as a violation
  // (deleted + warned like banned words/links). Off by default. "1" = on, "0" = off.
  BLOCK_STATUS_MENTIONS: "0",

  // Dashboard login (protects the whole web dashboard, including QR/pairing codes).
  // Set ADMIN_PASSWORD in Railway's Variables tab. Dashboard is disabled until it's set.
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || "admin",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "",

  // Server-to-server auth for the JSON API (used by an external app calling
  // in via HTTP, e.g. "x-api-key: <this value>" header) — separate from the
  // human dashboard's ADMIN_USERNAME/ADMIN_PASSWORD above. Set WABOT_API_KEY
  // in Railway's Variables tab. If unset, the API-key path is disabled and
  // only the dashboard's Basic Auth login works.
  WABOT_API_KEY: process.env.WABOT_API_KEY || ""
};
