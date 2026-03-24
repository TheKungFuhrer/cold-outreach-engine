import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { openDb, closeDb, SCHEMA_VERSION } from "./identity-db.js";
import { openDb as openAdapterDb, closeDb as closeAdapterDb, loadColdLeads, checkOverlaps, markSuppressed, getStats } from "./identity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

describe("cold-outreach identity adapter", () => {
  beforeEach(() => {
    openAdapterDb(TEST_DB_PATH);
  });

  afterEach(() => {
    closeAdapterDb();
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
    const db = openAdapterDb(TEST_DB_PATH);
    db.prepare(`INSERT INTO contacts (email, domain, source, skool_member, skool_member_id, first_seen_skool)
                VALUES (?, ?, ?, 1, ?, ?)`).run("alice@example.com", "example.com", "skool_organic", "abc123", "2026-01-01T00:00:00Z");

    const records = [{ email: "Alice@Example.com", first_name: "Alice", company_name: "Venue A", website: "example.com" }];
    loadColdLeads(records);

    const row = db.prepare("SELECT * FROM contacts WHERE email = ?").get("alice@example.com");
    expect(row.cold_outreach_lead).toBe(1);
    expect(row.skool_member).toBe(1);
    expect(row.skool_member_id).toBe("abc123");
    expect(row.source).toBe("skool_organic");
  });

  it("checkOverlaps returns emails that are skool members", () => {
    const db = openAdapterDb(TEST_DB_PATH);
    db.prepare(`INSERT INTO contacts (email, domain, source, cold_outreach_lead, skool_member)
                VALUES (?, ?, ?, 1, 1)`).run("overlap@test.com", "test.com", "cold_outreach");
    db.prepare(`INSERT INTO contacts (email, domain, source, cold_outreach_lead)
                VALUES (?, ?, ?, 1)`).run("nooverlap@test.com", "test.com", "cold_outreach");

    const overlaps = checkOverlaps(["overlap@test.com", "nooverlap@test.com", "unknown@test.com"]);
    expect(overlaps).toEqual(["overlap@test.com"]);
  });

  it("markSuppressed sets smartlead_suppressed=1", () => {
    const db = openAdapterDb(TEST_DB_PATH);
    db.prepare(`INSERT INTO contacts (email, domain, source, cold_outreach_lead)
                VALUES (?, ?, ?, 1)`).run("test@test.com", "test.com", "cold_outreach");

    markSuppressed(["test@test.com"]);

    const row = db.prepare("SELECT smartlead_suppressed FROM contacts WHERE email = ?").get("test@test.com");
    expect(row.smartlead_suppressed).toBe(1);
  });
});
