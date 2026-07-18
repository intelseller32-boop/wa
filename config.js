module.exports = {
  // How many warnings before a user is removed
  MAX_WARNINGS: 3,

  // Words that trigger a warning (lowercase, no spaces needed - substring match)
  BANNED_WORDS: [
    "badword1",
    "badword2",
    "spamword"
  ],

  // Regex to detect links (covers http/https, www., and common shorteners)
  LINK_REGEX: /(https?:\/\/|www\.)[^\s]+/i,

  // Welcome message template. {user} is replaced with @mention
  WELCOME_MESSAGE: "👋 Welcome {user}! Please read the group rules. No links or banned words allowed.",

  // Warning message template. {user}=mention, {count}=current warning count, {max}=max warnings
  WARNING_MESSAGE: "⚠️ {user} your message was removed (banned content). Warning {count}/{max}.",

  // Message sent right before kicking
  KICK_MESSAGE: "🚫 {user} has been removed after reaching {max} warnings.",

  // File where warning counts are persisted (so they survive restarts)
  WARNINGS_FILE: "./warnings.json",

  // Auth session folder (Baileys will store login creds here)
  AUTH_FOLDER: "./auth_info"
};
