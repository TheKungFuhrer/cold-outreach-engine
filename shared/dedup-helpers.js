/**
 * Union-Find (Disjoint Set Union) with path compression and reason tracking.
 */
export class UnionFind {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, i) => i);
    this.rank = new Uint8Array(size);
    this.reasons = new Map(); // root -> Set<string>
  }

  find(x) {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]]; // path compression
      x = this.parent[x];
    }
    return x;
  }

  union(a, b, reason) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) {
      // Already same component — still record the reason
      if (reason) {
        if (!this.reasons.has(ra)) this.reasons.set(ra, new Set());
        this.reasons.get(ra).add(reason);
      }
      return;
    }
    // Union by rank
    let root, child;
    if (this.rank[ra] < this.rank[rb]) { root = rb; child = ra; }
    else if (this.rank[ra] > this.rank[rb]) { root = ra; child = rb; }
    else { root = ra; child = rb; this.rank[ra]++; }

    this.parent[child] = root;

    // Merge reasons
    const rootReasons = this.reasons.get(root) || new Set();
    const childReasons = this.reasons.get(child) || new Set();
    for (const r of childReasons) rootReasons.add(r);
    if (reason) rootReasons.add(reason);
    this.reasons.set(root, rootReasons);
    this.reasons.delete(child);
  }

  /** Returns array of { ids: number[], reasons: string[] } for components with 2+ members. */
  components() {
    const groups = new Map(); // root -> number[]
    for (let i = 0; i < this.parent.length; i++) {
      const root = this.find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(i);
    }
    const result = [];
    for (const [root, ids] of groups) {
      if (ids.length < 2) continue;
      const reasons = this.reasons.get(root);
      result.push({ ids, reasons: reasons ? [...reasons] : [] });
    }
    return result;
  }
}
