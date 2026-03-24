# Shared Identity Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a shared SQLite identity database that deduplicates contacts across cold-outreach-engine and skool-engine, tracks source attribution, and enables bidirectional sync (upload suppression + GHL tagging).

**Architecture:** A single SQLite DB at a shared filesystem path (`C:\Users\Administrator\projects\shared-data\identity.db`). Each repo gets a thin adapter module (`shared/identity.js` in cold-outreach, `scripts/lib/identity.js` in skool-engine). A standalone `reconcile.js` script in the shared-data directory orchestrates full cross-repo reconciliation. Upload suppression hooks into `3-outreach/upload_leads.js`; GHL tagging hooks into `scripts/sync-writeback.js`.

**Tech Stack:** Node.js, `better-sqlite3`, SQLite (WAL mode), vitest (cold-outreach tests)

**Spec:** `docs/superpowers/specs/2026-03-24-shared-identity-layer-design.md`

---

## File Structure

### New files

| File | Repo | Responsibility |
|------|------|----------------|
| `shared/identity-db.js` | cold-outreach-engine | DB open/migrate/close, schema definition, shared by both repos |
| `shared/identity.js` | cold-outreach-engine | Cold-outreach adapter: loadColdLeads, checkOverlaps, markSuppressed, getStats |
| `shared/identity.test.js` | cold-outreach-engine | Tests for both identity-db.js and identity.js |
| `C:\Users\Administrator\projects\shared-data\config.json` | shared-data | Paths to each repo's data dirs + referral exclusion list |
| `C:\Users\Administrator\projects\shared-data\reconcile.js` | shared-data | Standalone reconciliation script |
| `C:\Users\Administrator\projects\shared-data\package.json` | shared-data | Dependencies for reconcile script |
| `scripts/lib/identity.js` | skool-engine | Skool adapter: loadSkoolMembers, getUntaggedOverlaps, markTagged, getStats |

### Modified files

| File | Repo | Change |
|------|------|--------|
| `package.json` | cold-outreach-engine | Add `better-sqlite3` dependency |
| `package.json` | skool-engine | Add `better-sqlite3` dependency |
| `.env` | cold-outreach-engine | Add `IDENTITY_DB_PATH` (optional) |
| `.env` | skool-engine | Add `IDENTITY_DB_PATH` (optional) |
| `3-outreach/upload_leads.js` | cold-outreach-engine | Add overlap check before upload batches |
| `scripts/lib/ghl-api.js` | skool-engine | Add `addContactTag` function |
| `scripts/sync-writeback.js` | skool-engine | Add GHL tagging for overlaps after writeback |

---

### Task 1: Set up shared-data directory and config

**Files:**
- Create: `C:\Users\Administrator\projects\shared-data\package.json`
- Create: `C:\Users\Administrator\projects\shared-data\config.json`
- Create: `C:\Users\Administrator\projects\shared-data\.gitignore`

- [ ] **Step 1: Create shared-data directory**

```bash
mkdir -p /c/Users/Administrator/projects/shared-data
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "shared-data",
  "version": "1.0.0",
  "private": true,
  "description": "Shared identity layer for cold-outreach-engine and skool-engine",
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "csv-parse": "^5.5.0",
    "dotenv": "^16.4.0"
  }
}
```

- [ ] **Step 3: Create config.json**

```json
{
  "repos": {
    "cold_outreach": "C:\\Users\\Administrator\\projects\\cold-outreach-engine",
    "skool": "C:\\Users\\Administrator\\projects\\skool-engine"
  },
  "data_paths": {
    "cold_outreach_master_csv": "data/upload/master_enriched_emails.csv",
    "skool_progress_json": "data/enriched/progress.json"
  },
  "referral_exclusions": [
    "google", "facebook", "instagram", "tiktok", "youtube",
    "online", "search", "ad", "social media", "twitter", "x",
    "linkedin", "pinterest", "reddit", "internet", "web"
  ]
}
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
identity.db
identity.db-wal
identity.db-shm
```

- [ ] **Step 5: Run npm install**

```bash
cd /c/Users/Administrator/projects/shared-data && npm install
```

- [ ] **Step 6: Commit**

```bash
cd /c/Users/Administrator/projects/shared-data && git init && git add -A && git commit -m "chore: initialize shared-data directory with config"
```

---

### Task 2: Build identity-db.js — schema and DB lifecycle

This is the core module that both adapters import. It lives in cold-outreach-engine but is referenced by absolute path from skool-engine and shared-data.

**Files:**
- Create: `C:\Users\Administrator\projects\cold-outreach-engine\shared\identity-db.js`
- Modify: `C:\Users\Administrator\projects\cold-outreach-engine\package.json` (add `better-sqlite3`)

- [ ] **Step 1: Install better-sqlite3 in cold-outreach-engine**

```bash
cd /c/Users/Administrator/projects/cold-outreach-engine && npm install better-sqlite3
```

- [ ] **Step 2: Write the failing test for openDb and schema creation**

Create `shared/identity.test.js` with all imports upfront (both identity-db and identity adapter imports — the adapter tests are added in Task 3, but imports must be at the top of the file):

