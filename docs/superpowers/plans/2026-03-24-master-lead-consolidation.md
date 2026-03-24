# Master Lead Consolidation & GHL Export — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `scripts/build-master.js` that consolidates all pipeline CSV sources into a single master lead file and exports GHL-compatible CSVs.

**Architecture:** Single Node.js script with three phases (ingest/merge, enrich/derive, export). Uses a `Map<domain, Map<email, record>>` for dedup. Extends `shared/fields.js` with `parseLocationFull()` and suffix stripping in `parseName()`. No new npm dependencies.

**Tech Stack:** Node.js, csv-parse, csv-stringify, existing shared modules (csv.js, fields.js, dedup.js, utils.js)

**Spec:** `docs/superpowers/specs/2026-03-24-master-lead-consolidation-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `vitest.config.js` (create) | Vitest config for CommonJS project |
| `shared/fields.js` (modify) | Add `parseLocationFull()`, add suffix stripping to `parseName()`, export new function |
| `shared/fields.test.js` (create) | Tests for `parseLocationFull()` and `parseName()` suffix stripping |
| `scripts/build-master.js` (create) | Main consolidation script — ingests, merges, derives, exports |
| `scripts/build-master.test.js` (create) | Tests for merge logic, pipeline stage, GHL export formatting |

---

## Task 0: Add test runner

No test framework exists. Install one and add a test script.

**Files:**
- Modify: `package.json`
- Create: `vitest.config.js`

- [ ] **Step 1: Install vitest as dev dependency**

```bash
npm install --save-dev vitest
```

- [ ] **Step 2: Add test script to package.json**

Add to the `"scripts"` section of `package.json`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Create vitest.config.js for CommonJS compatibility**

Create `vitest.config.js` in the project root:

```js
const { defineConfig } = require("vitest/config");

module.exports = defineConfig({
  test: {
    globals: false,
  },
});
```

- [ ] **Step 4: Verify vitest runs (no tests yet, should exit cleanly)**

Run: `npx vitest run`
Expected: "No test files found" or exit 0

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.js
git commit -m "chore: add vitest test runner"
```

---

## Task 1: Extend `parseName()` with suffix stripping

**Files:**
- Modify: `shared/fields.js:69-103`
- Create: `shared/fields.test.js`

- [ ] **Step 1: Write failing tests for suffix stripping**

Create `shared/fields.test.js`:

```js
const { describe, it, expect } = require("vitest");
const { parseName } = require("./fields");

describe("parseName", () => {
  it("splits simple two-part name", () => {
    expect(parseName("John Smith")).toEqual({ first: "John", last: "Smith" });
  });

  it("strips prefix", () => {
    expect(parseName("Dr. Jane Doe")).toEqual({ first: "Jane", last: "Doe" });
  });

  it("handles multi-part first name", () => {
    expect(parseName("Mary Jane Watson")).toEqual({ first: "Mary", last: "Jane Watson" });
  });

  it("single token goes to first name", () => {
    expect(parseName("Smith")).toEqual({ first: "Smith", last: "" });
  });

  it("empty string returns empty", () => {
    expect(parseName("")).toEqual({ first: "", last: "" });
  });

  it("strips Jr. suffix", () => {
    expect(parseName("John Smith Jr.")).toEqual({ first: "John", last: "Smith" });
  });

  it("strips Sr. suffix", () => {
    expect(parseName("Robert Jones Sr.")).toEqual({ first: "Robert", last: "Jones" });
  });

  it("strips III suffix", () => {
    expect(parseName("William Davis III")).toEqual({ first: "William", last: "Davis" });
  });

  it("strips PhD suffix", () => {
    expect(parseName("Jane Doe PhD")).toEqual({ first: "Jane", last: "Doe" });
  });

  it("strips prefix AND suffix", () => {
    expect(parseName("Dr. John Smith Jr.")).toEqual({ first: "John", last: "Smith" });
  });

  it("returns empty for company names", () => {
    expect(parseName("Grand Resort LLC")).toEqual({ first: "", last: "" });
  });

  it("handles null", () => {
    expect(parseName(null)).toEqual({ first: "", last: "" });
  });
});
```

- [ ] **Step 2: Run tests to verify suffix tests fail**

Run: `npx vitest run shared/fields.test.js`
Expected: Tests for "Jr.", "Sr.", "III", "PhD", prefix+suffix FAIL (suffix not stripped yet). Other tests PASS.

- [ ] **Step 3: Add suffix stripping to `parseName()` in `shared/fields.js`**

Add a `SUFFIXES` set after the `PREFIXES` set (after line 72):

```js
const SUFFIXES = new Set([
  "jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v",
  "phd", "phd.", "md", "md.", "esq", "esq.", "dds", "dds.",
  "cpa", "cpa.",
]);
```

In the `parseName()` function, after the prefix stripping block (after line 93) and before the `parts.length` checks, add:

