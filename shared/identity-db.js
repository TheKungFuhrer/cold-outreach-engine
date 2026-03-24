/**
 * Identity DB — schema, lifecycle, and shared helpers.
 *
 * Both cold-outreach-engine and skool-engine adapters import this module.
 * The DB path is resolved from IDENTITY_DB_PATH env var or defaults to
 * the shared-data directory.
 */

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const SCHEMA_VERSION = 1;

const DEFAULT_DB_PATH = path.join(
  "C:", "Users", "Administrator", "projects", "shared-data", "identity.db"
);

let _db = null;

function resolveDbPath(overridePath) {
  return overridePath || process.env.IDENTITY_DB_PATH || DEFAULT_DB_PATH;
}

function openDb(overridePath) {
  if (_db) return _db;

  const dbPath = resolveDbPath(overridePath);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("busy_timeout = 5000");

  migrate(_db);
  return _db;
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function getDb() {
  if (!_db) throw new Error("Identity DB not open. Call openDb() first.");
  return _db;
}

function migrate(db) {
  const currentVersion = db.pragma("user_version", { simple: true });

  if (currentVersion >= SCHEMA_VERSION) return;

  if (currentVersion < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        email             TEXT PRIMARY KEY,
        domain            TEXT,
        first_name        TEXT,
        last_name         TEXT,
        company_name      TEXT,
        phone             TEXT,
        website           TEXT,
        source            TEXT,
        cold_outreach_lead INTEGER DEFAULT 0,
        skool_member       INTEGER DEFAULT 0,
        skool_member_id    TEXT,
        skool_classification TEXT,
        ghl_contact_id     TEXT,
        ghl_tagged         INTEGER DEFAULT 0,
        smartlead_suppressed INTEGER DEFAULT 0,
        first_seen_cold    TEXT,
        first_seen_skool   TEXT,
        last_synced        TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_domain ON contacts(domain);
      CREATE INDEX IF NOT EXISTS idx_source ON contacts(source);
      CREATE INDEX IF NOT EXISTS idx_overlap ON contacts(cold_outreach_lead, skool_member);
    `);
  }

  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

/** Normalize an email for use as primary key. */
function normalizeEmail(email) {
  if (!email || typeof email !== "string") return "";
  return email.trim().toLowerCase();
}

module.exports = {
  openDb,
  closeDb,
  getDb,
  normalizeEmail,
  SCHEMA_VERSION,
  DEFAULT_DB_PATH,
};