```javascript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { openDb, closeDb, SCHEMA_VERSION } from "./identity-db.js";
import { loadColdLeads, checkOverlaps, markSuppressed, getStats } from "./identity.js";

const TEST_DB_PATH = path.join(__dirname, "..", "data", "test_identity.db");

describe("identity-db", () => {
  afterEach(() => {
    closeDb();
    for (const ext of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(TEST_DB_PATH + ext); } catch {}
    }
  });

  it("creates DB with contacts table and indexes", () => {
    const db = openDb(TEST_DB_PATH);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    expect(tables.map(t => t.name)).toContain("contacts");

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all();
    const indexNames = indexes.map(i => i.name);
    expect(indexNames).toContain("idx_domain");
    expect(indexNames).toContain("idx_source");
    expect(indexNames).toContain("idx_overlap");
  });

  it("sets WAL mode and busy_timeout", () => {
    const db = openDb(TEST_DB_PATH);
    const journal = db.pragma("journal_mode", { simple: true });
    expect(journal).toBe("wal");
  });

  it("sets user_version to SCHEMA_VERSION", () => {
    const db = openDb(TEST_DB_PATH);
    const version = db.pragma("user_version", { simple: true });
    expect(version).toBe(SCHEMA_VERSION);
  });

  it("reopening existing DB does not error", () => {
    openDb(TEST_DB_PATH);
    closeDb();
    const db = openDb(TEST_DB_PATH);
    const version = db.pragma("user_version", { simple: true });
    expect(version).toBe(SCHEMA_VERSION);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd /c/Users/Administrator/projects/cold-outreach-engine && npx vitest run shared/identity.test.js
```

Expected: FAIL — `./identity-db.js` does not exist.

- [ ] **Step 4: Implement identity-db.js**

Create `shared/identity-db.js`:

```javascript
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
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd /c/Users/Administrator/projects/cold-outreach-engine && npx vitest run shared/identity.test.js
```

Expected: PASS — all 4 tests green.

- [ ] **Step 6: Commit**

```bash
cd /c/Users/Administrator/projects/cold-outreach-engine
git add shared/identity-db.js shared/identity.test.js package.json package-lock.json
git commit -m "feat: add identity-db module with SQLite schema and lifecycle"
```

---

### Task 3: Build cold-outreach adapter (shared/identity.js)

**Files:**
- Create: `C:\Users\Administrator\projects\cold-outreach-engine\shared\identity.js`
- Modify: `C:\Users\Administrator\projects\cold-outreach-engine\shared\identity.test.js` (add adapter tests)

- [ ] **Step 1: Write failing tests for loadColdLeads**

Append the following `describe` block to the end of `shared/identity.test.js` (the imports were already added at the top in Task 2):

```javascript
describe("cold-outreach identity adapter", () => {
  beforeEach(() => {
    openDb(TEST_DB_PATH);
  });

  afterEach(() => {
    closeDb();
    for (const ext of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(TEST_DB_PATH + ext); } catch {}
    }
  });

  it("loadColdLeads inserts records with cold_outreach_lead=1", () => {
    const records = [
      { email: "Alice@Example.com", first_name: "Alice", last_name: "Smith", company_name: "Venue A", website: "example.com" },
      { email: "bob@test.org", first_name: "Bob", last_name: "Jones", company_name: "Venue B", website: "test.org" },
    ];
    const result = loadColdLeads(records);
    expect(result.upserted).toBe(2);
    expect(result.skipped).toBe(0);

    const stats = getStats();
    expect(stats.total).toBe(2);
    expect(stats.cold_outreach).toBe(2);
    expect(stats.skool).toBe(0);
  });

  it("loadColdLeads upserts without overwriting skool data", () => {
    // Pre-insert a skool member
    const db = openDb(TEST_DB_PATH);
    db.prepare(`INSERT INTO contacts (email, domain, source, skool_member, skool_member_id, first_seen_skool)
                VALUES (?, ?, ?, 1, ?, ?)`).run("alice@example.com", "example.com", "skool_organic", "abc123", "2026-01-01T00:00:00Z");

    const records = [{ email: "Alice@Example.com", first_name: "Alice", company_name: "Venue A", website: "example.com" }];
    loadColdLeads(records);

    const row = db.prepare("SELECT * FROM contacts WHERE email = ?").get("alice@example.com");
    expect(row.cold_outreach_lead).toBe(1);
    expect(row.skool_member).toBe(1);
    expect(row.skool_member_id).toBe("abc123");
    expect(row.source).toBe("skool_organic"); // source not overwritten
  });

  it("checkOverlaps returns emails that are skool members", () => {
    const db = openDb(TEST_DB_PATH);
    db.prepare(`INSERT INTO contacts (email, domain, source, cold_outreach_lead, skool_member)
                VALUES (?, ?, ?, 1, 1)`).run("overlap@test.com", "test.com", "cold_outreach");
    db.prepare(`INSERT INTO contacts (email, domain, source, cold_outreach_lead)
                VALUES (?, ?, ?, 1)`).run("nooverlap@test.com", "test.com", "cold_outreach");

    const overlaps = checkOverlaps(["overlap@test.com", "nooverlap@test.com", "unknown@test.com"]);
    expect(overlaps).toEqual(["overlap@test.com"]);
  });

  it("markSuppressed sets smartlead_suppressed=1", () => {
    const db = openDb(TEST_DB_PATH);
    db.prepare(`INSERT INTO contacts (email, domain, source, cold_outreach_lead)
                VALUES (?, ?, ?, 1)`).run("test@test.com", "test.com", "cold_outreach");

    markSuppressed(["test@test.com"]);

    const row = db.prepare("SELECT smartlead_suppressed FROM contacts WHERE email = ?").get("test@test.com");
    expect(row.smartlead_suppressed).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /c/Users/Administrator/projects/cold-outreach-engine && npx vitest run shared/identity.test.js
```