```js
  // Strip suffix
  if (parts.length > 1 && SUFFIXES.has(parts[parts.length - 1].toLowerCase())) {
    parts.pop();
  }
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npx vitest run shared/fields.test.js`
Expected: All 13 tests PASS

- [ ] **Step 5: Commit**

```bash
git add shared/fields.js shared/fields.test.js
git commit -m "feat: add suffix stripping to parseName (Jr, Sr, III, PhD, etc.)"
```

---

## Task 2: Add `parseLocationFull()` to `shared/fields.js`

**Files:**
- Modify: `shared/fields.js:175-214` (add new function after `parseLocation`, update exports)
- Modify: `shared/fields.test.js` (add tests)

- [ ] **Step 1: Write failing tests for `parseLocationFull()`**

Append to `shared/fields.test.js`:

```js
const { parseLocationFull } = require("./fields");

describe("parseLocationFull", () => {
  it("parses City, ST", () => {
    expect(parseLocationFull("Austin, TX")).toEqual({ city: "Austin", state: "TX", zip: "" });
  });

  it("parses City, ST ZIP", () => {
    expect(parseLocationFull("Austin, TX 78701")).toEqual({ city: "Austin", state: "TX", zip: "78701" });
  });

  it("parses full state name", () => {
    expect(parseLocationFull("New York, New York")).toEqual({ city: "New York", state: "NY", zip: "" });
  });

  it("parses City ST ZIP without comma", () => {
    expect(parseLocationFull("Miami FL 33101")).toEqual({ city: "Miami", state: "FL", zip: "33101" });
  });

  it("handles ZIP+4 (keeps only 5 digits)", () => {
    expect(parseLocationFull("Dallas, TX 75201-1234")).toEqual({ city: "Dallas", state: "TX", zip: "75201" });
  });

  it("strips trailing USA", () => {
    expect(parseLocationFull("Seattle, WA 98101, USA")).toEqual({ city: "Seattle", state: "WA", zip: "98101" });
  });

  it("strips trailing United States", () => {
    expect(parseLocationFull("Portland, OR, United States")).toEqual({ city: "Portland", state: "OR", zip: "" });
  });

  it("handles extra whitespace", () => {
    expect(parseLocationFull("  Denver ,  CO  80202  ")).toEqual({ city: "Denver", state: "CO", zip: "80202" });
  });

  it("returns empty for null", () => {
    expect(parseLocationFull(null)).toEqual({ city: "", state: "", zip: "" });
  });

  it("returns empty for empty string", () => {
    expect(parseLocationFull("")).toEqual({ city: "", state: "", zip: "" });
  });

  it("returns city only when no state match", () => {
    expect(parseLocationFull("Some Place")).toEqual({ city: "Some Place", state: "", zip: "" });
  });

  it("handles state code only", () => {
    expect(parseLocationFull("CA")).toEqual({ city: "", state: "CA", zip: "" });
  });

  it("handles full state name California", () => {
    expect(parseLocationFull("Los Angeles, California")).toEqual({ city: "Los Angeles", state: "CA", zip: "" });
  });

  it("handles District of Columbia", () => {
    expect(parseLocationFull("Washington, District of Columbia")).toEqual({ city: "Washington", state: "DC", zip: "" });
  });
});
```

- [ ] **Step 2: Run tests to verify `parseLocationFull` tests fail**

