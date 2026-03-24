import { describe, it, expect, beforeEach, vi } from "vitest";
import { latestFile, buildFunnel, buildCampaigns, buildScoreDistribution } from "../scripts/refresh-dashboard.js";

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

  describe("buildCampaigns", () => {
    it("should parse SmartLead string counts and compute rates", () => {
      const statsReport = {
        campaigns: [
          {
            id: "3071191",
            name: "Venues_AllSources_Mar26",
            campaign_lead_stats: { total: 5000 },
            sent_count: "4000",
            open_count: "960",
            reply_count: "36",
            bounce_count: "240",
            unsubscribed_count: "12",
          },
        ],
      };
      const result = buildCampaigns(statsReport);
      expect(result).toHaveLength(1);
      expect(result[0].sent).toBe(4000);
      expect(result[0].openRate).toBeCloseTo(0.24, 2);
      expect(result[0].replyRate).toBeCloseTo(0.009, 3);
      expect(result[0].bounceRate).toBeCloseTo(0.06, 2);
    });

    it("should return empty array when no report", () => {
      expect(buildCampaigns(null)).toEqual([]);
    });
  });

  describe("buildScoreDistribution", () => {
    it("should bucket scores into 10-point ranges", () => {
      const rows = [
        { score: "15" }, { score: "22" }, { score: "25" },
        { score: "55" }, { score: "88" }, { score: "92" },
      ];
      const result = buildScoreDistribution(rows);
      expect(result.buckets).toHaveLength(10);
      expect(result.buckets[1].count).toBe(1);  // 11-20
      expect(result.buckets[2].count).toBe(2);  // 21-30
      expect(result.mean).toBeCloseTo(49.5, 0);
      expect(result.median).toBeCloseTo(40, 0);
    });
  });
});