Expected: FAIL — `./identity.js` does not export these functions.

- [ ] **Step 3: Implement shared/identity.js**

```javascript
/**
 * Cold-outreach identity adapter.
 *
 * Provides functions for loading cold leads into the shared identity DB,
 * checking for Skool member overlaps, and marking suppressed emails.
 */

const { openDb, getDb, closeDb, normalizeEmail } = require("./identity-db");
const { extractDomainFromEmail, normalizeDomain } = require("./dedup");

/**
 * Bulk-upsert cold leads into the identity DB.
 * Sets cold_outreach_lead=1, preserves existing skool data.
 * @param {object[]} records - Array of lead objects (must have email field)
 * @returns {{ upserted: number, skipped: number }}
 */
function loadColdLeads(records) {
  const db = getDb();
  const now = new Date().toISOString();

  const exists = db.prepare("SELECT 1 FROM contacts WHERE email = ?");
  const upsert = db.prepare(`
    INSERT INTO contacts (email, domain, first_name, last_name, company_name, phone, website, source, cold_outreach_lead, first_seen_cold, last_synced)
    VALUES (@email, @domain, @first_name, @last_name, @company_name, @phone, @website, @source, 1, @now, @now)
    ON CONFLICT(email) DO UPDATE SET
      cold_outreach_lead = 1,
      domain = COALESCE(contacts.domain, excluded.domain),
      first_name = COALESCE(NULLIF(contacts.first_name, ''), excluded.first_name),
      last_name = COALESCE(NULLIF(contacts.last_name, ''), excluded.last_name),
      company_name = COALESCE(NULLIF(contacts.company_name, ''), excluded.company_name),
      phone = COALESCE(NULLIF(contacts.phone, ''), excluded.phone),
      website = COALESCE(NULLIF(contacts.website, ''), excluded.website),
      first_seen_cold = COALESCE(contacts.first_seen_cold, excluded.first_seen_cold),
      last_synced = @now
  `);

  let upserted = 0;
  let skipped = 0;

  const runBatch = db.transaction((batch) => {
    for (const row of batch) {
      const email = normalizeEmail(row.email || row.Email || row.email_address || "");
      if (!email || !email.includes("@")) { skipped++; continue; }

      const domain = normalizeDomain(row.website || row.company_domain || "") || extractDomainFromEmail(email);

      upsert.run({
        email,
        domain,
        first_name: (row.first_name || row["First Name"] || "").trim(),
        last_name: (row.last_name || row["Last Name"] || "").trim(),
        company_name: (row.company_name || row.company || "").trim(),
        phone: (row.phone_number || row.phone || "").trim(),
        website: (row.website || row.company_domain || "").trim(),
        source: "cold_outreach",
        now,
      });
      upserted++;
    }
  });

  // Process in batches of 5000 for memory efficiency
  for (let i = 0; i < records.length; i += 5000) {
    runBatch(records.slice(i, i + 5000));
  }

  return { upserted, skipped };
}

/**
 * Check which emails in the batch are Skool members (overlap detection).
 * @param {string[]} emails - Array of email addresses to check
 * @returns {string[]} Emails that are Skool members
 */
function checkOverlaps(emails) {
  const db = getDb();
  const stmt = db.prepare("SELECT email FROM contacts WHERE email = ? AND skool_member = 1");

  const overlaps = [];
  for (const raw of emails) {
    const email = normalizeEmail(raw);
    if (!email) continue;
    const row = stmt.get(email);
    if (row) overlaps.push(row.email);
  }
  return overlaps;
}

/**
 * Mark emails as suppressed from SmartLead uploads.
 * @param {string[]} emails
 */
function markSuppressed(emails) {
  const db = getDb();
  const stmt = db.prepare("UPDATE contacts SET smartlead_suppressed = 1 WHERE email = ?");
  const run = db.transaction((batch) => {
    for (const raw of batch) {
      stmt.run(normalizeEmail(raw));
    }
  });
  run(emails);
}

/**
 * Get identity DB statistics.
 * @returns {{ total, cold_outreach, skool, overlaps, suppressed, by_source }}
 */
function getStats() {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) as c FROM contacts").get().c;
  const cold = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE cold_outreach_lead = 1").get().c;
  const skool = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE skool_member = 1").get().c;
  const overlaps = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE cold_outreach_lead = 1 AND skool_member = 1").get().c;
  const suppressed = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE smartlead_suppressed = 1").get().c;

  const sourceRows = db.prepare("SELECT source, COUNT(*) as c FROM contacts GROUP BY source").all();
  const by_source = {};
  for (const row of sourceRows) {
    by_source[row.source || "unknown"] = row.c;
  }

  return { total, cold_outreach: cold, skool, overlaps, suppressed, by_source };
}

module.exports = { loadColdLeads, checkOverlaps, markSuppressed, getStats };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /c/Users/Administrator/projects/cold-outreach-engine && npx vitest run shared/identity.test.js
```

Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
cd /c/Users/Administrator/projects/cold-outreach-engine
git add shared/identity.js shared/identity.test.js
git commit -m "feat: add cold-outreach identity adapter with overlap detection"
```

---

### Task 4: Build skool-engine adapter (scripts/lib/identity.js)

**Files:**
- Modify: `C:\Users\Administrator\projects\skool-engine\package.json` (add `better-sqlite3`)
- Create: `C:\Users\Administrator\projects\skool-engine\scripts\lib\identity.js`

- [ ] **Step 1: Install better-sqlite3 in skool-engine**

```bash
cd /c/Users/Administrator/projects/skool-engine && npm install better-sqlite3
```

- [ ] **Step 2: Implement scripts/lib/identity.js**

This adapter imports `identity-db.js` from cold-outreach-engine by absolute path (both repos are on the same machine). It handles Skool-specific logic: dual-email rows, referral detection, GHL overlap tagging.

```javascript
/**
 * Skool identity adapter.
 *
 * Loads Skool members into the shared identity DB, detects overlaps
 * with cold outreach leads, and manages GHL tagging state.
 */

