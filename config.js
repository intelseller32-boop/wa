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

  // Default message templates (editable from the dashboard). {user}, {count}, {max} placeholders.
  WELCOME_MESSAGE: "👋 Welcome {user}! Please read the group rules. No links or banned words allowed.",
  WARNING_MESSAGE: "⚠️ {user} your message was removed (banned content). Warning {count}/{max}.",
  KICK_MESSAGE: "🚫 {user} has been removed after reaching {max} warnings.",

  // Dashboard login (protects the whole web dashboard, including QR/pairing codes).
  // Set ADMIN_PASSWORD in Railway's Variables tab. Dashboard is disabled until it's set.
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || "admin",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || ""
};
