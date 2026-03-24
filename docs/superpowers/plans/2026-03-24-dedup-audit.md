# Dedup Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `scripts/dedup_audit.js` — a multi-layer duplicate detection and merge tool for the 112K+ email master CSV.

**Architecture:** Single-pass layered matching using a union-find data structure. Five matching layers (exact email, normalized domain, phone, fuzzy company name within geo blocks, cross-domain name detection) build edges between records. Connected components become duplicate clusters with confidence scores. Conservative merge (confidence >= 80) with backup and SmartLead cleanup CSV.

**Tech Stack:** Node.js, csv-parse/csv-stringify (existing), shared utilities (csv.js, fields.js, dedup.js, utils.js). No new npm dependencies — Levenshtein and token overlap implemented from scratch.

**Spec:** `docs/superpowers/specs/2026-03-24-dedup-audit-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `scripts/dedup_audit.js` | Main script — CLI parsing, data loading, layer orchestration, output writing, merge logic |
| `shared/dedup-helpers.js` | Reusable utilities — UnionFind class, levenshtein(), tokenOverlap(), normalizeCompanyName(), normalizePhone() |
| `shared/dedup-helpers.test.js` | Unit tests for all dedup helper functions |
| `scripts/dedup_audit.test.js` | Integration tests for the full audit pipeline |

The helpers go in `shared/` because they're general-purpose string matching utilities that could be reused by other pipeline scripts. The main script stays in `scripts/` following the existing pattern (`scripts/build-master.js`).

---

### Task 1: UnionFind class and unit tests

**Files:**
- Create: `shared/dedup-helpers.js`
- Create: `shared/dedup-helpers.test.js`

- [ ] **Step 1: Write failing tests for UnionFind**

```js
// shared/dedup-helpers.test.js
const { describe, it, expect } = require("vitest");
const { UnionFind } = require("./dedup-helpers");

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/dedup-helpers.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement UnionFind**

```js
// shared/dedup-helpers.js (initial content — will be extended in later tasks)

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

module.exports = { UnionFind };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run shared/dedup-helpers.test.js`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add shared/dedup-helpers.js shared/dedup-helpers.test.js
git commit -m "feat: add UnionFind class with reason tracking for dedup audit"
```

---

### Task 2: String matching utilities — levenshtein, tokenOverlap, normalizeCompanyName, normalizePhone

**Files:**
- Modify: `shared/dedup-helpers.js`
- Modify: `shared/dedup-helpers.test.js`

- [ ] **Step 1: Write failing tests for all four functions**

Append to `shared/dedup-helpers.test.js`:

```js
const {
  UnionFind, levenshtein, tokenOverlap,
  normalizeCompanyName, normalizePhone,
} = require("./dedup-helpers");

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
    // Just verify correctness — the optimization is internal
    expect(levenshtein("a", "abcdef")).toBe(5);
  });
});