const path = require("path");
const fs = require("fs");

// Import shared DB module from cold-outreach-engine
const COLD_OUTREACH_ROOT = "C:\\Users\\Administrator\\projects\\cold-outreach-engine";
const { openDb, getDb, closeDb, normalizeEmail } = require(path.join(COLD_OUTREACH_ROOT, "shared", "identity-db"));

// Load referral exclusion list from shared-data config
const CONFIG_PATH = path.join("C:", "Users", "Administrator", "projects", "shared-data", "config.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return { referral_exclusions: [] };
  }
}

/**
 * Determine source attribution for a Skool member.
 * @param {object} member - Skool member object
 * @returns {string} "skool_referred" or "skool_organic"
 */
function detectSource(member) {
  const referralAnswer = (member.survey_a3 || "").trim().toLowerCase();
  if (!referralAnswer) return "skool_organic";

  const config = loadConfig();
  const exclusions = (config.referral_exclusions || []).map(s => s.toLowerCase());

  for (const exc of exclusions) {
    if (referralAnswer.includes(exc)) return "skool_organic";
  }

  return "skool_referred";
}

/**
 * Extract domain from email address.
 */
function extractDomain(email) {
  if (!email || !email.includes("@")) return "";
  return email.split("@")[1].trim().toLowerCase();
}

/**
 * Bulk-upsert Skool members into the identity DB.
 * Tries survey_a1 first, then email field. If both exist and differ,
 * creates rows for both with identical Skool metadata.
 * @param {object} progressData - The progress.json content: { processed: { [id]: member } }
 * @returns {{ inserted: number, dual_email: number }}
 */
function loadSkoolMembers(progressData) {
  const db = getDb();
  const now = new Date().toISOString();
  const members = Object.values(progressData.processed || {});

  const upsert = db.prepare(`
    INSERT INTO contacts (email, domain, first_name, last_name, company_name, phone, website, source, skool_member, skool_member_id, skool_classification, ghl_contact_id, first_seen_skool, last_synced)
    VALUES (@email, @domain, @first_name, @last_name, @company_name, @phone, @website, @source, 1, @skool_member_id, @skool_classification, @ghl_contact_id, @now, @now)
    ON CONFLICT(email) DO UPDATE SET
      skool_member = 1,
      skool_member_id = excluded.skool_member_id,
      skool_classification = excluded.skool_classification,
      ghl_contact_id = COALESCE(excluded.ghl_contact_id, contacts.ghl_contact_id),
      domain = COALESCE(contacts.domain, excluded.domain),
      first_name = COALESCE(NULLIF(contacts.first_name, ''), excluded.first_name),
      last_name = COALESCE(NULLIF(contacts.last_name, ''), excluded.last_name),
      company_name = COALESCE(NULLIF(contacts.company_name, ''), excluded.company_name),
      phone = COALESCE(NULLIF(contacts.phone, ''), excluded.phone),
      website = COALESCE(NULLIF(contacts.website, ''), excluded.website),
      first_seen_skool = COALESCE(contacts.first_seen_skool, excluded.first_seen_skool),
      last_synced = @now
  `);

  let inserted = 0;
  let dualEmail = 0;

  const runBatch = db.transaction((batch) => {
    for (const member of batch) {
      const surveyEmail = normalizeEmail(member.survey_a1 || "");
      const profileEmail = normalizeEmail(member.email || "");

      // Determine which emails to insert
      const emails = [];
      if (surveyEmail && surveyEmail.includes("@")) emails.push(surveyEmail);
      if (profileEmail && profileEmail.includes("@") && profileEmail !== surveyEmail) emails.push(profileEmail);

      if (emails.length === 0) continue;
      if (emails.length === 2) dualEmail++;

      const source = detectSource(member);
      const nameParts = (member.full_name || "").trim().split(/\s+/);
      const firstName = nameParts[0] || "";
      const lastName = nameParts.slice(1).join(" ") || "";

      const params = {
        first_name: firstName,
        last_name: lastName,
        company_name: "",
        phone: (member.survey_a2 || "").trim(),
        website: (member.website || "").trim(),
        source,
        skool_member_id: member.id || "",
        skool_classification: member.updated_category || member.classification || "",
        ghl_contact_id: member.ghl_contact_id || null,
        now,
      };

      for (const email of emails) {
        upsert.run({
          ...params,
          email,
          domain: extractDomain(email),
        });
        inserted++;
      }
    }
  });

  // Process in batches of 500
  for (let i = 0; i < members.length; i += 500) {
    runBatch(members.slice(i, i + 500));
  }

  return { inserted, dual_email: dualEmail };
}

