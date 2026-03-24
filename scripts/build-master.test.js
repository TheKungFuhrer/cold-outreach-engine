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

const {
  computePipelineStage,
  enrichRecords,
  filterRecords,
  buildTags,
  confidenceTier,
  buildDomainEmailsLookup,
  exportGhlContacts,
  exportGhlCompanies,
  exportGhlOpportunities,
  STAGE_RANK,
  createMergeMap,
  mergeIntoMap,
} = require("./build-master");

describe("computePipelineStage", () => {
  it("returns in_campaign when engagement exists", () => {
    expect(computePipelineStage({ _has_engagement: "yes" })).toBe("in_campaign");
  });

  it("returns uploaded when in_smartlead", () => {
    expect(computePipelineStage({ _in_smartlead: "yes" })).toBe("uploaded");
  });

  it("returns raw for anymailfinder emails (enriched stage removed)", () => {
    expect(computePipelineStage({ email_source: "anymailfinder_original" })).toBe("raw");
  });

  it("returns validated when phone_type set", () => {
    expect(computePipelineStage({ phone_type: "mobile" })).toBe("validated");
  });

  it("returns classified when is_venue set", () => {
    expect(computePipelineStage({ is_venue: "true" })).toBe("classified");
  });

  it("returns filtered when _is_filtered set", () => {
    expect(computePipelineStage({ _is_filtered: "yes" })).toBe("filtered");
  });

  it("returns raw for empty record", () => {
    expect(computePipelineStage({})).toBe("raw");
  });

  it("highest stage wins — engagement beats everything", () => {
    expect(computePipelineStage({
      _has_engagement: "yes",
      _in_smartlead: "yes",
      phone_type: "mobile",
      is_venue: "true",
    })).toBe("in_campaign");
  });
});

describe("confidenceTier", () => {
  it("high >= 0.85", () => expect(confidenceTier("0.95")).toBe("high"));
  it("medium >= 0.7", () => expect(confidenceTier("0.75")).toBe("medium"));
  it("low < 0.7", () => expect(confidenceTier("0.5")).toBe("low"));
  it("empty string returns empty", () => expect(confidenceTier("")).toBe(""));
});

describe("buildTags", () => {
  it("includes phone type, source, confidence tier", () => {
    const tags = buildTags({ phone_type: "mobile", source: "geolead", confidence: "0.9" });
    expect(tags).toBe("mobile,geolead,confidence_high");
  });

  it("handles missing fields", () => {
    expect(buildTags({})).toBe("");
  });
});

describe("filterRecords", () => {
  const records = [
    { score: "80", pipeline_stage: "validated" },
    { score: "30", pipeline_stage: "classified" },
    { score: "", pipeline_stage: "raw" },
  ];

  it("filters by min score", () => {
    const result = filterRecords(records, 50, "raw");
    expect(result.length).toBe(1);
    expect(result[0].score).toBe("80");
  });

  it("filters by min stage", () => {
    const result = filterRecords(records, 0, "classified");
    expect(result.length).toBe(2);
  });

  it("no filter returns all", () => {
    expect(filterRecords(records, 0, "raw").length).toBe(3);
  });
});

describe("buildDomainEmailsLookup", () => {
  it("groups emails by domain", () => {
    const records = [
      { domain: "example.com", email: "a@example.com" },
      { domain: "example.com", email: "b@example.com" },
      { domain: "other.com", email: "c@other.com" },
    ];
    const lookup = buildDomainEmailsLookup(records);
    expect(lookup.get("example.com").size).toBe(2);
    expect(lookup.get("other.com").size).toBe(1);
  });
});

describe("enrichRecords", () => {
  it("computes pipeline_stage and last_updated for each record", () => {
    const map = createMergeMap();
    mergeIntoMap(map, {
      domain: "venue.com",
      email: "info@venue.com",
      company_name: "Venue",
      is_venue: "true",
      location_raw: "Austin, TX 78701",
    });

    const records = enrichRecords(map);
    expect(records.length).toBe(1);
    expect(records[0].pipeline_stage).toBe("classified");
    expect(records[0].last_updated).toBeTruthy();
    expect(records[0].city).toBe("Austin");
    expect(records[0].state).toBe("TX");
    expect(records[0].zip).toBe("78701");
  });
});

