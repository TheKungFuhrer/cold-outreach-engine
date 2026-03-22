/**
 * Centralized environment variable loading.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

/**
 * Get a required environment variable or throw.
 * @param {string} name
 * @returns {string}
 */
function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`Error: ${name} not set. Add it to .env or export it.`);
    process.exit(1);
  }
  return val;
}

module.exports = { requireEnv };