/**
 * Get overlaps where GHL has not been tagged yet.
 * @returns {Array<{ email, ghl_contact_id, skool_member_id, company_name }>}
 */
function getUntaggedOverlaps() {
  const db = getDb();
  return db.prepare(`
    SELECT email, ghl_contact_id, skool_member_id, company_name
    FROM contacts
    WHERE cold_outreach_lead = 1
      AND skool_member = 1
      AND ghl_tagged = 0
      AND ghl_contact_id IS NOT NULL
  `).all();
}

/**
 * Mark an email as tagged in GHL.
 * @param {string} email
 */
function markTagged(email) {
  const db = getDb();
  db.prepare("UPDATE contacts SET ghl_tagged = 1 WHERE email = ?").run(normalizeEmail(email));
}

/**
 * Get identity DB statistics (same interface as cold-outreach adapter).
 */
function getStats() {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) as c FROM contacts").get().c;
  const cold = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE cold_outreach_lead = 1").get().c;
  const skool = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE skool_member = 1").get().c;
  const overlaps = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE cold_outreach_lead = 1 AND skool_member = 1").get().c;
  const suppressed = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE smartlead_suppressed = 1").get().c;
  const tagged = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE ghl_tagged = 1").get().c;

  const sourceRows = db.prepare("SELECT source, COUNT(*) as c FROM contacts GROUP BY source").all();
  const by_source = {};
  for (const row of sourceRows) {
    by_source[row.source || "unknown"] = row.c;
  }

  return { total, cold_outreach: cold, skool, overlaps, suppressed, tagged, by_source };
}

