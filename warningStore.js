const fs = require("fs");
const { WARNINGS_FILE } = require("./config");

function load() {
  try {
    return JSON.parse(fs.readFileSync(WARNINGS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(WARNINGS_FILE, JSON.stringify(data, null, 2));
}

let warnings = load();

module.exports = {
  // key = `${groupId}_${userId}`
  get(groupId, userId) {
    return warnings[`${groupId}_${userId}`] || 0;
  },
  increment(groupId, userId) {
    const key = `${groupId}_${userId}`;
    warnings[key] = (warnings[key] || 0) + 1;
    save(warnings);
    return warnings[key];
  },
  reset(groupId, userId) {
    const key = `${groupId}_${userId}`;
    delete warnings[key];
    save(warnings);
  }
};
