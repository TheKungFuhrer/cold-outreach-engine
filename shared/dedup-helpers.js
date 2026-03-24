/**
 * Union-Find (Disjoint Set Union) with path compression and reason tracking.
 */
class UnionFind {
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

function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (a.length > b.length) { const t = a; a = b; b = t; }
  const m = a.length;
  const n = b.length;
  const row = new Uint16Array(m + 1);
  for (let i = 0; i <= m; i++) row[i] = i;
  for (let j = 1; j <= n; j++) {
    let prev = row[0];
    row[0] = j;
    for (let i = 1; i <= m; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min(row[i] + 1, row[i - 1] + 1, prev + cost);
      prev = row[i];
      row[i] = val;
    }
  }
  return row[m];
}

function tokenOverlap(a, b) {
  if (!a || !b) return 0;
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const tok of setA) { if (setB.has(tok)) intersection++; }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function normalizeCompanyName(name) {
  if (!name) return "";
  let s = String(name).toLowerCase().trim();
  s = s.replace(/[,\s]+(llc|inc\.?|corp\.?|ltd\.?|co\.?|l\.?l\.?c\.?|incorporated|corporation|limited|company)\s*\.?\s*$/i, "");
  s = s.replace(/^the\s+/i, "");
  s = s.replace(/[,.\s]+$/, "").trim();
  return s;
}

function normalizePhone(phone) {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  return digits.length >= 7 ? digits : "";
}

module.exports = {
  UnionFind, levenshtein, tokenOverlap,
  normalizeCompanyName, normalizePhone,
};
