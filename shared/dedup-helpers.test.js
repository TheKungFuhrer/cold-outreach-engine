import { describe, it, expect } from "vitest";
import { UnionFind } from "./dedup-helpers.js";

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