Run: `npx vitest run shared/fields.test.js`
Expected: `parseLocationFull` tests FAIL (function doesn't exist). `parseName` tests still PASS.

- [ ] **Step 3: Implement `parseLocationFull()` in `shared/fields.js`**

Add the state name lookup object and function after `parseLocation()` (after line 201), before the exports:

```js
// ---------------------------------------------------------------------------
// Full location parser — city, state, zip with full state name support
// ---------------------------------------------------------------------------

const STATE_NAMES = {
  "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
  "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
  "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
  "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
  "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
  "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
  "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
  "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT",
  "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV",
  "wisconsin": "WI", "wyoming": "WY", "district of columbia": "DC",
  "puerto rico": "PR", "guam": "GU", "us virgin islands": "VI",
  "american samoa": "AS", "northern mariana islands": "MP",
};

const STATE_ABBREVS = new Set(Object.values(STATE_NAMES));

/**
 * Parse a location string into { city, state, zip } with full state name support.
 * Extends parseLocation() with zip extraction and state name → abbreviation lookup.
 * @param {string} loc
 * @returns {{ city: string, state: string, zip: string }}
 */
function parseLocationFull(loc) {
  if (!loc || typeof loc !== "string") return { city: "", state: "", zip: "" };

  let trimmed = loc.trim();
  if (!trimmed) return { city: "", state: "", zip: "" };

  // Strip trailing country
  trimmed = trimmed.replace(/,?\s*(USA|US|United States of America|United States)\s*$/i, "").trim();
  // Strip trailing comma
  trimmed = trimmed.replace(/,\s*$/, "").trim();

  // Extract zip code (5-digit, optionally +4)
  let zip = "";
  const zipMatch = trimmed.match(/\b(\d{5})(?:-\d{4})?\s*$/);
  if (zipMatch) {
    zip = zipMatch[1];
    trimmed = trimmed.slice(0, zipMatch.index).trim().replace(/,\s*$/, "").trim();
  }

  // Just a state code
  if (/^[A-Z]{2}$/i.test(trimmed) && STATE_ABBREVS.has(trimmed.toUpperCase())) {
    return { city: "", state: trimmed.toUpperCase(), zip };
  }

  // Try "City, ST" pattern
  const commaMatch = trimmed.match(/^(.+),\s*([^,]+)$/);
  if (commaMatch) {
    const city = commaMatch[1].trim();
    const stateCandidate = commaMatch[2].trim();

    // Two-letter abbreviation
    if (/^[A-Z]{2}$/i.test(stateCandidate) && STATE_ABBREVS.has(stateCandidate.toUpperCase())) {
      return { city, state: stateCandidate.toUpperCase(), zip };
    }

    // Full state name
    const abbrev = STATE_NAMES[stateCandidate.toLowerCase()];
    if (abbrev) {
      return { city, state: abbrev, zip };
    }
  }

  // Try "City ST" without comma (e.g., "Miami FL")
  const spaceMatch = trimmed.match(/^(.+?)\s+([A-Z]{2})$/i);
  if (spaceMatch && STATE_ABBREVS.has(spaceMatch[2].toUpperCase())) {
    return { city: spaceMatch[1].trim(), state: spaceMatch[2].toUpperCase(), zip };
  }

  // No state match — return city only
  return { city: trimmed, state: "", zip };
}
```

Update the exports at the bottom of the file to include `parseLocationFull`:

```js
module.exports = {
  FIELDS,
  resolveField,
  normalizeRow,
  parseName,
  parseLocation,
  parseLocationFull,
  looksLikeCompany,
};
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npx vitest run shared/fields.test.js`
Expected: All 27 tests PASS (13 parseName + 14 parseLocationFull)

- [ ] **Step 5: Commit**

```bash
git add shared/fields.js shared/fields.test.js
git commit -m "feat: add parseLocationFull() with zip extraction and state name lookup"
```

---

## Task 3: Build the ingest & merge phase

The core of `scripts/build-master.js` — reads all source CSVs and merges into `Map<domain, Map<email, record>>`.

**Files:**
- Create: `scripts/build-master.js`
- Create: `scripts/build-master.test.js`

**Context for implementer:**
- `shared/csv.js:readCsv(filepath)` returns `{ records: object[], columns: string[] }`. Returns `{ records: [], columns: [] }` if file doesn't exist.
- `shared/fields.js:normalizeRow(row)` returns `{ email, firstName, lastName, companyName, phone, website, city, state, location, source }`. It does NOT return pipeline-specific fields like `is_venue`, `confidence`, `reasoning`, `line_type`, `carrier`.
- `shared/fields.js:resolveField(row, fieldType)` looks up a field by type name (email, firstName, website, etc.) across all known column name variants.
- `shared/dedup.js:normalizeDomain(raw)` strips protocol, www, paths, lowercases.
- `shared/utils.js:projectPath(...parts)` resolves paths relative to project root.

- [ ] **Step 1: Write failing test for merge logic**

Create `scripts/build-master.test.js`:

```js
const { describe, it, expect } = require("vitest");

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run scripts/build-master.test.js`
Expected: FAIL (module doesn't exist yet)

- [ ] **Step 3: Implement the merge core in `scripts/build-master.js`**

Create `scripts/build-master.js`:

```js
#!/usr/bin/env node
/**
 * Build a master lead CSV by consolidating all pipeline data sources.
 *
 * Usage:
 *   node scripts/build-master.js [options]
 *
 * Options:
 *   --export ghl      Also generate GHL-compatible CSVs
 *   --min-score N      GHL filter: minimum lead score (default: 0)
 *   --min-stage STAGE  GHL filter: minimum pipeline stage (default: raw)
 *   --dry-run          Report stats without writing files
 */

const fs = require("fs");
const path = require("path");
const { readCsv, writeCsv } = require("../shared/csv");
const { normalizeRow, resolveField, parseLocationFull, parseName } = require("../shared/fields");
const { normalizeDomain } = require("../shared/dedup");
const { projectPath, ensureDir, timestamp } = require("../shared/utils");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MASTER_COLUMNS = [
  "domain", "email", "first_name", "last_name", "company_name",
  "phone", "phone_type", "phone_carrier", "website", "location_raw",
  "city", "state", "zip", "is_venue", "confidence",
  "classification_reasoning", "score", "source", "source_detail",
  "email_source", "pipeline_stage", "last_updated",
];

/** Company-level fields that get inherited when a new email is added to an existing domain. */
const COMPANY_FIELDS = [
  "company_name", "phone", "phone_type", "phone_carrier", "website",
  "location_raw", "city", "state", "zip", "is_venue", "confidence",
  "classification_reasoning", "source", "source_detail",
];

const STAGE_RANK = {
  raw: 0, filtered: 1, classified: 2, validated: 3,
  enriched: 4, uploaded: 5, in_campaign: 6,
};

// ---------------------------------------------------------------------------
// Merge map — Map<domain, Map<email, record>>
// ---------------------------------------------------------------------------

function createMergeMap() {
  return new Map();
}

/**
 * Merge a record into the map. Fills empty fields but never overwrites populated ones.
 * If the domain already exists but this email is new, inherits company-level fields.
 * Pass forceFields array to overwrite specific fields even if already set (used by
 * verified/escalated ingestor to upgrade classifications).
 */
function mergeIntoMap(map, record, forceFields = []) {
  const domain = record.domain;
  const email = record.email;
  if (!domain && !email) return;

  const key = domain || email;
  if (!map.has(key)) map.set(key, new Map());
  const domainMap = map.get(key);

  if (!domainMap.has(email)) {
    // New email for this domain — inherit company-level fields from first existing record
    const inherited = {};
    if (domainMap.size > 0) {
      const firstRecord = domainMap.values().next().value;
      for (const field of COMPANY_FIELDS) {
        if (firstRecord[field]) inherited[field] = firstRecord[field];
      }
    }
    domainMap.set(email, { ...inherited, ...stripEmpty(record) });
  } else {
    // Existing domain+email — fill blanks, and force-overwrite specified fields
    const existing = domainMap.get(email);
    for (const [k, v] of Object.entries(record)) {
      if (v && (!existing[k] || forceFields.includes(k))) existing[k] = v;
    }
  }
}

/** Remove empty-string and undefined values from an object. */
function stripEmpty(obj) {
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== "") result[k] = v;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Source ingestors — each reads one data source and feeds into the merge map
// ---------------------------------------------------------------------------

function safeReadCsv(filepath) {
  try {
    return readCsv(filepath);
  } catch {
    return { records: [], columns: [] };
  }
}

/** Ingest SmartLead raw exports: data/raw/campaign_*.csv */
function ingestSmartLead(map) {
  const dir = projectPath("data", "raw");
  if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir).filter(f => f.startsWith("campaign_") && f.endsWith(".csv"));
  let count = 0;

  for (const file of files) {
    const { records } = safeReadCsv(path.join(dir, file));
    // Extract campaign ID from filename: campaign_<id>_<timestamp>.csv
    const campaignId = file.match(/campaign_(\d+)/)?.[1] || "";

    for (const row of records) {
      const n = normalizeRow(row);
      const domain = normalizeDomain(n.website) || normalizeDomain(n.email.split("@")[1] || "");
      if (!domain && !n.email) continue;

      const hasEngagement = Number(row.open_count || 0) > 0 || Number(row.reply_count || 0) > 0 || Number(row.click_count || 0) > 0;

      mergeIntoMap(map, {
        domain,
        email: n.email,
        first_name: n.firstName,
        last_name: n.lastName,
        company_name: n.companyName,
        phone: n.phone,
        website: n.website,
        location_raw: n.location,
        source: "smartlead_original",
        source_detail: `campaign_${campaignId}`,
        email_source: "primary",
        _has_engagement: hasEngagement ? "yes" : "",
        _in_smartlead: "yes",
      });
      count++;
    }
  }
  return count;
}

/** Ingest GeoLead enriched data: data/enriched/geolead_net_new.csv */
function ingestGeoLead(map) {
  const { records } = safeReadCsv(projectPath("data", "enriched", "geolead_net_new.csv"));
  let count = 0;

  for (const row of records) {
    const n = normalizeRow(row);
    const domain = normalizeDomain(n.website) || normalizeDomain(row.company_domain || "");
    if (!domain && !n.email) continue;

    mergeIntoMap(map, {
      domain,
      email: n.email,
      first_name: n.firstName,
      last_name: n.lastName,
      company_name: n.companyName,
      phone: n.phone,
      website: n.website || row.company_website || "",
      location_raw: n.location,
      source: "geolead",
      source_detail: row._source_query || row._source_file || "",
      email_source: "primary",
      _is_filtered: "yes",
    });
    count++;
  }
  return count;
}

/** Ingest classified venues and non-venues from both original and GeoLead batches. */
function ingestClassified(map) {
  const dirs = [
    { dir: "classified", source: "smartlead_original" },
    { dir: "classified_geolead", source: "geolead" },
  ];
  let count = 0;

  for (const { dir, source } of dirs) {
    for (const file of ["venues.csv", "non_venues.csv", "ambiguous.csv"]) {
      const filepath = projectPath("data", dir, file);
      const { records } = safeReadCsv(filepath);

      for (const row of records) {
        const n = normalizeRow(row);
        const domain = normalizeDomain(n.website);
        if (!domain && !n.email) continue;

        mergeIntoMap(map, {
          domain,
          email: n.email,
          first_name: n.firstName,
          last_name: n.lastName,
          company_name: n.companyName,
          phone: n.phone,
          website: n.website,
          location_raw: n.location,
          is_venue: row.is_venue || "",
          confidence: row.confidence || "",
          classification_reasoning: row.reasoning || "",
          source: source,
          email_source: "primary",
        });
        count++;
      }
    }
  }
  return count;
}

/** Ingest phone-validated segments: data/phone_validated/*.csv and data/phone_validated_geolead/*.csv */
function ingestPhoneValidated(map) {
  const dirs = ["phone_validated", "phone_validated_geolead"];
  let count = 0;

  for (const dir of dirs) {
    const fullDir = projectPath("data", dir);
    if (!fs.existsSync(fullDir)) continue;
    const files = fs.readdirSync(fullDir).filter(f => f.endsWith(".csv"));

    for (const file of files) {
      const { records } = safeReadCsv(path.join(fullDir, file));
      // Derive phone_type from filename: mobile.csv → mobile, landline.csv → landline, etc.
      const phoneType = file.replace(".csv", "");
      const isPhoneFile = ["mobile", "landline", "voip", "invalid"].includes(phoneType);

      for (const row of records) {
        const n = normalizeRow(row);
        const domain = normalizeDomain(n.website);
        if (!domain && !n.email) continue;

        mergeIntoMap(map, {
          domain,
          email: n.email,
          first_name: n.firstName,
          last_name: n.lastName,
          company_name: n.companyName,
          phone: n.phone,
          website: n.website,
          location_raw: n.location,
          phone_type: isPhoneFile ? phoneType : "",
          phone_carrier: row.carrier || "",
          is_venue: row.is_venue || "",
          confidence: row.confidence || "",
          classification_reasoning: row.reasoning || "",
          email_source: "primary",
        });
        count++;
      }
    }
  }
  return count;
}

/** Ingest verified/escalated results: data/verified/*.csv and data/verified_geolead/*.csv
 *  These OVERWRITE classification fields (is_venue, confidence, classification_reasoning)
 *  because escalation upgrades a previous ambiguous classification. */
function ingestVerified(map) {
  const dirs = ["verified", "verified_geolead"];
  const CLASSIFICATION_FIELDS = ["is_venue", "confidence", "classification_reasoning"];
  let count = 0;

  for (const dir of dirs) {
    for (const file of ["venues.csv", "non_venues.csv"]) {
      const filepath = projectPath("data", dir, file);
      const { records } = safeReadCsv(filepath);

      for (const row of records) {
        const n = normalizeRow(row);
        const domain = normalizeDomain(n.website);
        if (!domain && !n.email) continue;

        mergeIntoMap(map, {
          domain,
          email: n.email,
          first_name: n.firstName,
          last_name: n.lastName,
          company_name: n.companyName,
          phone: n.phone,
          website: n.website,
          location_raw: n.location,
          is_venue: row.is_venue || "",
          confidence: row.confidence || "",
          classification_reasoning: row.reasoning || "",
          email_source: "primary",
        }, CLASSIFICATION_FIELDS);
        count++;
      }
    }
  }
  return count;
}

/** Ingest AnyMailFinder additional contacts (original batch). */
function ingestAmfOriginal(map) {
  const { records } = safeReadCsv(projectPath("data", "anymailfinder", "additional_contacts.csv"));
  let count = 0;

  for (const row of records) {
    const domain = normalizeDomain(row.domain || "");
    if (!domain) continue;

    // This file has semicolon-separated emails in valid_emails or emails_found
    const emailsStr = row.valid_emails || row.emails_found || "";
    const emails = emailsStr.split(";").map(e => e.trim().toLowerCase()).filter(Boolean);

    for (const email of emails) {
      mergeIntoMap(map, {
        domain,
        email,
        company_name: row.venue_name || row.company_name || "",
        source: "anymailfinder",
        email_source: "anymailfinder_original",
      });
      count++;
    }
  }
  return count;
}

/** Ingest AnyMailFinder GeoLead bulk results. */
function ingestAmfGeoLead(map) {
  const { records } = safeReadCsv(projectPath("data", "anymailfinder", "geolead_additional_contacts.csv"));
  let count = 0;

  for (const row of records) {
    const domain = normalizeDomain(row.domain || row.company_domain || "");
    const email = (row.email || "").trim().toLowerCase();
    if (!domain || !email) continue;

    mergeIntoMap(map, {
      domain,
      email,
      company_name: row.company_name || "",
      source: "anymailfinder",
      email_source: "anymailfinder_geolead",
    });
    count++;
  }
  return count;
}

/** Ingest master email list for in_smartlead flags: data/upload/master_enriched_emails.csv */
function ingestSmartLeadFlags(map) {
  const { records } = safeReadCsv(projectPath("data", "upload", "master_enriched_emails.csv"));
  let count = 0;

  for (const row of records) {
    if (row.in_smartlead !== "yes") continue;
    const email = (row.email || "").trim().toLowerCase();
    if (!email) continue;
    const domain = normalizeDomain(row.website || "") || normalizeDomain(email.split("@")[1] || "");

    // Only set the flag — don't create new records from this source
    if (map.has(domain)) {
      const domainMap = map.get(domain);
      if (domainMap.has(email)) {
        domainMap.get(email)._in_smartlead = "yes";
        count++;
      }
    }
  }
  return count;
}

/** Ingest scored venues: most recent data/scored/scored_venues_*.csv */
function ingestScores(map) {
  const dir = projectPath("data", "scored");
  if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir).filter(f => f.startsWith("scored_venues_") && f.endsWith(".csv")).sort();
  if (files.length === 0) return 0;

  const latest = files[files.length - 1];
  const { records } = safeReadCsv(path.join(dir, latest));
  let count = 0;

  for (const row of records) {
    const email = (row.email || "").trim().toLowerCase();
    if (!email || !row.score) continue;
    const domain = normalizeDomain(row.website || "") || normalizeDomain(email.split("@")[1] || "");

    if (map.has(domain)) {
      const domainMap = map.get(domain);
      if (domainMap.has(email)) {
        domainMap.get(email).score = row.score;
        count++;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Phase 2: Enrich & Derive
// ---------------------------------------------------------------------------

function computePipelineStage(record) {
  if (record._has_engagement === "yes") return "in_campaign";
  if (record._in_smartlead === "yes") return "uploaded";
  if (record.email_source && record.email_source.startsWith("anymailfinder")) return "enriched";
  if (record.phone_type) return "validated";
  if (record.is_venue) return "classified";
  if (record._is_filtered === "yes") return "filtered";
  return "raw";
}

function enrichRecords(map) {
  const now = new Date().toISOString();
  const flat = [];

  for (const [domain, emailMap] of map) {
    for (const [email, record] of emailMap) {
      // Parse location for city/state/zip if not already set
      if (record.location_raw && (!record.city || !record.state)) {
        const loc = parseLocationFull(record.location_raw);
        if (!record.city && loc.city) record.city = loc.city;
        if (!record.state && loc.state) record.state = loc.state;
        if (!record.zip && loc.zip) record.zip = loc.zip;
      }

      // Compute pipeline stage
      record.pipeline_stage = computePipelineStage(record);
      record.last_updated = now;

      // Ensure all columns exist
      record.domain = domain;
      record.email = email;

      flat.push(record);
    }
  }

  // Sort by domain, then email
  flat.sort((a, b) => (a.domain || "").localeCompare(b.domain || "") || (a.email || "").localeCompare(b.email || ""));
  return flat;
}

// ---------------------------------------------------------------------------
// Phase 3: Export
// ---------------------------------------------------------------------------

function writeMasterCsv(records) {
  const outputPath = projectPath("data", "master", "leads_master.csv");
  const rows = records.map(r => {
    const out = {};
    for (const col of MASTER_COLUMNS) {
      out[col] = r[col] || "";
    }
    return out;
  });
  writeCsv(outputPath, rows, MASTER_COLUMNS);
  return outputPath;
}

// ---------------------------------------------------------------------------
// GHL Exports
// ---------------------------------------------------------------------------

function confidenceTier(confidence) {
  const c = parseFloat(confidence);
  if (isNaN(c)) return "";
  if (c >= 0.85) return "high";
  if (c >= 0.7) return "medium";
  return "low";
}

function buildTags(record) {
  const tags = [];
  if (record.phone_type) tags.push(record.phone_type);
  if (record.source) tags.push(record.source);
  const tier = confidenceTier(record.confidence);
  if (tier) tags.push(`confidence_${tier}`);
  return tags.join(",");
}

function filterRecords(records, minScore, minStage) {
  const minStageRank = STAGE_RANK[minStage] || 0;
  return records.filter(r => {
    const score = parseFloat(r.score) || 0;
    const stageRank = STAGE_RANK[r.pipeline_stage] || 0;
    return score >= minScore && stageRank >= minStageRank;
  });
}

function buildDomainEmailsLookup(records) {
  const lookup = new Map(); // domain → Set<email>
  for (const r of records) {
    if (!r.domain) continue;
    if (!lookup.has(r.domain)) lookup.set(r.domain, new Set());
    if (r.email) lookup.get(r.domain).add(r.email);
  }
  return lookup;
}

function exportGhlContacts(records, domainEmails) {
  const columns = [
    "Phone", "Email", "First Name", "Last Name", "Business Name",
    "Source", "Additional Emails", "Additional Phones", "Notes", "Tags",
  ];
  const rows = records.map(r => {
    const otherEmails = domainEmails.has(r.domain)
      ? [...domainEmails.get(r.domain)].filter(e => e !== r.email).join(";")
      : "";
    return {
      "Phone": r.phone || "",
      "Email": r.email || "",
      "First Name": r.first_name || "",
      "Last Name": r.last_name || "",
      "Business Name": r.company_name || "",
      "Source": r.source || "",
      "Additional Emails": otherEmails,
      "Additional Phones": "",
      "Notes": (r.classification_reasoning || "").slice(0, 500),
      "Tags": buildTags(r),
    };
  });
  const outputPath = projectPath("data", "master", "ghl_contacts.csv");
  writeCsv(outputPath, rows, columns);
  return outputPath;
}

function exportGhlCompanies(records) {
  const columns = [
    "Company Name", "Phone", "Email", "Website", "Address",
    "City", "State", "Postal Code", "Country", "Description",
  ];
  // One row per domain — use the first record for each domain
  const seen = new Set();
  const rows = [];
  for (const r of records) {
    if (!r.domain || seen.has(r.domain)) continue;
    seen.add(r.domain);
    rows.push({
      "Company Name": r.company_name || "",
      "Phone": r.phone || "",
      "Email": r.email || "",
      "Website": r.website || "",
      "Address": r.location_raw || "",
      "City": r.city || "",
      "State": r.state || "",
      "Postal Code": r.zip || "",
      "Country": "US",
      "Description": "",
    });
  }
  const outputPath = projectPath("data", "master", "ghl_companies.csv");
  writeCsv(outputPath, rows, columns);
  return outputPath;
}

function exportGhlOpportunities(records) {
  const columns = [
    "Opportunity Name", "Phone", "Email", "Pipeline ID", "Stage ID",
    "Lead Value", "Source", "Notes", "Tags", "Status",
  ];
  const rows = records.map(r => ({
    "Opportunity Name": r.company_name || "",
    "Phone": r.phone || "",
    "Email": r.email || "",
    "Pipeline ID": "",
    "Stage ID": "",
    "Lead Value": "75",
    "Source": r.source || "",
    "Notes": `score: ${r.score || "N/A"}, stage: ${r.pipeline_stage || "N/A"}, confidence: ${r.confidence || "N/A"}`,
    "Tags": buildTags(r),
    "Status": "open",
  }));
  const outputPath = projectPath("data", "master", "ghl_opportunities.csv");
  writeCsv(outputPath, rows, columns);
  return outputPath;
}

// ---------------------------------------------------------------------------
// CLI & main
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { exportGhl: false, minScore: 0, minStage: "raw", dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--export" && args[i + 1] === "ghl") { opts.exportGhl = true; i++; }
    if (args[i] === "--min-score") { opts.minScore = parseInt(args[++i], 10) || 0; }
    if (args[i] === "--min-stage") { opts.minStage = args[++i] || "raw"; }
    if (args[i] === "--dry-run") { opts.dryRun = true; }
  }
  return opts;
}

function printSummary(records) {
  const domains = new Set(records.map(r => r.domain).filter(Boolean));
  const bySrc = {};
  const byStage = {};
  for (const r of records) {
    bySrc[r.source || "unknown"] = (bySrc[r.source || "unknown"] || 0) + 1;
    byStage[r.pipeline_stage || "raw"] = (byStage[r.pipeline_stage || "raw"] || 0) + 1;
  }

  console.log(`\n=== Master Build Summary ===`);
  console.log(`Total domains:  ${domains.size}`);
  console.log(`Total contacts: ${records.length}`);
  console.log(`\nBy source:`);
  for (const [src, count] of Object.entries(bySrc).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${src}: ${count}`);
  }
  console.log(`\nBy pipeline stage:`);
  for (const [stage, count] of Object.entries(byStage).sort((a, b) => (STAGE_RANK[b[0]] || 0) - (STAGE_RANK[a[0]] || 0))) {
    console.log(`  ${stage}: ${count}`);
  }
}

