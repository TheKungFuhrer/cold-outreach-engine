import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { openDb, closeDb, SCHEMA_VERSION } from "./identity-db.js";
import { openDb as openAdapterDb, closeDb as closeAdapterDb, loadColdLeads, checkOverlaps, markSuppressed, getStats } from "./identity.js";
import { openDb as openSkoolDb, closeDb as closeSkoolDb, loadSkoolMembers, getUntaggedOverlaps, markTagged, detectSource } from "../../skool-engine/scripts/lib/identity.js";

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

describe("skool identity adapter", () => {
  beforeEach(() => {
    openSkoolDb(TEST_DB_PATH);
  });

  afterEach(() => {
    closeSkoolDb();
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

  it("loadSkoolMembers inserts GHL contacts with skool_member=1", () => {
    const ghlContacts = [
      {
        id: "ghl_001",
        email: "Jane@Venue.com",
        firstName: "Jane",
        lastName: "Doe",
        phone: "+15551234567",
        companyName: "Doe Venue",
        website: "doevenue.com",
        tags: ["skool"],
      },
    ];
    const result = loadSkoolMembers(ghlContacts);
    expect(result.inserted).toBe(1);
    expect(result.skipped).toBe(0);

    const db = openSkoolDb(TEST_DB_PATH);
    const row = db.prepare("SELECT * FROM contacts WHERE email = ?").get("jane@venue.com");
    expect(row.skool_member).toBe(1);
    expect(row.ghl_contact_id).toBe("ghl_001");
    expect(row.first_name).toBe("Jane");
    expect(row.company_name).toBe("Doe Venue");
  });

  it("loadSkoolMembers skips contacts without email", () => {
    const ghlContacts = [
      { id: "ghl_002", email: "", firstName: "No", lastName: "Email", tags: ["skool"] },
      { id: "ghl_003", email: "has@email.com", firstName: "Has", lastName: "Email", tags: ["skool"] },
    ];
    const result = loadSkoolMembers(ghlContacts);
    expect(result.inserted).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("loadSkoolMembers upserts without overwriting cold outreach data", () => {
    const db = openSkoolDb(TEST_DB_PATH);
    db.prepare(`INSERT INTO contacts (email, domain, source, cold_outreach_lead, first_seen_cold)
                VALUES (?, ?, ?, 1, ?)`).run("overlap@test.com", "test.com", "cold_outreach", "2026-01-01T00:00:00Z");

    const ghlContacts = [
      { id: "ghl_004", email: "Overlap@Test.com", firstName: "Over", lastName: "Lap", tags: ["skool"] },
    ];
    loadSkoolMembers(ghlContacts);

    const row = db.prepare("SELECT * FROM contacts WHERE email = ?").get("overlap@test.com");
    expect(row.cold_outreach_lead).toBe(1);
    expect(row.skool_member).toBe(1);
    expect(row.source).toBe("cold_outreach"); // source not overwritten
    expect(row.ghl_contact_id).toBe("ghl_004");
  });

  it("getUntaggedOverlaps returns overlaps with ghl_contact_id", () => {
    const db = openSkoolDb(TEST_DB_PATH);
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
    const db = openSkoolDb(TEST_DB_PATH);
    db.prepare(`INSERT INTO contacts (email, domain, source, cold_outreach_lead, skool_member, ghl_contact_id, ghl_tagged)
                VALUES (?, ?, ?, 1, 1, ?, 0)`).run("tag-me@test.com", "test.com", "cold_outreach", "ghl_101");

    markTagged("tag-me@test.com");

    const row = db.prepare("SELECT ghl_tagged FROM contacts WHERE email = ?").get("tag-me@test.com");
    expect(row.ghl_tagged).toBe(1);
  });
});
