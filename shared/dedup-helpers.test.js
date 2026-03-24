import { describe, it, expect } from "vitest";
import { UnionFind, levenshtein, tokenOverlap, normalizeCompanyName, normalizePhone } from "./dedup-helpers.js";

describe("UnionFind", () => {
  it("find returns element itself initially", () => {
    const uf = new UnionFind(5);
    expect(uf.find(0)).toBe(0);
    expect(uf.find(4)).toBe(4);
  });

  it("union merges two components", () => {
    const uf = new UnionFind(5);
    uf.union(0, 1, "test_reason");
    expect(uf.find(0)).toBe(uf.find(1));
  });

  it("union is transitive", () => {
    const uf = new UnionFind(5);
    uf.union(0, 1, "reason_a");
    uf.union(1, 2, "reason_b");
    expect(uf.find(0)).toBe(uf.find(2));
  });

  it("components returns only multi-member groups", () => {
    const uf = new UnionFind(5);
    uf.union(0, 1, "r1");
    uf.union(3, 4, "r2");
    const comps = uf.components();
    expect(comps).toHaveLength(2);
    expect(comps.map(c => c.ids.sort())).toEqual(
      expect.arrayContaining([[0, 1], [3, 4]])
    );
  });

  it("tracks reasons per component", () => {
    const uf = new UnionFind(5);
    uf.union(0, 1, "exact_email");
    uf.union(0, 2, "domain_match");
    const comps = uf.components();
    expect(comps[0].reasons).toEqual(
      expect.arrayContaining(["exact_email", "domain_match"])
    );
  });

  it("does not duplicate reasons", () => {
    const uf = new UnionFind(5);
    uf.union(0, 1, "exact_email");
    uf.union(0, 2, "exact_email");
    const comps = uf.components();
    expect(comps[0].reasons).toEqual(["exact_email"]);
  });
});

describe("levenshtein", () => {
  it("identical strings return 0", () => {
    expect(levenshtein("hello", "hello")).toBe(0);
  });
  it("single character difference", () => {
    expect(levenshtein("cat", "bat")).toBe(1);
  });
  it("insertion", () => {
    expect(levenshtein("cat", "cats")).toBe(1);
  });
  it("deletion", () => {
    expect(levenshtein("cats", "cat")).toBe(1);
  });
  it("empty strings", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
    expect(levenshtein("", "")).toBe(0);
  });
  it("grand ballroom typo", () => {
    expect(levenshtein("grand ballroom", "grand balroom")).toBe(1);
  });
  it("short-circuits on length difference > threshold when using threshold", () => {
    expect(levenshtein("a", "abcdef")).toBe(5);
  });
});

describe("tokenOverlap", () => {
  it("identical tokens return 1.0", () => {
    expect(tokenOverlap("grand ballroom", "grand ballroom")).toBe(1.0);
  });
  it("partial overlap", () => {
    expect(tokenOverlap("grand ballroom event center", "grand ballroom events")).toBeCloseTo(0.4, 1);
  });
  it("no overlap returns 0", () => {
    expect(tokenOverlap("alpha beta", "gamma delta")).toBe(0);
  });
  it("empty strings return 0", () => {
    expect(tokenOverlap("", "hello")).toBe(0);
    expect(tokenOverlap("", "")).toBe(0);
  });
});

describe("normalizeCompanyName", () => {
  it("strips LLC suffix", () => {
    expect(normalizeCompanyName("Grand Ballroom LLC")).toBe("grand ballroom");
  });
  it("strips Inc. suffix", () => {
    expect(normalizeCompanyName("Rosewood Events Inc.")).toBe("rosewood events");
  });
  it("strips leading The", () => {
    expect(normalizeCompanyName("The Grand Ballroom")).toBe("grand ballroom");
  });
  it("strips multiple suffixes and leading The", () => {
    expect(normalizeCompanyName("The Grand Ballroom, LLC")).toBe("grand ballroom");
  });
  it("lowercases", () => {
    expect(normalizeCompanyName("ROSE GARDEN")).toBe("rose garden");
  });
  it("handles empty/null", () => {
    expect(normalizeCompanyName("")).toBe("");
    expect(normalizeCompanyName(null)).toBe("");
  });
  it("trims whitespace and punctuation", () => {
    expect(normalizeCompanyName("  Grand Ballroom,  ")).toBe("grand ballroom");
  });
});

describe("normalizePhone", () => {
  it("strips non-digits", () => {
    expect(normalizePhone("+1 (555) 123-4567")).toBe("15551234567");
  });
  it("returns empty for short numbers", () => {
    expect(normalizePhone("123")).toBe("");
  });
  it("returns empty for empty/null", () => {
    expect(normalizePhone("")).toBe("");
    expect(normalizePhone(null)).toBe("");
  });
  it("passes through 10-digit number", () => {
    expect(normalizePhone("5551234567")).toBe("5551234567");
  });
});