describe("mergeIntoMap forceFields (verified/escalated overwrite)", () => {
  it("overwrites classification fields when forceFields specified", () => {
    const map = createMergeMap();

    // Initial classification — ambiguous
    mergeIntoMap(map, {
      domain: "example.com",
      email: "info@example.com",
      is_venue: "false",
      confidence: "0.5",
      classification_reasoning: "Ambiguous",
    });

    // Escalation upgrades it — use forceFields to overwrite
    mergeIntoMap(map, {
      domain: "example.com",
      email: "info@example.com",
      is_venue: "true",
      confidence: "0.9",
      classification_reasoning: "Confirmed venue after Sonnet review",
    }, ["is_venue", "confidence", "classification_reasoning"]);

    const record = map.get("example.com").get("info@example.com");
    expect(record.is_venue).toBe("true");
    expect(record.confidence).toBe("0.9");
    expect(record.classification_reasoning).toBe("Confirmed venue after Sonnet review");
  });

  it("does not overwrite non-forced fields", () => {
    const map = createMergeMap();
    mergeIntoMap(map, {
      domain: "example.com",
      email: "info@example.com",
      company_name: "Original Name",
      is_venue: "false",
    });
    mergeIntoMap(map, {
      domain: "example.com",
      email: "info@example.com",
      company_name: "Different Name",
      is_venue: "true",
    }, ["is_venue"]);

    const record = map.get("example.com").get("info@example.com");
    expect(record.is_venue).toBe("true"); // forced
    expect(record.company_name).toBe("Original Name"); // not forced
  });
});

describe("GHL export functions", () => {
  it("exportGhlContacts produces correct row structure", () => {
    // Mock writeCsv to capture output
    const csv = require("../shared/csv");
    let capturedRows;
    const origWrite = csv.writeCsv;
    csv.writeCsv = (path, rows, cols) => { capturedRows = rows; };

    const records = [{
      domain: "venue.com", email: "a@venue.com", first_name: "John", last_name: "Smith",
      company_name: "Venue", phone: "555-1234", source: "geolead",
      classification_reasoning: "Event venue", confidence: "0.9", phone_type: "mobile",
    }];
    const domainEmails = new Map([["venue.com", new Set(["a@venue.com", "b@venue.com"])]]);

    exportGhlContacts(records, domainEmails);
    csv.writeCsv = origWrite;

    expect(capturedRows.length).toBe(1);
    expect(capturedRows[0]["Email"]).toBe("a@venue.com");
    expect(capturedRows[0]["Business Name"]).toBe("Venue");
    expect(capturedRows[0]["Additional Emails"]).toBe("b@venue.com");
    expect(capturedRows[0]["Tags"]).toContain("mobile");
    expect(capturedRows[0]["Tags"]).toContain("confidence_high");
  });

  it("exportGhlCompanies produces one row per domain", () => {
    const csv = require("../shared/csv");
    let capturedRows;
    const origWrite = csv.writeCsv;
    csv.writeCsv = (path, rows, cols) => { capturedRows = rows; };

    const records = [
      { domain: "venue.com", email: "a@venue.com", company_name: "Venue", phone: "555-1234", website: "venue.com", city: "Austin", state: "TX", zip: "78701", location_raw: "Austin, TX 78701" },
      { domain: "venue.com", email: "b@venue.com", company_name: "Venue" },
      { domain: "other.com", email: "c@other.com", company_name: "Other" },
    ];

    exportGhlCompanies(records);
    csv.writeCsv = origWrite;

    expect(capturedRows.length).toBe(2);
    expect(capturedRows[0]["Company Name"]).toBe("Venue");
    expect(capturedRows[0]["Country"]).toBe("US");
    expect(capturedRows[0]["Postal Code"]).toBe("78701");
    expect(capturedRows[1]["Company Name"]).toBe("Other");
  });

  it("exportGhlOpportunities has Lead Value 75", () => {
    const csv = require("../shared/csv");
    let capturedRows;
    const origWrite = csv.writeCsv;
    csv.writeCsv = (path, rows, cols) => { capturedRows = rows; };

    exportGhlOpportunities([{
      company_name: "Venue", phone: "555-1234", email: "a@venue.com",
      source: "geolead", score: "80", pipeline_stage: "validated", confidence: "0.9",
      phone_type: "mobile",
    }]);
    csv.writeCsv = origWrite;

    expect(capturedRows.length).toBe(1);
    expect(capturedRows[0]["Lead Value"]).toBe("75");
    expect(capturedRows[0]["Status"]).toBe("open");
    expect(capturedRows[0]["Notes"]).toContain("score: 80");
  });
});