function main() {
  const opts = parseArgs();
  console.log("=== Building Master Lead CSV ===\n");

  // Phase 1: Ingest & Merge
  const map = createMergeMap();
  const counts = {};
  counts.smartlead = ingestSmartLead(map);
  console.log(`  SmartLead raw:           ${counts.smartlead} rows`);
  counts.geolead = ingestGeoLead(map);
  console.log(`  GeoLead enriched:        ${counts.geolead} rows`);
  counts.classified = ingestClassified(map);
  console.log(`  Classified:              ${counts.classified} rows`);
  counts.phoneValidated = ingestPhoneValidated(map);
  console.log(`  Phone validated:         ${counts.phoneValidated} rows`);
  counts.verified = ingestVerified(map);
  console.log(`  Verified/escalated:      ${counts.verified} rows`);
  counts.amfOriginal = ingestAmfOriginal(map);
  console.log(`  AnyMailFinder original:  ${counts.amfOriginal} rows`);
  counts.amfGeolead = ingestAmfGeoLead(map);
  console.log(`  AnyMailFinder GeoLead:   ${counts.amfGeolead} rows`);
  counts.smartleadFlags = ingestSmartLeadFlags(map);
  console.log(`  SmartLead flags applied: ${counts.smartleadFlags}`);
  counts.scores = ingestScores(map);
  console.log(`  Scores applied:          ${counts.scores}`);

  // Phase 2: Enrich & Derive
  const records = enrichRecords(map);
  printSummary(records);

  if (opts.dryRun) {
    console.log("\n[DRY RUN] No files written.");
    return;
  }

  // Phase 3: Export
  const masterPath = writeMasterCsv(records);
  console.log(`\nMaster CSV: ${masterPath}`);

  if (opts.exportGhl) {
    const filtered = filterRecords(records, opts.minScore, opts.minStage);
    console.log(`\nGHL export: ${filtered.length} records (min-score=${opts.minScore}, min-stage=${opts.minStage})`);
    const domainEmails = buildDomainEmailsLookup(filtered);
    const contactsPath = exportGhlContacts(filtered, domainEmails);
    const companiesPath = exportGhlCompanies(filtered);
    const oppsPath = exportGhlOpportunities(filtered);
    console.log(`  Contacts:      ${contactsPath}`);
    console.log(`  Companies:     ${companiesPath}`);
    console.log(`  Opportunities: ${oppsPath}`);
  }

  console.log("\nDone.");
}

