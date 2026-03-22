/**
 * Miscellaneous shared utilities.
 */

const fs = require("fs");
const path = require("path");

/** Project root directory. */
const PROJECT_ROOT = path.join(__dirname, "..");

/**
 * Resolve a path relative to the project root.
 * @param  {...string} parts
 * @returns {string}
 */
function projectPath(...parts) {
  return path.join(PROJECT_ROOT, ...parts);
}

/**
 * Ensure a directory exists (recursive mkdir).
 * @param {string} dirpath
 */
function ensureDir(dirpath) {
  fs.mkdirSync(dirpath, { recursive: true });
}

/**
 * ISO timestamp safe for filenames (no colons).
 * @returns {string}
 */
function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

module.exports = { PROJECT_ROOT, projectPath, ensureDir, timestamp };