module.exports = {
  openDb,
  closeDb,
  loadSkoolMembers,
  getUntaggedOverlaps,
  markTagged,
  getStats,
  detectSource,
};
```

- [ ] **Step 3: Write tests for skool adapter**

Add tests to `shared/identity.test.js` in cold-outreach-engine (since that's where vitest is configured). Add this import at the top of the file alongside the other imports:

```javascript
import { loadSkoolMembers, getUntaggedOverlaps, markTagged, detectSource } from "../../../skool-engine/scripts/lib/identity.js";
```

Then append this `describe` block at the end of the file:

```javascript
describe("skool identity adapter", () => {
  beforeEach(() => {
    openDb(TEST_DB_PATH);
  });

  afterEach(() => {
    closeDb();
    for (const ext of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(TEST_DB_PATH + ext); } catch {}
    }
  });

  it("detectSource returns skool_organic for empty survey_a3", () => {
    expect(detectSource({ survey_a3: "" })).toBe("skool_organic");
    expect(detectSource({})).toBe("skool_organic");
  });

  it("detectSource returns skool_organic for excluded sources", () => {
    expect(detectSource({ survey_a3: "Found on Google" })).toBe("skool_organic");
    expect(detectSource({ survey_a3: "Facebook ad" })).toBe("skool_organic");
  });

  it("detectSource returns skool_referred for referral answers", () => {
    expect(detectSource({ survey_a3: "My friend John told me" })).toBe("skool_referred");
    expect(detectSource({ survey_a3: "Referred by Sarah" })).toBe("skool_referred");
  });

  it("loadSkoolMembers inserts from survey_a1 email", () => {
    const progress = {
      processed: {
        "abc123": {
          id: "abc123",
          full_name: "Jane Doe",
          survey_a1: "Jane@Venue.com",
          survey_a2: "555-1234",
          email: "",
          classification: "active_venue_owner",
          ghl_contact_id: "ghl_001",
        },
      },
    };
    const result = loadSkoolMembers(progress);
    expect(result.inserted).toBe(1);

    const db = openDb(TEST_DB_PATH);
    const row = db.prepare("SELECT * FROM contacts WHERE email = ?").get("jane@venue.com");
    expect(row.skool_member).toBe(1);
    expect(row.skool_member_id).toBe("abc123");
    expect(row.skool_classification).toBe("active_venue_owner");
    expect(row.ghl_contact_id).toBe("ghl_001");
  });

  it("loadSkoolMembers creates dual rows when survey_a1 and email differ", () => {
    const progress = {
      processed: {
        "def456": {
          id: "def456",
          full_name: "Bob Smith",
          survey_a1: "bob@business.com",
          email: "bob@skool.com",
          classification: "aspiring_venue_owner",
          ghl_contact_id: "ghl_002",
        },
      },
    };
    const result = loadSkoolMembers(progress);
    expect(result.inserted).toBe(2);
    expect(result.dual_email).toBe(1);

    const db = openDb(TEST_DB_PATH);
    const row1 = db.prepare("SELECT * FROM contacts WHERE email = ?").get("bob@business.com");
    const row2 = db.prepare("SELECT * FROM contacts WHERE email = ?").get("bob@skool.com");
    expect(row1.skool_member_id).toBe("def456");
    expect(row2.skool_member_id).toBe("def456");
    expect(row1.ghl_contact_id).toBe("ghl_002");
    expect(row2.ghl_contact_id).toBe("ghl_002");
  });

  it("getUntaggedOverlaps returns overlaps with ghl_contact_id", () => {
    const db = openDb(TEST_DB_PATH);
    db.prepare(`INSERT INTO contacts (email, domain, source, cold_outreach_lead, skool_member, ghl_contact_id, ghl_tagged)
                VALUES (?, ?, ?, 1, 1, ?, 0)`).run("overlap@test.com", "test.com", "cold_outreach", "ghl_099");
    db.prepare(`INSERT INTO contacts (email, domain, source, cold_outreach_lead, skool_member, ghl_contact_id, ghl_tagged)
                VALUES (?, ?, ?, 1, 1, ?, 1)`).run("tagged@test.com", "test.com", "cold_outreach", "ghl_100");

    const untagged = getUntaggedOverlaps();
    expect(untagged).toHaveLength(1);
    expect(untagged[0].email).toBe("overlap@test.com");
    expect(untagged[0].ghl_contact_id).toBe("ghl_099");
  });

  it("markTagged sets ghl_tagged=1", () => {
    const db = openDb(TEST_DB_PATH);
    db.prepare(`INSERT INTO contacts (email, domain, source, cold_outreach_lead, skool_member, ghl_contact_id, ghl_tagged)
                VALUES (?, ?, ?, 1, 1, ?, 0)`).run("tag-me@test.com", "test.com", "cold_outreach", "ghl_101");

    markTagged("tag-me@test.com");

    const row = db.prepare("SELECT ghl_tagged FROM contacts WHERE email = ?").get("tag-me@test.com");
    expect(row.ghl_tagged).toBe(1);
  });
});
```

- [ ] **Step 4: Run tests**

```bash
cd /c/Users/Administrator/projects/cold-outreach-engine && npx vitest run shared/identity.test.js
```

Expected: All tests pass.

- [ ] **Step 5: Commit both repos**

```bash
cd /c/Users/Administrator/projects/skool-engine
git add scripts/lib/identity.js package.json package-lock.json
git commit -m "feat: add skool identity adapter for shared identity layer"
```

```bash
cd /c/Users/Administrator/projects/cold-outreach-engine
git add shared/identity.test.js
git commit -m "test: add skool adapter tests to identity test suite"
```

---

### Task 5: Build reconcile.js — standalone reconciliation script

**Files:**
- Create: `C:\Users\Administrator\projects\shared-data\reconcile.js`

- [ ] **Step 1: Implement reconcile.js**

```javascript
#!/usr/bin/env node
/**
 * Standalone identity reconciliation.
 *
 * Loads cold leads and Skool members into the shared identity DB,
 * detects overlaps, and prints a report.
 *
 * Usage:
 *   node reconcile.js              # full reconciliation
 *   node reconcile.js --stats      # just print current stats
 */

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

// Resolve paths from config
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const COLD_ROOT = config.repos.cold_outreach;
const SKOOL_ROOT = config.repos.skool;

// Import adapters
const { openDb, closeDb, normalizeEmail } = require(path.join(COLD_ROOT, "shared", "identity-db"));
const coldAdapter = require(path.join(COLD_ROOT, "shared", "identity"));
const skoolAdapter = require(path.join(SKOOL_ROOT, "scripts", "lib", "identity"));