// Export internals for testing
module.exports = {
  createMergeMap,
  mergeIntoMap,
  enrichRecords,
  computePipelineStage,
  filterRecords,
  buildTags,
  confidenceTier,
  buildDomainEmailsLookup,
  exportGhlContacts,
  exportGhlCompanies,
  exportGhlOpportunities,
  writeMasterCsv,
  MASTER_COLUMNS,
  STAGE_RANK,
};

// Run main only when executed directly
if (require.main === module) {
  main();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run scripts/build-master.test.js`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/build-master.js scripts/build-master.test.js
git commit -m "feat: add build-master.js with ingest, merge, enrich, and export phases"
```

---

## Task 4: Add tests for enrichment, pipeline stage, and GHL export

**Files:**
- Modify: `scripts/build-master.test.js`

- [ ] **Step 1: Add enrichment, overwrite, and GHL export tests**

Append to `scripts/build-master.test.js`:

```js
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

  it("returns enriched for anymailfinder emails", () => {
    expect(computePipelineStage({ email_source: "anymailfinder_original" })).toBe("enriched");
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
```

- [ ] **Step 2: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS (fields.test.js + build-master.test.js)

- [ ] **Step 3: Commit**

```bash
git add scripts/build-master.test.js
git commit -m "test: add enrichment, pipeline stage, and GHL export tests"
```

---

## Task 5: Add npm script and update vitest config

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add build-master script to package.json**

Add to the `"scripts"` section:

```json
"master": "node scripts/build-master.js",
"master:ghl": "node scripts/build-master.js --export ghl"
```

- [ ] **Step 2: Verify the script runs with --dry-run**

Run: `node scripts/build-master.js --dry-run`
Expected: Prints ingest counts and summary, then "[DRY RUN] No files written." No errors.

- [ ] **Step 3: Run the script for real to generate master CSV**

Run: `node scripts/build-master.js`
Expected: Creates `data/master/leads_master.csv`. Prints summary with domain count, contact count, breakdown by source and stage.

- [ ] **Step 4: Run with GHL export**

Run: `node scripts/build-master.js --export ghl`
Expected: Creates `data/master/leads_master.csv`, `ghl_contacts.csv`, `ghl_companies.csv`, `ghl_opportunities.csv`.

- [ ] **Step 5: Spot-check output files**

```bash
head -3 data/master/leads_master.csv
head -3 data/master/ghl_contacts.csv
head -3 data/master/ghl_companies.csv
head -3 data/master/ghl_opportunities.csv
wc -l data/master/*.csv
```

Verify: headers match spec, data looks reasonable, row counts are in expected ranges.

- [ ] **Step 6: Commit**

```bash
git add package.json
git commit -m "chore: add npm scripts for build-master"
```

---

## Task 6: Run full test suite and final verification

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS across both test files.

- [ ] **Step 2: Run build-master with --dry-run to verify no regressions**

Run: `node scripts/build-master.js --dry-run`
Expected: Clean output, no errors.

- [ ] **Step 3: Final commit with all changes**

If any uncommitted fixes remain:

```bash
git add -A
git commit -m "feat: master lead consolidation and GHL export complete"
```
