import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { loadAndNormalize, runLayers, scoreCluster, selectKeepRecord, buildClusterOutput } = require("./dedup_audit.js");
const { UnionFind } = require("../shared/dedup-helpers.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("loadAndNormalize", () => {
  it("loads CSV and assigns _id to each record", () => {
    const testCsv = path.join(__dirname, "..", "test-fixtures", "dedup_test_input.csv");
    const records = loadAndNormalize(testCsv);
    expect(records.length).toBeGreaterThan(0);
    expect(records[0]).toHaveProperty("_id", 0);
    expect(records[0]).toHaveProperty("_email");
    expect(records[0]).toHaveProperty("_domain");
    expect(records[0]).toHaveProperty("_phone");
    expect(records[0]).toHaveProperty("_companyNorm");
  });
});

describe("runLayers", () => {
  const records = [
    { _id: 0, _email: "john@venue.com", _domain: "venue.com", _phone: "", _companyNorm: "grand ballroom", _state: "TX", _city: "Austin", source: "smartlead", _source: "smartlead" },
    { _id: 1, _email: "john@venue.com", _domain: "other.com", _phone: "", _companyNorm: "other place", _state: "CA", _city: "LA", source: "anymailfinder", _source: "anymailfinder" },
    { _id: 2, _email: "a@foo.com", _domain: "foo.com", _phone: "5551234567", _companyNorm: "alpha", _state: "NY", _city: "NYC", source: "smartlead", _source: "smartlead" },
    { _id: 3, _email: "b@bar.com", _domain: "bar.com", _phone: "5551234567", _companyNorm: "beta", _state: "NY", _city: "NYC", source: "geolead", _source: "geolead" },
    { _id: 4, _email: "info@grand.com", _domain: "grand.com", _phone: "", _companyNorm: "grand ballroom", _state: "FL", _city: "Miami", source: "anymailfinder", _source: "anymailfinder" },
    { _id: 5, _email: "info@thegrand.com", _domain: "thegrand.com", _phone: "", _companyNorm: "grand ballroom", _state: "FL", _city: "Miami", source: "geolead", _source: "geolead" },
    { _id: 6, _email: "solo@unique.com", _domain: "unique.com", _phone: "", _companyNorm: "unique place", _state: "WA", _city: "Seattle", source: "smartlead", _source: "smartlead" },
    { _id: 7, _email: "alice@sameco.com", _domain: "sameco.com", _phone: "", _companyNorm: "same co", _state: "OR", _city: "Portland", source: "anymailfinder", _source: "anymailfinder" },
    { _id: 8, _email: "bob@sameco.com", _domain: "sameco.com", _phone: "", _companyNorm: "same co", _state: "OR", _city: "Portland", source: "anymailfinder", _source: "anymailfinder" },
    { _id: 9, _email: "x@nogeo1.com", _domain: "nogeo1.com", _phone: "", _companyNorm: "rose garden", _state: "", _city: "", source: "geolead", _source: "geolead" },
    { _id: 10, _email: "y@nogeo2.com", _domain: "nogeo2.com", _phone: "", _companyNorm: "rose gardenn", _state: "", _city: "", source: "geolead", _source: "geolead" },
  ];

  it("detects exact email cluster", () => {
    const uf = runLayers(records);
    expect(uf.find(0)).toBe(uf.find(1));
  });
  it("detects phone match cluster", () => {
    const uf = runLayers(records);
    expect(uf.find(2)).toBe(uf.find(3));
  });
  it("detects cross-domain same name cluster", () => {
    const uf = runLayers(records);
    expect(uf.find(4)).toBe(uf.find(5));
  });
  it("does not merge singleton", () => {
    const uf = runLayers(records);
    const comp = uf.components();
    const singletonInCluster = comp.some(c => c.ids.includes(6));
    expect(singletonInCluster).toBe(false);
  });
  it("does not merge same-source same-domain different-email records (Layer 2)", () => {
    const uf = runLayers(records);
    expect(uf.find(7)).not.toBe(uf.find(8));
  });
  it("skips records with no geo from fuzzy name matching (Layer 4)", () => {
    const uf = runLayers(records);
    expect(uf.find(9)).not.toBe(uf.find(10));
  });
});

describe("scoreCluster", () => {
  it("exact_email gives 100", () => { expect(scoreCluster(["exact_email"])).toBe(100); });
  it("domain + phone gives 95", () => { expect(scoreCluster(["domain_match", "phone_match"])).toBe(95); });
  it("domain alone gives 90", () => { expect(scoreCluster(["domain_match"])).toBe(90); });
  it("phone + fuzzy_name gives 85", () => { expect(scoreCluster(["phone_match", "fuzzy_name+geo"])).toBe(85); });
  it("phone alone gives 80", () => { expect(scoreCluster(["phone_match"])).toBe(80); });
  it("cross_domain_name gives 80", () => { expect(scoreCluster(["cross_domain_name"])).toBe(80); });
  it("fuzzy_name+geo alone gives 70", () => { expect(scoreCluster(["fuzzy_name+geo"])).toBe(70); });
});

describe("selectKeepRecord", () => {
  it("prefers record with higher score", () => {
    const records = [
      { _id: 0, _score: 42, _phone: "", _firstName: "", _lastName: "", _companyNorm: "", _city: "", _state: "", _pipelineStage: "", _source: "geolead" },
      { _id: 1, _score: 87, _phone: "", _firstName: "", _lastName: "", _companyNorm: "", _city: "", _state: "", _pipelineStage: "", _source: "geolead" },
    ];
    expect(selectKeepRecord(records)).toBe(1);
  });

  it("falls back to richness when scores are equal", () => {
    const records = [
      { _id: 0, _score: 0, _phone: "", _firstName: "", _lastName: "", _companyNorm: "", _city: "", _state: "", _pipelineStage: "", _source: "geolead" },
      { _id: 1, _score: 0, _phone: "5551234567", _firstName: "Jane", _lastName: "Doe", _companyNorm: "acme", _city: "Austin", _state: "TX", _pipelineStage: "enriched", _source: "geolead" },
    ];
    expect(selectKeepRecord(records)).toBe(1);
  });

  it("breaks tie with source preference", () => {
    const records = [
      { _id: 0, _score: 0, _phone: "", _firstName: "", _lastName: "", _companyNorm: "", _city: "", _state: "", _pipelineStage: "", _source: "geolead" },
      { _id: 1, _score: 0, _phone: "", _firstName: "", _lastName: "", _companyNorm: "", _city: "", _state: "", _pipelineStage: "", _source: "smartlead" },
    ];
    expect(selectKeepRecord(records)).toBe(1);
  });
});

describe("buildClusterOutput", () => {
  it("returns correct cluster structure for two united records", () => {
    const uf = new UnionFind(2);
    uf.union(0, 1, "exact_email");
    const records = [
      { _id: 0, _score: 0, _phone: "", _firstName: "", _lastName: "", _companyNorm: "", _city: "", _state: "", _pipelineStage: "", _source: "geolead" },
      { _id: 1, _score: 0, _phone: "", _firstName: "", _lastName: "", _companyNorm: "", _city: "", _state: "", _pipelineStage: "", _source: "geolead" },
    ];
    const { clusters, summary } = buildClusterOutput(uf, records);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].confidence).toBe(100);
    expect(clusters[0].records).toHaveLength(2);
    expect(summary.totalClusters).toBe(1);
  });
});