function readCsv(filepath) {
  if (!fs.existsSync(filepath)) return [];
  let raw = fs.readFileSync(filepath, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return parse(raw, { columns: true, skip_empty_lines: true, relax_column_count: true });
}

async function main() {
  const args = process.argv.slice(2);
  const statsOnly = args.includes("--stats");

  console.log("=== Identity Reconciliation ===\n");

  const db = openDb();

  if (statsOnly) {
    const stats = coldAdapter.getStats();
    printStats(stats);
    closeDb();
    return;
  }

  // Step 1: Load cold leads
  const coldCsvPath = path.join(COLD_ROOT, config.data_paths.cold_outreach_master_csv);
  console.log(`Loading cold leads from: ${coldCsvPath}`);
  if (fs.existsSync(coldCsvPath)) {
    const records = readCsv(coldCsvPath);
    const result = coldAdapter.loadColdLeads(records);
    console.log(`  Cold leads: ${result.inserted} inserted/updated\n`);
  } else {
    console.log(`  WARNING: CSV not found at ${coldCsvPath}\n`);
  }

  // Step 2: Load Skool members
  const skoolJsonPath = path.join(SKOOL_ROOT, config.data_paths.skool_progress_json);
  console.log(`Loading Skool members from: ${skoolJsonPath}`);
  if (fs.existsSync(skoolJsonPath)) {
    const progressData = JSON.parse(fs.readFileSync(skoolJsonPath, "utf8"));
    const result = skoolAdapter.loadSkoolMembers(progressData);
    console.log(`  Skool members: ${result.inserted} rows inserted/updated (${result.dual_email} dual-email members)\n`);
  } else {
    console.log(`  WARNING: progress.json not found at ${skoolJsonPath}\n`);
  }

  // Step 3: Report
  const stats = coldAdapter.getStats();
  printStats(stats);

  // Step 4: Show new overlaps
  const overlaps = db.prepare(`
    SELECT email, company_name, source, skool_classification
    FROM contacts
    WHERE cold_outreach_lead = 1 AND skool_member = 1
    ORDER BY email
  `).all();

  if (overlaps.length > 0) {
    console.log(`\n--- Overlaps (${overlaps.length}) ---`);
    for (const o of overlaps.slice(0, 20)) {
      console.log(`  ${o.email} | ${o.company_name || "(no company)"} | source: ${o.source} | skool: ${o.skool_classification}`);
    }
    if (overlaps.length > 20) {
      console.log(`  ... and ${overlaps.length - 20} more`);
    }
  }

  closeDb();
}

function printStats(stats) {
  console.log("--- Identity DB Stats ---");
  console.log(`  Total contacts:    ${stats.total}`);
  console.log(`  Cold outreach:     ${stats.cold_outreach}`);
  console.log(`  Skool members:     ${stats.skool}`);
  console.log(`  Overlaps:          ${stats.overlaps}`);
  console.log(`  Suppressed:        ${stats.suppressed}`);
  console.log(`  By source:`);
  for (const [src, count] of Object.entries(stats.by_source)) {
    console.log(`    ${src}: ${count}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Test manually with --stats (empty DB)**

```bash
cd /c/Users/Administrator/projects/shared-data && node reconcile.js --stats
```

Expected: Stats showing all zeros (empty DB).

- [ ] **Step 3: Commit**

```bash
cd /c/Users/Administrator/projects/shared-data
git add reconcile.js
git commit -m "feat: add standalone reconciliation script"
```

---

### Task 6: Hook into cold-outreach upload (suppression)

**Files:**
- Modify: `C:\Users\Administrator\projects\cold-outreach-engine\3-outreach\upload_leads.js:62-116`

- [ ] **Step 1: Change `const unique` to `let unique` on line 90**

In `3-outreach/upload_leads.js`, line 90, change:
```javascript
  const unique = [];
```
to:
```javascript
  let unique = [];
```

This is required because the suppression logic filters the array by reassignment.

- [ ] **Step 2: Add identity import and suppression logic to upload_leads.js**

At the top of `upload_leads.js`, after existing imports (line 17), add:

```javascript
let identityAvailable = false;
try {
  var { openDb: openIdentityDb, closeDb: closeIdentityDb } = require("../shared/identity-db");
  var { checkOverlaps, markSuppressed } = require("../shared/identity");
  identityAvailable = true;
} catch {
  // Identity layer not installed — skip suppression
}
```

In the `main()` function, after the email dedup block (after line 97, `console.log("After email dedup...")`) and before the checkpoint loading (line 100), add the suppression block:

```javascript
  // --- Identity layer: suppress Skool members ---
  let suppressed = [];
  if (identityAvailable) {
    try {
      openIdentityDb();
      const batchEmails = unique.map((l) => l.email);
      suppressed = checkOverlaps(batchEmails);
      if (suppressed.length > 0) {
        const suppressedSet = new Set(suppressed);
        const beforeCount = unique.length;
        unique = unique.filter((l) => !suppressedSet.has(l.email.trim().toLowerCase()));
        markSuppressed(suppressed);
        console.log(`Identity layer: suppressed ${suppressed.length} Skool members (${beforeCount} → ${unique.length})`);
      }
      closeIdentityDb();
    } catch (err) {
      console.log(`Identity layer warning: ${err.message} — continuing without suppression`);
    }
  }
```

- [ ] **Step 3: Verify upload_leads.js still runs with --dry-run**

```bash
cd /c/Users/Administrator/projects/cold-outreach-engine
node 3-outreach/upload_leads.js --input data/final/clean_venues_2026-03-23T21-43-14.csv --campaign-id 3071191 --dry-run
```

Expected: Normal dry-run output. If identity DB doesn't exist yet, should log the warning and continue.

- [ ] **Step 4: Commit**

```bash
cd /c/Users/Administrator/projects/cold-outreach-engine
git add 3-outreach/upload_leads.js
git commit -m "feat: add identity layer suppression hook to upload_leads.js"
```

---

### Task 7: Add addContactTag to GHL API and hook into sync-writeback

**Files:**
- Modify: `C:\Users\Administrator\projects\skool-engine\scripts\lib\ghl-api.js:96-103`
- Modify: `C:\Users\Administrator\projects\skool-engine\scripts\sync-writeback.js:230-241`

- [ ] **Step 1: Add addContactTag function to ghl-api.js**

After the `updateContact` function (line 103), add:

```javascript
async function addContactTag(contactId, tag) {
  await sleep(REQUEST_DELAY_MS);
  // Fetch current tags first to avoid overwriting
  const contact = await ghlFetch(`/contacts/${contactId}`, { method: 'GET' });
  const currentTags = contact.contact?.tags || [];
  if (currentTags.includes(tag)) return { alreadyTagged: true };

  return updateContact(contactId, { tags: [...currentTags, tag] });
}
```

Add `addContactTag` to the `module.exports` object.

- [ ] **Step 2: Update the import line in sync-writeback.js to include addContactTag**

On line 20 of `scripts/sync-writeback.js`, change:
```javascript
const { getContactNotes, createContactNote, updateContactNote, sleep, GHL_API_KEY } = require('./lib/ghl-api');
```
to:
```javascript
const { getContactNotes, createContactNote, updateContactNote, addContactTag, sleep, GHL_API_KEY } = require('./lib/ghl-api');
```

- [ ] **Step 3: Add identity tagging to sync-writeback.js**

At the top of `sync-writeback.js`, after existing imports (line 21), add:

```javascript
let identityAvailable = false;
try {
  var identityAdapter = require('./lib/identity');
  identityAvailable = true;
} catch {
  // Identity layer not installed — skip tagging
}
```

At the end of `main()`, after the final `saveWritebackLog(writebackLog)` call (line 233) and before the summary output (line 235), add:

```javascript
  // --- Identity layer: tag overlaps in GHL ---
  if (identityAvailable) {
    try {
      identityAdapter.openDb();
      const untagged = identityAdapter.getUntaggedOverlaps();
      if (untagged.length > 0) {
        console.log(`\n--- Identity Layer: Tagging ${untagged.length} overlaps in GHL ---`);
        let tagged = 0;
        for (const overlap of untagged) {
          try {
            await addContactTag(overlap.ghl_contact_id, "cold_outreach_overlap");
            identityAdapter.markTagged(overlap.email);
            tagged++;
            console.log(`  Tagged: ${overlap.email}`);
          } catch (err) {
            console.log(`  Failed to tag ${overlap.email}: ${err.message.substring(0, 80)}`);
          }
        }
        console.log(`  Tagged ${tagged}/${untagged.length} overlaps`);
      }
      identityAdapter.closeDb();
    } catch (err) {
      console.log(`Identity layer warning: ${err.message} — continuing without tagging`);
    }
  }
```

- [ ] **Step 4: Commit**

```bash
cd /c/Users/Administrator/projects/skool-engine
git add scripts/lib/ghl-api.js scripts/sync-writeback.js
git commit -m "feat: add GHL tagging for cold outreach overlaps in sync-writeback"
```

---

### Task 8: End-to-end manual test

- [ ] **Step 1: Run full reconciliation**

```bash
cd /c/Users/Administrator/projects/shared-data && node reconcile.js
```

Expected: Loads 112K cold leads and ~1,400 Skool members, reports overlaps and stats.

- [ ] **Step 2: Verify overlap count is reasonable**

Check the overlap report. Given 112K cold emails and 1,400 Skool members, expect somewhere between 0 and a few hundred overlaps (depends on how many Skool members were cold outreach targets).

- [ ] **Step 3: Run --stats to confirm persistence**

```bash
cd /c/Users/Administrator/projects/shared-data && node reconcile.js --stats
```

Expected: Same stats as Step 1 (data persisted in SQLite).

- [ ] **Step 4: Test upload suppression with dry-run**

```bash
cd /c/Users/Administrator/projects/cold-outreach-engine
node 3-outreach/upload_leads.js --input data/final/clean_venues_2026-03-23T21-43-14.csv --campaign-id 3071191 --dry-run
```

Expected: Should show "Identity layer: suppressed N Skool members" if any overlaps exist.

- [ ] **Step 5: Run cold-outreach-engine tests**

```bash
cd /c/Users/Administrator/projects/cold-outreach-engine && npx vitest run
```

Expected: All tests pass including new identity tests.

- [ ] **Step 6: Final commit for any test fixes**

Only if needed. All repos should have clean working trees at this point.
