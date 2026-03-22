/**
 * Checkpoint/resume helpers for long-running processes.
 */

const fs = require("fs");
const path = require("path");
const { ensureDir } = require("./utils");

/**
 * Load a JSON checkpoint file.
 * @param {string} filepath
 * @returns {object|null}
 */
function loadJson(filepath) {
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Save a JSON checkpoint file (atomic write via rename).
 * @param {string} filepath
 * @param {object} data
 */
function saveJson(filepath, data) {
  ensureDir(path.dirname(filepath));
  const tmp = filepath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filepath);
}

/**
 * Load all records from a JSONL checkpoint file.
 * @param {string} filepath
 * @returns {object[]}
 */
function loadJsonl(filepath) {
  try {
    const lines = fs.readFileSync(filepath, "utf8").split("\n");
    return lines.filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/**
 * Append a single record to a JSONL file.
 * @param {string} filepath
 * @param {object} record
 */
function appendJsonl(filepath, record) {
  ensureDir(path.dirname(filepath));
  fs.appendFileSync(filepath, JSON.stringify(record) + "\n");
}

module.exports = { loadJson, saveJson, loadJsonl, appendJsonl };
