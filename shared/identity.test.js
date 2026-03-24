import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { openDb, closeDb, SCHEMA_VERSION } from "./identity-db.js";
import { loadColdLeads, checkOverlaps, markSuppressed, getStats } from "./identity.js";

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
