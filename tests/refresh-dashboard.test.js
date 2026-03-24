import { describe, it, expect, beforeEach, vi } from "vitest";
import { latestFile, buildFunnel } from "../scripts/refresh-dashboard.js";

describe("refresh-dashboard", () => {
  describe("latestFile", () => {
    it("should return null when no files match the glob pattern", () => {
      const result = latestFile("data/reports/nonexistent_*.json");
      expect(result).toBeNull();
    });
  });

  describe("buildFunnel", () => {
    it("should map funnel report stages to simplified dashboard stages", () => {
      const funnelReport = {
        stages: [
          { name: "GeoLead net-new", path: "data/enriched/geolead_net_new.csv", count: 26539 },
          { name: "Post pre-filter", path: "data/filtered/leads.csv", count: 14052 },
          { name: "Classified venues", path: "data/classified/venues.csv", count: 8958 },
          { name: "Phone: mobile", path: "data/phone_validated/mobile.csv", count: 3200 },
          { name: "Phone: landline", path: "data/phone_validated/landline.csv", count: 2100 },
          { name: "Phone: invalid", path: "data/phone_validated/invalid.csv", count: 500 },
          { name: "Phone: no phone", path: "data/phone_validated/no_phone.csv", count: 1000 },
        ],
      };

      const result = buildFunnel(funnelReport, null);
      expect(result.stages).toHaveLength(6);
      expect(result.stages[0]).toEqual({ name: "raw", count: 26539, conversionRate: null });
      expect(result.stages[1]).toEqual({ name: "filtered", count: 14052, conversionRate: 0.529 });
      expect(result.stages[2]).toEqual({ name: "classified", count: 8958, conversionRate: 0.637 });
      // validated = sum of all phone stages
      expect(result.stages[3].name).toBe("validated");
      expect(result.stages[3].count).toBe(6800);
    });

    it("should return zero counts when no data available", () => {
      const result = buildFunnel(null, null);
      expect(result.stages).toHaveLength(6);
      expect(result.stages.every(s => s.count === 0)).toBe(true);
    });
  });
});