describe("tokenOverlap", () => {
  it("identical tokens return 1.0", () => {
    expect(tokenOverlap("grand ballroom", "grand ballroom")).toBe(1.0);
  });

  it("partial overlap", () => {
    // "grand ballroom event center" vs "grand ballroom events"
    // tokens: {grand, ballroom, event, center} vs {grand, ballroom, events}
    // intersection: {grand, ballroom} = 2, union: {grand, ballroom, event, center, events} = 5
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run shared/dedup-helpers.test.js`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement the four functions**

Add to `shared/dedup-helpers.js` before `module.exports`:

```js
/**
 * Levenshtein distance — single-row DP, O(min(m,n)) space.
 * Short-circuits when length difference alone exceeds maxDist (if provided).
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure a is the shorter string (smaller row allocation)
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
      const val = Math.min(
        row[i] + 1,        // deletion
        row[i - 1] + 1,    // insertion
        prev + cost         // substitution
      );
      prev = row[i];
      row[i] = val;
    }
  }
  return row[m];
}

/**
 * Jaccard similarity of word token sets.
 * Returns intersection/union ratio (0.0 to 1.0).
 */
function tokenOverlap(a, b) {
  if (!a || !b) return 0;
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const tok of setA) {
    if (setB.has(tok)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Normalize a company name for dedup comparison.
 * Lowercases, strips common suffixes (LLC, Inc, Corp, Ltd, Co, etc.),
 * strips leading "The ", trims whitespace and trailing punctuation.
 */
function normalizeCompanyName(name) {
  if (!name) return "";
  let s = String(name).toLowerCase().trim();
  // Strip common business suffixes (with optional preceding comma/space)
  s = s.replace(/[,\s]+(llc|inc\.?|corp\.?|ltd\.?|co\.?|l\.?l\.?c\.?|incorporated|corporation|limited|company)\s*\.?\s*$/i, "");
  // Strip leading "the "
  s = s.replace(/^the\s+/i, "");
  // Trim remaining whitespace and trailing punctuation
  s = s.replace(/[,.\s]+$/, "").trim();
  return s;
}

/**
 * Normalize a phone number to digits only.
 * Returns empty string if fewer than 7 digits (not a real phone).
 */
function normalizePhone(phone) {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  return digits.length >= 7 ? digits : "";
}
```

Update `module.exports`:

```js
module.exports = {
  UnionFind, levenshtein, tokenOverlap,
  normalizeCompanyName, normalizePhone,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run shared/dedup-helpers.test.js`
Expected: All tests PASS (6 UnionFind + 7 levenshtein + 4 tokenOverlap + 7 normalizeCompanyName + 4 normalizePhone = 28 tests)

- [ ] **Step 5: Commit**

```bash
git add shared/dedup-helpers.js shared/dedup-helpers.test.js
git commit -m "feat: add levenshtein, tokenOverlap, normalizeCompanyName, normalizePhone"
```

---

### Task 3: Matching layers and confidence scoring

**Files:**
- Create: `scripts/dedup_audit.js`
- Create: `scripts/dedup_audit.test.js`

This task builds the core of the script: data loading, the five matching layers, and confidence scoring. No merge or output writing yet — just the in-memory clustering.

- [ ] **Step 1: Write failing integration test for layer matching**

```js
// scripts/dedup_audit.test.js
const { describe, it, expect } = require("vitest");
const path = require("path");
const { loadAndNormalize, runLayers, scoreCluster } = require("./dedup_audit");

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
  // Build synthetic records to test each layer
  const records = [
    // Cluster A: exact email match (ids 0,1)
    { _id: 0, _email: "john@venue.com", _domain: "venue.com", _phone: "", _companyNorm: "grand ballroom", _state: "TX", _city: "Austin", source: "smartlead" },
    { _id: 1, _email: "john@venue.com", _domain: "other.com", _phone: "", _companyNorm: "other place", _state: "CA", _city: "LA", source: "anymailfinder" },
    // Cluster B: phone match (ids 2,3)
    { _id: 2, _email: "a@foo.com", _domain: "foo.com", _phone: "5551234567", _companyNorm: "alpha", _state: "NY", _city: "NYC", source: "smartlead" },
    { _id: 3, _email: "b@bar.com", _domain: "bar.com", _phone: "5551234567", _companyNorm: "beta", _state: "NY", _city: "NYC", source: "geolead" },
    // Cluster C: cross-domain same name (ids 4,5)
    { _id: 4, _email: "info@grand.com", _domain: "grand.com", _phone: "", _companyNorm: "grand ballroom", _state: "FL", _city: "Miami", source: "anymailfinder" },
    { _id: 5, _email: "info@thegrand.com", _domain: "thegrand.com", _phone: "", _companyNorm: "grand ballroom", _state: "FL", _city: "Miami", source: "geolead" },
    // Singleton: no matches (id 6)
    { _id: 6, _email: "solo@unique.com", _domain: "unique.com", _phone: "", _companyNorm: "unique place", _state: "WA", _city: "Seattle", source: "smartlead" },
    // Layer 2 negative: same source, same domain, different email — NOT duplicates (ids 7,8)
    { _id: 7, _email: "alice@sameco.com", _domain: "sameco.com", _phone: "", _companyNorm: "same co", _state: "OR", _city: "Portland", source: "anymailfinder" },
    { _id: 8, _email: "bob@sameco.com", _domain: "sameco.com", _phone: "", _companyNorm: "same co", _state: "OR", _city: "Portland", source: "anymailfinder" },
    // Layer 4 negative: no geo data — should be skipped from fuzzy matching (ids 9,10)
    { _id: 9, _email: "x@nogeo1.com", _domain: "nogeo1.com", _phone: "", _companyNorm: "rose garden", _state: "", _city: "", source: "geolead" },
    { _id: 10, _email: "y@nogeo2.com", _domain: "nogeo2.com", _phone: "", _companyNorm: "rose gardenn", _state: "", _city: "", source: "geolead" },
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
    // ids 7 and 8 share domain + source but have different emails — should NOT be merged
    expect(uf.find(7)).not.toBe(uf.find(8));
  });

  it("skips records with no geo from fuzzy name matching (Layer 4)", () => {
    const uf = runLayers(records);
    // ids 9 and 10 have similar names but no geo — should NOT be merged
    expect(uf.find(9)).not.toBe(uf.find(10));
  });
});

describe("scoreCluster", () => {
  it("exact_email gives 100", () => {
    expect(scoreCluster(["exact_email"])).toBe(100);
  });

  it("domain + phone gives 95", () => {
    expect(scoreCluster(["domain_match", "phone_match"])).toBe(95);
  });

  it("domain alone gives 90", () => {
    expect(scoreCluster(["domain_match"])).toBe(90);
  });

  it("phone + fuzzy_name gives 85", () => {
    expect(scoreCluster(["phone_match", "fuzzy_name+geo"])).toBe(85);
  });

  it("phone alone gives 80", () => {
    expect(scoreCluster(["phone_match"])).toBe(80);
  });

  it("cross_domain_name gives 80", () => {
    expect(scoreCluster(["cross_domain_name"])).toBe(80);
  });

  it("fuzzy_name+geo alone gives 70", () => {
    expect(scoreCluster(["fuzzy_name+geo"])).toBe(70);
  });
});
```

- [ ] **Step 2: Create test fixture CSV**

Run: `mkdir -p test-fixtures`

Create `test-fixtures/dedup_test_input.csv`:

```csv
email,first_name,last_name,company_name,phone,website,domain,city,state,source,pipeline_stage,score
john@grandballroom.com,John,Smith,Grand Ballroom LLC,+1 (512) 555-1234,https://www.grandballroom.com,grandballroom.com,Austin,TX,smartlead,classified,85
john@grandballroom.com,John,S,The Grand Ballroom,,grandballroom.com,grandballroom.com,Austin,TX,anymailfinder,enriched,
jane@grandballroom.com,Jane,Doe,Grand Ballroom LLC,512-555-1234,grandballroom.com,grandballroom.com,Austin,TX,anymailfinder,enriched,
info@thegrandballroom.com,,,Grand Ballroom,,thegrandballroom.com,thegrandballroom.com,Austin,TX,geolead,classified,42
solo@unique.com,Solo,Person,Unique Venue,999-888-7777,unique.com,unique.com,Seattle,WA,smartlead,uploaded,90
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run scripts/dedup_audit.test.js`
Expected: FAIL — module not found

- [ ] **Step 4: Implement dedup_audit.js — data loading, layers, scoring**

```js
#!/usr/bin/env node
/**
 * Dedup Audit — multi-layer duplicate detection and merge.
 *
 * Usage:
 *   node scripts/dedup_audit.js [options]
 *
 * Options:
 *   --input <csv>   Input CSV (default: data/master/leads_master.csv)
 *   --merge         Merge high-confidence clusters into master CSV
 *   --dry-run       With --merge, write reports but skip CSV rewrite
 */

const fs = require("fs");
const path = require("path");
const { readCsv, writeCsv } = require("../shared/csv");
const { resolveField } = require("../shared/fields");
const { normalizeDomain } = require("../shared/dedup");
const { projectPath, ensureDir, timestamp } = require("../shared/utils");
const {
  UnionFind, levenshtein, tokenOverlap,
  normalizeCompanyName, normalizePhone,
} = require("../shared/dedup-helpers");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Snake_case column names from build-master output. */
const BUILD_MASTER_FIELDS = {
  email: "email", firstName: "first_name", lastName: "last_name",
  companyName: "company_name", phone: "phone", website: "website",
  domain: "domain", city: "city", state: "state", source: "source",
  pipelineStage: "pipeline_stage", score: "score",
};

const STAGE_RANK = {
  raw: 0, filtered: 1, classified: 2, validated: 3,
  enriched: 4, uploaded: 5, in_campaign: 6,
};

const SOURCE_RANK = { smartlead: 3, anymailfinder: 2, geolead: 1 };

// ---------------------------------------------------------------------------
// Data Loading & Normalization
// ---------------------------------------------------------------------------

function loadAndNormalize(inputPath) {
  const { records, columns } = readCsv(inputPath);
  if (records.length === 0) {
    console.error("No records found in", inputPath);
    process.exit(1);
  }

  // Detect if this is a build-master CSV (has 'domain' column)
  const isBuildMaster = columns.includes("domain");

  return records.map((row, i) => {
    let email, firstName, lastName, companyName, phone, website, domain, city, state, source, pipelineStage, score;

    if (isBuildMaster) {
      email = (row.email || "").toLowerCase().trim();
      firstName = (row.first_name || "").trim();
      lastName = (row.last_name || "").trim();
      companyName = (row.company_name || "").trim();
      phone = row.phone || "";
      website = row.website || "";
      domain = row.domain || "";
      city = (row.city || "").trim();
      state = (row.state || "").trim().toUpperCase();
      source = (row.source || "").trim();
      pipelineStage = (row.pipeline_stage || "").trim();
      score = parseFloat(row.score) || 0;
    } else {
      email = resolveField(row, "email").toLowerCase().trim();
      firstName = resolveField(row, "firstName").trim();
      lastName = resolveField(row, "lastName").trim();
      companyName = resolveField(row, "companyName").trim();
      phone = resolveField(row, "phone");
      website = resolveField(row, "website");
      city = ""; state = "";
      const loc = resolveField(row, "location");
      if (loc) {
        const m = loc.match(/([^,]+),\s*([A-Z]{2})/i);
        if (m) { city = m[1].trim(); state = m[2].toUpperCase(); }
      }
      source = row.source || "";
      pipelineStage = row.pipeline_stage || "";
      score = parseFloat(row.score) || 0;
    }

    return {
      ...row, // preserve all original columns
      _id: i,
      _email: email,
      _domain: domain ? normalizeDomain(domain) : normalizeDomain(website),
      _phone: normalizePhone(phone),
      _companyNorm: normalizeCompanyName(companyName),
      _firstName: firstName,
      _lastName: lastName,
      _city: city,
      _state: state,
      _source: source.toLowerCase(),
      _pipelineStage: pipelineStage,
      _score: score,
    };
  });
}

// ---------------------------------------------------------------------------
// Matching Layers
// ---------------------------------------------------------------------------

function runLayers(records) {
  const uf = new UnionFind(records.length);
  let unions;

  // Layer 1: Exact email
  unions = 0;
  const emailIndex = new Map();
  for (const r of records) {
    if (!r._email) continue;
    if (emailIndex.has(r._email)) {
      uf.union(emailIndex.get(r._email), r._id, "exact_email");
      unions++;
    } else {
      emailIndex.set(r._email, r._id);
    }
  }
  console.log(`  Layer 1 (exact_email): ${unions} unions`);

  // Layer 2: Normalized domain — cross-source only
  unions = 0;
  const domainIndex = new Map(); // domain -> [{_id, _email, _source}]
  for (const r of records) {
    if (!r._domain) continue;
    if (!domainIndex.has(r._domain)) domainIndex.set(r._domain, []);
    domainIndex.get(r._domain).push(r);
  }
  for (const [, group] of domainIndex) {
    if (group.length < 2) continue;
    for (let i = 1; i < group.length; i++) {
      const a = group[0], b = group[i];
      if (a._email === b._email) continue; // handled by Layer 1
      // Only union if sources differ — same domain, different source indicates
      // the same entity discovered independently. Same-source, different-email
      // records are different people at the same company (not duplicates).
      if (a._source !== b._source) {
        uf.union(a._id, b._id, "domain_match");
        unions++;
      }
    }
  }
  console.log(`  Layer 2 (domain_match): ${unions} unions`);

  // Layer 3: Phone match
  unions = 0;
  const phoneIndex = new Map();
  for (const r of records) {
    if (!r._phone) continue;
    if (phoneIndex.has(r._phone)) {
      uf.union(phoneIndex.get(r._phone), r._id, "phone_match");
      unions++;
    } else {
      phoneIndex.set(r._phone, r._id);
    }
  }
  console.log(`  Layer 3 (phone_match): ${unions} unions`);

  // Layer 4: Fuzzy company name within geo block
  unions = 0;
  const geoIndex = new Map(); // state|city -> records
  for (const r of records) {
    if (!r._companyNorm) continue;
    const block = r._state || r._city;
    if (!block) continue; // skip records with no geo
    if (!geoIndex.has(block)) geoIndex.set(block, []);
    geoIndex.get(block).push(r);
  }
  for (const [, group] of geoIndex) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (a._companyNorm === b._companyNorm) continue; // exact match handled by Layer 5
        const lenDiff = Math.abs(a._companyNorm.length - b._companyNorm.length);
        if (lenDiff > 3) continue; // short-circuit
        const dist = levenshtein(a._companyNorm, b._companyNorm);
        if (dist <= 3) {
          uf.union(a._id, b._id, "fuzzy_name+geo");
          unions++;
        } else if (tokenOverlap(a._companyNorm, b._companyNorm) > 0.7) {
          uf.union(a._id, b._id, "fuzzy_name+geo");
          unions++;
        }
      }
    }
  }
  console.log(`  Layer 4 (fuzzy_name+geo): ${unions} unions`);

  // Layer 5: Cross-domain name detection
  unions = 0;
  const nameIndex = new Map(); // normalizedName -> records
  for (const r of records) {
    if (!r._companyNorm || !r._domain) continue;
    if (!nameIndex.has(r._companyNorm)) nameIndex.set(r._companyNorm, []);
    nameIndex.get(r._companyNorm).push(r);
  }
  for (const [, group] of nameIndex) {
    if (group.length < 2) continue;
    // Only union records with DIFFERENT domains
    const first = group[0];
    for (let i = 1; i < group.length; i++) {
      if (group[i]._domain !== first._domain) {
        uf.union(first._id, group[i]._id, "cross_domain_name");
        unions++;
      }
    }
  }
  console.log(`  Layer 5 (cross_domain_name): ${unions} unions`);

  return uf;
}

// ---------------------------------------------------------------------------
// Confidence Scoring
// ---------------------------------------------------------------------------

function scoreCluster(reasons) {
  const has = (r) => reasons.includes(r);
  if (has("exact_email")) return 100;
  if (has("domain_match") && reasons.length > 1) return 95;
  if (has("domain_match")) return 90;
  if (has("phone_match") && has("fuzzy_name+geo")) return 85;
  if (has("phone_match")) return 80;
  if (has("cross_domain_name")) return 80;
  if (has("fuzzy_name+geo")) return 70;
  return 50; // fallback (shouldn't happen)
}

// ---------------------------------------------------------------------------
// Exports (for testing) — CLI entry point added in Task 5
// ---------------------------------------------------------------------------

module.exports = { loadAndNormalize, runLayers, scoreCluster };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run scripts/dedup_audit.test.js`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/dedup_audit.js scripts/dedup_audit.test.js test-fixtures/dedup_test_input.csv
git commit -m "feat: add dedup audit core — data loading, 5 matching layers, confidence scoring"
```

---

### Task 4: Record selection (richest record) and output generation

**Files:**
- Modify: `scripts/dedup_audit.js`
- Modify: `scripts/dedup_audit.test.js`

- [ ] **Step 1: Write failing tests for selectKeepRecord and output functions**

Append to `scripts/dedup_audit.test.js`:

```js
const { selectKeepRecord, buildClusterOutput } = require("./dedup_audit");

describe("selectKeepRecord", () => {
  it("prefers record with higher score", () => {
    const records = [
      { _id: 0, _email: "a@x.com", _phone: "123", _firstName: "A", _lastName: "B", _companyNorm: "x", _city: "Y", _state: "TX", _pipelineStage: "classified", _score: 42 },
      { _id: 1, _email: "b@x.com", _phone: "456", _firstName: "C", _lastName: "D", _companyNorm: "x", _city: "Y", _state: "TX", _pipelineStage: "classified", _score: 87 },
    ];
    expect(selectKeepRecord(records)).toBe(1);
  });

  it("falls back to richness when scores are equal", () => {
    const records = [
      { _id: 0, _email: "a@x.com", _phone: "", _firstName: "", _lastName: "", _companyNorm: "", _city: "", _state: "", _pipelineStage: "raw", _score: 0 },
      { _id: 1, _email: "b@x.com", _phone: "555", _firstName: "J", _lastName: "D", _companyNorm: "venue", _city: "Austin", _state: "TX", _pipelineStage: "enriched", _score: 0 },
    ];
    expect(selectKeepRecord(records)).toBe(1);
  });

  it("breaks tie with source preference", () => {
    const records = [
      { _id: 0, _email: "a@x.com", _phone: "555", _firstName: "J", _lastName: "D", _companyNorm: "v", _city: "A", _state: "TX", _pipelineStage: "classified", _score: 0, _source: "geolead" },
      { _id: 1, _email: "b@x.com", _phone: "555", _firstName: "J", _lastName: "D", _companyNorm: "v", _city: "A", _state: "TX", _pipelineStage: "classified", _score: 0, _source: "smartlead" },
    ];
    expect(selectKeepRecord(records)).toBe(1);
  });
});

describe("buildClusterOutput", () => {
  it("produces clusters with confidence and records", () => {
    const records = [
      { _id: 0, _email: "a@x.com", _domain: "x.com", _phone: "", _companyNorm: "test", _source: "sl", _score: 50 },
      { _id: 1, _email: "a@x.com", _domain: "y.com", _phone: "", _companyNorm: "other", _source: "amf", _score: 30 },
    ];
    const { UnionFind } = require("../shared/dedup-helpers");
    const uf = new UnionFind(2);
    uf.union(0, 1, "exact_email");
    const output = buildClusterOutput(uf, records);
    expect(output.clusters).toHaveLength(1);
    expect(output.clusters[0].confidence).toBe(100);
    expect(output.clusters[0].records).toHaveLength(2);
    expect(output.summary.totalClusters).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run scripts/dedup_audit.test.js`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement selectKeepRecord and buildClusterOutput**

Add to `scripts/dedup_audit.js` before `module.exports`:

```js
// ---------------------------------------------------------------------------
// Record Selection — pick the richest record in a cluster
// ---------------------------------------------------------------------------

function selectKeepRecord(clusterRecords) {
  let bestIdx = 0;
  let bestScore = -1;
  let bestRichness = -1;
  let bestStageRank = -1;
  let bestSourceRank = -1;

  for (let i = 0; i < clusterRecords.length; i++) {
    const r = clusterRecords[i];
    const score = r._score || 0;

    // Richness points
    let richness = 0;
    if (r._email) richness += 3;
    if (r._phone) richness += 2;
    if (r._firstName && r._lastName) richness += 2;
    if (r._companyNorm) richness += 1;
    if (r._city || r._state) richness += 1;
    const stageRank = STAGE_RANK[r._pipelineStage] || 0;
    richness += stageRank > 0 ? 1 : 0;

    const sourceRank = SOURCE_RANK[r._source] || 0;

    if (
      score > bestScore ||
      (score === bestScore && richness > bestRichness) ||
      (score === bestScore && richness === bestRichness && stageRank > bestStageRank) ||
      (score === bestScore && richness === bestRichness && stageRank === bestStageRank && sourceRank > bestSourceRank)
    ) {
      bestIdx = i;
      bestScore = score;
      bestRichness = richness;
      bestStageRank = stageRank;
      bestSourceRank = sourceRank;
    }
  }

  return clusterRecords[bestIdx]._id;
}

// ---------------------------------------------------------------------------
// Build cluster output structures
// ---------------------------------------------------------------------------

function buildClusterOutput(uf, records) {
  const components = uf.components();
  const clusters = [];
  const byConfidence = {};
  const byReason = {};
  let estimatedDuplicateRecords = 0;

  for (let i = 0; i < components.length; i++) {
    const comp = components[i];
    const confidence = scoreCluster(comp.reasons);
    const clusterRecords = comp.ids.map(id => records[id]);
    const keepId = selectKeepRecord(clusterRecords);

    clusters.push({
      clusterId: i + 1,
      confidence,
      reasons: comp.reasons,
      keepId,
      records: clusterRecords.map(r => ({
        _id: r._id,
        email: r._email,
        companyName: r._companyNorm,
        domain: r._domain,
        phone: r._phone,
        source: r._source,
        score: r._score,
      })),
    });

    byConfidence[confidence] = (byConfidence[confidence] || 0) + 1;
    for (const reason of comp.reasons) {
      byReason[reason] = (byReason[reason] || 0) + 1;
    }
    estimatedDuplicateRecords += comp.ids.length - 1; // all except the keep
  }

  return {
    clusters,
    summary: {
      totalClusters: clusters.length,
      byConfidence,
      byReason,
      estimatedDuplicateRecords,
    },
  };
}
```

Update `module.exports`:

```js
module.exports = {
  loadAndNormalize, runLayers, scoreCluster,
  selectKeepRecord, buildClusterOutput,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run scripts/dedup_audit.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dedup_audit.js scripts/dedup_audit.test.js
git commit -m "feat: add record selection and cluster output building for dedup audit"
```

---

### Task 5: CLI entry point, report writing, and merge logic

**Files:**
- Modify: `scripts/dedup_audit.js`
- Modify: `scripts/dedup_audit.test.js`

- [ ] **Step 1: Write failing test for merge behavior**

Append to `scripts/dedup_audit.test.js`:

```js
const { performMerge } = require("./dedup_audit");

describe("performMerge", () => {
  it("keeps richest record and collects additional emails", () => {
    const records = [
      {
        _id: 0, _email: "keep@x.com", _domain: "x.com", _phone: "555",
        _firstName: "J", _lastName: "D", _companyNorm: "venue", _city: "A",
        _state: "TX", _source: "smartlead", _pipelineStage: "enriched", _score: 85,
        email: "keep@x.com", additional_emails: "",
      },
      {
        _id: 1, _email: "discard@x.com", _domain: "x.com", _phone: "",
        _firstName: "", _lastName: "", _companyNorm: "venue", _city: "",
        _state: "", _source: "geolead", _pipelineStage: "raw", _score: 0,
        email: "discard@x.com", additional_emails: "",
      },
    ];
    const clusters = [{
      clusterId: 1, confidence: 90, reasons: ["domain_match"],
      keepId: 0,
      records: records.map(r => ({ _id: r._id, email: r._email })),
    }];
    const { merged, discarded } = performMerge(records, clusters);
    expect(merged).toHaveLength(1);
    expect(merged[0]._email).toBe("keep@x.com");
    expect(merged[0].additional_emails).toContain("discard@x.com");
    expect(discarded).toHaveLength(1);
  });

  it("does not merge clusters below confidence 80", () => {
    const records = [
      { _id: 0, _email: "a@x.com", email: "a@x.com", additional_emails: "" },
      { _id: 1, _email: "b@y.com", email: "b@y.com", additional_emails: "" },
    ];
    const clusters = [{
      clusterId: 1, confidence: 70, reasons: ["fuzzy_name+geo"],
      keepId: 0,
      records: records.map(r => ({ _id: r._id, email: r._email })),
    }];
    const { merged, discarded } = performMerge(records, clusters);
    expect(merged).toHaveLength(2); // both kept
    expect(discarded).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run scripts/dedup_audit.test.js`
Expected: FAIL — performMerge not exported

- [ ] **Step 3: Implement performMerge and CLI main()**

Add to `scripts/dedup_audit.js`:

```js
// ---------------------------------------------------------------------------
// Merge Logic
// ---------------------------------------------------------------------------

const MERGE_THRESHOLD = 80;

function performMerge(records, clusters) {
  const discardSet = new Set();
  const additionalEmails = new Map(); // keepId -> Set<string>
  const mergedFrom = new Map(); // keepId -> string[]

  for (const cluster of clusters) {
    if (cluster.confidence < MERGE_THRESHOLD) continue;

    const keepId = cluster.keepId;
    if (!additionalEmails.has(keepId)) additionalEmails.set(keepId, new Set());
    if (!mergedFrom.has(keepId)) mergedFrom.set(keepId, []);

    for (const rec of cluster.records) {
      if (rec._id === keepId) continue;
      discardSet.add(rec._id);
      if (rec.email) additionalEmails.get(keepId).add(rec.email);
      mergedFrom.get(keepId).push(`${rec.email}(${records[rec._id]?._source || "unknown"})`);
    }
  }

  const merged = [];
  const discarded = [];

  for (const r of records) {
    if (discardSet.has(r._id)) {
      discarded.push(r);
      continue;
    }
    // Append additional emails
    if (additionalEmails.has(r._id)) {
      const existing = (r.additional_emails || "").split(";").map(e => e.trim()).filter(Boolean);
      const allEmails = new Set(existing);
      for (const e of additionalEmails.get(r._id)) {
        if (e !== r._email) allEmails.add(e);
      }
      r.additional_emails = [...allEmails].join(";");
    }
    if (mergedFrom.has(r._id)) {
      r.merged_from = mergedFrom.get(r._id).join(";");
    }
    merged.push(r);
  }

  return { merged, discarded };
}

// ---------------------------------------------------------------------------
// Report Writing
// ---------------------------------------------------------------------------

function writeReports(clusterOutput, records, inputPath) {
  const reportsDir = projectPath("data", "reports");
  ensureDir(reportsDir);

  // duplicate_clusters.json
  const jsonPath = path.join(reportsDir, "duplicate_clusters.json");
  const jsonData = {
    generated: new Date().toISOString(),
    input: inputPath,
    totalRecords: records.length,
    ...clusterOutput,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
  console.log(`  Written: ${jsonPath}`);

  // dedup_recommendations.csv
  const csvPath = path.join(reportsDir, "dedup_recommendations.csv");
  const csvRows = [];
  for (const cluster of clusterOutput.clusters) {
    for (const rec of cluster.records) {
      csvRows.push({
        cluster_id: cluster.clusterId,
        confidence: cluster.confidence,
        action: rec._id === cluster.keepId ? "keep" : "discard",
        email: rec.email,
        company_name: rec.companyName,
        domain: rec.domain,
        phone: rec.phone,
        source: rec.source,
        reason: cluster.reasons.join(";"),
      });
    }
  }
  writeCsv(csvPath, csvRows);
  console.log(`  Written: ${csvPath}`);

  // smartlead_cleanup.csv
  const cleanupPath = path.join(reportsDir, "smartlead_cleanup.csv");
  const cleanupRows = [];
  for (const cluster of clusterOutput.clusters) {
    for (const rec of cluster.records) {
      if (rec._id === cluster.keepId) continue;
      const full = records[rec._id];
      const stage = full?._pipelineStage || "";
      const inSmartlead = full?.in_smartlead === "true" || full?.in_smartlead === true;
      if (inSmartlead || stage === "uploaded" || stage === "in_campaign") {
        cleanupRows.push({
          email: rec.email,
          company_name: rec.companyName,
          domain: rec.domain,
          campaign_id: full?.campaign_id || "",
          cluster_id: cluster.clusterId,
          reason: cluster.reasons.join(";"),
        });
      }
    }
  }
  writeCsv(cleanupPath, cleanupRows);
  console.log(`  Written: ${cleanupPath} (${cleanupRows.length} records)`);
}

// ---------------------------------------------------------------------------
// CLI Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { input: null, merge: false, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--input" && argv[i + 1]) { args.input = argv[++i]; }
    else if (argv[i] === "--merge") { args.merge = true; }
    else if (argv[i] === "--dry-run") { args.dryRun = true; }
  }
  if (!args.input) args.input = projectPath("data", "master", "leads_master.csv");
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`\nDedup Audit`);
  console.log(`  Input: ${args.input}`);
  console.log(`  Merge: ${args.merge}${args.dryRun ? " (dry run)" : ""}\n`);

  // Load
  console.log("Loading records...");
  const records = loadAndNormalize(args.input);
  console.log(`  Loaded ${records.length} records\n`);

  // Run layers
  console.log("Running matching layers...");
  const uf = runLayers(records);

  // Build output
  console.log("\nBuilding cluster output...");
  const clusterOutput = buildClusterOutput(uf, records);
  console.log(`  ${clusterOutput.summary.totalClusters} clusters found`);
  console.log(`  ${clusterOutput.summary.estimatedDuplicateRecords} estimated duplicate records`);
  console.log(`  By confidence:`, clusterOutput.summary.byConfidence);
  console.log(`  By reason:`, clusterOutput.summary.byReason);

  // Write reports
  console.log("\nWriting reports...");
  writeReports(clusterOutput, records, args.input);

  // Merge
  if (args.merge) {
    console.log("\nMerging high-confidence clusters (threshold >= 80)...");
    const { merged, discarded } = performMerge(records, clusterOutput.clusters);
    console.log(`  ${clusterOutput.clusters.filter(c => c.confidence >= MERGE_THRESHOLD).length} clusters merged`);
    console.log(`  ${discarded.length} records removed`);
    console.log(`  ${merged.filter(r => r.additional_emails).length} records gained additional emails`);

    if (!args.dryRun) {
      // Backup original
      const bakPath = `${args.input}.bak.${timestamp()}`;
      fs.copyFileSync(args.input, bakPath);
      console.log(`  Backup: ${bakPath}`);

      // Write merged CSV — strip internal fields
      const cleanRecords = merged.map(r => {
        const out = { ...r };
        for (const key of Object.keys(out)) {
          if (key.startsWith("_")) delete out[key];
        }
        return out;
      });
      writeCsv(args.input, cleanRecords);
      console.log(`  Written: ${args.input} (${cleanRecords.length} records)`);
    } else {
      console.log("  (dry run — no files modified)");
    }
  }

  console.log("\nDone.");
}

// Run if executed directly
if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
```

Update `module.exports`:

```js
module.exports = {
  loadAndNormalize, runLayers, scoreCluster,
  selectKeepRecord, buildClusterOutput, performMerge,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run scripts/dedup_audit.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dedup_audit.js scripts/dedup_audit.test.js
git commit -m "feat: add merge logic, report writing, and CLI entry point for dedup audit"
```

---

### Task 6: End-to-end test with fixture data

**Files:**
- Modify: `scripts/dedup_audit.test.js`
- Modify: `test-fixtures/dedup_test_input.csv`

- [ ] **Step 1: Write end-to-end integration test**

Append to `scripts/dedup_audit.test.js`:

```js
const fs = require("fs");
const { loadAndNormalize, runLayers, buildClusterOutput, performMerge } = require("./dedup_audit");

describe("end-to-end with fixture CSV", () => {
  const fixturePath = path.join(__dirname, "..", "test-fixtures", "dedup_test_input.csv");

  it("detects expected clusters from fixture data", () => {
    const records = loadAndNormalize(fixturePath);
    expect(records).toHaveLength(5);

    const uf = runLayers(records);
    const output = buildClusterOutput(uf, records);

    // Should have clusters (exact email match on john@grandballroom.com,
    // phone match on 512-555-1234, cross-domain on "grand ballroom")
    expect(output.summary.totalClusters).toBeGreaterThanOrEqual(1);
    expect(output.summary.estimatedDuplicateRecords).toBeGreaterThanOrEqual(1);

    // solo@unique.com should NOT be in any cluster
    const allClusteredIds = output.clusters.flatMap(c => c.records.map(r => r._id));
    expect(allClusteredIds).not.toContain(4); // solo@unique.com is _id:4
  });

  it("merge preserves solo record and consolidates duplicates", () => {
    const records = loadAndNormalize(fixturePath);
    const uf = runLayers(records);
    const output = buildClusterOutput(uf, records);
    const { merged, discarded } = performMerge(records, output.clusters);

    // Solo record must survive
    expect(merged.some(r => r._email === "solo@unique.com")).toBe(true);

    // Total merged + discarded = original count
    expect(merged.length + discarded.length).toBe(records.length);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run scripts/dedup_audit.test.js`
Expected: All tests PASS

- [ ] **Step 3: Run all tests to ensure nothing is broken**

Run: `npx vitest run`
Expected: All tests PASS across all test files

- [ ] **Step 4: Commit**

```bash
git add scripts/dedup_audit.test.js
git commit -m "test: add end-to-end integration test for dedup audit"
```

---

### Task 7: Manual smoke test with real data

**Files:** None (read-only verification)

- [ ] **Step 1: Run audit against real master CSV (no merge)**

Run: `node scripts/dedup_audit.js`

Expected output: Layer-by-layer union counts, cluster summary, three report files written to `data/reports/`.

- [ ] **Step 2: Inspect duplicate_clusters.json**

Run: `node -e "const d = require('./data/reports/duplicate_clusters.json'); console.log('Clusters:', d.summary.totalClusters); console.log('Dupes:', d.summary.estimatedDuplicateRecords); console.log('By confidence:', d.summary.byConfidence); console.log('By reason:', d.summary.byReason);"`

Verify: Numbers look reasonable. No single cluster should contain thousands of records (that would indicate a Layer 2 bug).

- [ ] **Step 3: Spot-check a few clusters in dedup_recommendations.csv**

Open `data/reports/dedup_recommendations.csv` and verify:
- `keep` records have richer data than `discard` records in the same cluster
- Reasons make sense (e.g., domain_match clusters share a domain, phone_match clusters share a phone)

- [ ] **Step 4: Dry-run merge**

Run: `node scripts/dedup_audit.js --merge --dry-run`

Verify: Reports written but no CSV modified. Check that the merge summary numbers are reasonable.

- [ ] **Step 5: Commit if any fixes were needed**

```bash
# Only if bugs were found and fixed during smoke testing
git add -A
git commit -m "fix: address issues found during dedup audit smoke testing"
```
