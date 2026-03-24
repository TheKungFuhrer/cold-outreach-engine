import { describe, it, expect } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const {
  STAGE_RANK,
  MASTER_COLUMNS,
  COMPANY_FIELDS,
  createMergeMap,
  mergeIntoMap,
  stripEmpty,
  queryByStage,
  promoteLeads,
} = require("./master");

describe("STAGE_RANK", () => {
  it("has correct ordering with exported stage", () => {
    expect(STAGE_RANK).toEqual({
      raw: 0,
      filtered: 1,
      classified: 2,
      validated: 3,
      exported: 4,
      uploaded: 5,
      in_campaign: 6,
    });
  });

  it("does NOT include enriched", () => {
    expect(STAGE_RANK).not.toHaveProperty("enriched");
  });
});

describe("queryByStage", () => {
  it("returns only records at the specified stage", () => {
    const map = createMergeMap();
    mergeIntoMap(map, {
      domain: "venue-a.com",
      email: "a@venue-a.com",
      pipeline_stage: "classified",
    });
    mergeIntoMap(map, {
      domain: "venue-b.com",
      email: "b@venue-b.com",
      pipeline_stage: "validated",
    });
    mergeIntoMap(map, {
      domain: "venue-c.com",
      email: "c@venue-c.com",
      pipeline_stage: "classified",
    });

    const results = queryByStage(map, "classified");
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.domain).sort()).toEqual([
      "venue-a.com",
      "venue-c.com",
    ]);
  });

  it("returns empty array when no match", () => {
    const map = createMergeMap();
    mergeIntoMap(map, {
      domain: "venue-a.com",
      email: "a@venue-a.com",
      pipeline_stage: "raw",
    });

    const results = queryByStage(map, "uploaded");
    expect(results).toEqual([]);
  });
});

describe("promoteLeads", () => {
  it("promotes leads to higher stage", () => {
    const map = createMergeMap();
    mergeIntoMap(map, {
      domain: "venue-a.com",
      email: "a@venue-a.com",
      pipeline_stage: "classified",
    });

    const count = promoteLeads(
      map,
      [{ domain: "venue-a.com", email: "a@venue-a.com" }],
      "validated"
    );
    expect(count).toBe(1);

    const record = map.get("venue-a.com").get("a@venue-a.com");
    expect(record.pipeline_stage).toBe("validated");
    expect(record.last_updated).toBeTruthy();
  });

  it("does NOT demote to lower stage", () => {
    const map = createMergeMap();
    mergeIntoMap(map, {
      domain: "venue-a.com",
      email: "a@venue-a.com",
      pipeline_stage: "uploaded",
    });

    const count = promoteLeads(
      map,
      [{ domain: "venue-a.com", email: "a@venue-a.com" }],
      "classified"
    );
    expect(count).toBe(0);

    const record = map.get("venue-a.com").get("a@venue-a.com");
    expect(record.pipeline_stage).toBe("uploaded");
  });

  it("skips leads not in map", () => {
    const map = createMergeMap();
    mergeIntoMap(map, {
      domain: "venue-a.com",
      email: "a@venue-a.com",
      pipeline_stage: "raw",
    });

    const count = promoteLeads(
      map,
      [
        { domain: "venue-a.com", email: "a@venue-a.com" },
        { domain: "unknown.com", email: "x@unknown.com" },
      ],
      "filtered"
    );
    expect(count).toBe(1);
  });
});
