import { describe, it, expect } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

// We'll test the merge functions once they exist
// For now, test the module loads and the merge map works correctly

describe("build-master merge logic", () => {
  it("mergeIntoMap creates new entry for unseen domain+email", () => {
    const { createMergeMap, mergeIntoMap } = require("./build-master");
    const map = createMergeMap();

    mergeIntoMap(map, {
      domain: "example.com",
      email: "john@example.com",
      first_name: "John",
      last_name: "Smith",
      company_name: "Example Venue",
      phone: "555-1234",
      website: "https://example.com",
      location_raw: "Austin, TX",
      source: "smartlead_original",
    });

    const record = map.get("example.com").get("john@example.com");
    expect(record.first_name).toBe("John");
    expect(record.company_name).toBe("Example Venue");
  });

  it("mergeIntoMap fills blanks but does not overwrite populated fields", () => {
    const { createMergeMap, mergeIntoMap } = require("./build-master");
    const map = createMergeMap();

    // First source — has name but no phone type
    mergeIntoMap(map, {
      domain: "example.com",
      email: "john@example.com",
      first_name: "John",
      last_name: "Smith",
      company_name: "Example Venue",
      phone: "555-1234",
      website: "https://example.com",
      source: "smartlead_original",
    });

    // Second source — has phone type, also has a different company_name
    mergeIntoMap(map, {
      domain: "example.com",
      email: "john@example.com",
      company_name: "Different Name",
      phone_type: "mobile",
      phone_carrier: "Verizon",
      is_venue: "true",
      confidence: "0.95",
      source: "geolead",
    });

    const record = map.get("example.com").get("john@example.com");
    expect(record.company_name).toBe("Example Venue"); // NOT overwritten
    expect(record.phone_type).toBe("mobile"); // filled in
    expect(record.phone_carrier).toBe("Verizon"); // filled in
    expect(record.is_venue).toBe("true"); // filled in
    expect(record.first_name).toBe("John"); // NOT overwritten
  });

  it("mergeIntoMap adds new email rows for same domain", () => {
    const { createMergeMap, mergeIntoMap } = require("./build-master");
    const map = createMergeMap();

    mergeIntoMap(map, {
      domain: "example.com",
      email: "john@example.com",
      company_name: "Example Venue",
      phone: "555-1234",
      is_venue: "true",
      source: "smartlead_original",
    });

    // AnyMailFinder discovers a new email for the same domain
    mergeIntoMap(map, {
      domain: "example.com",
      email: "info@example.com",
      company_name: "",
      email_source: "anymailfinder_original",
      source: "anymailfinder",
    });

    const domainMap = map.get("example.com");
    expect(domainMap.size).toBe(2);

    // New email row inherits company-level fields
    const infoRecord = domainMap.get("info@example.com");
    expect(infoRecord.company_name).toBe("Example Venue");
    expect(infoRecord.phone).toBe("555-1234");
    expect(infoRecord.is_venue).toBe("true");
    expect(infoRecord.email_source).toBe("anymailfinder_original");
  });

  it("createMergeMap returns empty Map", () => {
    const { createMergeMap } = require("./build-master");
    const map = createMergeMap();
    expect(map.size).toBe(0);
  });
});
