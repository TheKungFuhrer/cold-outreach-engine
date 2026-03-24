# Lead Scoring Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a weighted lead scoring module that ranks confirmed venue leads 1-100 by Intensive conversion likelihood, outputting a scored CSV for Bryce's Wavv dialer.

**Architecture:** Two new files — a config module (`scoring-config.js`) with all weights, keyword lists, chain blocklists, and metro lookups, and a scorer script (`score_leads.js`) that reads the clean venues CSV, joins phone type/email count/engagement data from other pipeline files, applies the weighted scoring rubric, and writes a sorted output CSV. No existing files are modified.

**Tech Stack:** Node.js, csv-parse/csv-stringify (existing), shared utilities (csv.js, fields.js, dedup.js, utils.js)

**Spec:** `docs/superpowers/specs/2026-03-24-lead-scoring-design.md`

---

### Task 1: Create scoring config module

**Files:**
- Create: `2-enrichment/scoring-config.js`

This file exports all tunable scoring parameters. Separating config from logic means weights can be adjusted without touching the scorer.

- [ ] **Step 1: Create the weights config**

```javascript
// 2-enrichment/scoring-config.js
/**
 * Lead scoring configuration.
 * All weights, keyword lists, and lookup tables in one place.
 */

const WEIGHTS = {
  // Engagement (max +35)
  engagement: {
    reply: 20,
    click: 10,
    repeatedOpens: 5,       // open_count >= 3
    openThreshold: 3,
  },
  // Phone type (max +15)
  phone: {
    mobile: 15,
    voip: 5,
    landline: 2,
    none: 0,
  },
  // Website presence (max +10) — mutually exclusive
  website: {
    hasWebsite: 10,
    socialOnly: 3,
    none: 0,
  },
  // Venue category (max +12)
  category: {
    primary: 12,
    strongAdjacent: 8,
    weakAdjacent: 3,
    unknown: 0,
  },
  // Metro market tier (max +12)
  metro: {
    tier1: 12,
    tier2: 7,
    tier3: 2,
  },
  // Email contact depth (max +8)
  emailDepth: {
    threeOrMore: 8,
    oneOrTwo: 4,
    none: 0,
    thresholdHigh: 3,
  },
  // Chain detection (-10 to +5)
  chain: {
    independent: 5,
    chain: -10,
  },
};
```

- [ ] **Step 2: Add category keyword lists**

Append to `scoring-config.js`:

```javascript
const CATEGORY_KEYWORDS = {
  primary: [
    "event venue", "banquet hall", "wedding venue", "reception hall",
    "event center", "conference center", "event space", "ballroom",
  ],
  strongAdjacent: [
    "winery", "vineyard", "estate", "resort", "country club",
    "golf club", "mansion", "lodge", "barn", "chateau",
    "pavilion", "inn", "bed and breakfast", "b&b",
  ],
  weakAdjacent: [
    "restaurant", "hotel", "brewery", "farm", "museum",
    "garden", "botanical", "amphitheater", "yacht club", "social club",
  ],
};
```

- [ ] **Step 3: Add chain detection blocklist and patterns**

Append to `scoring-config.js`:

```javascript
const CHAIN_BLOCKLIST = [
  // Hotels/Resorts
  "marriott", "hilton", "holiday inn", "hampton inn", "best western",
  "hyatt", "sheraton", "westin", "radisson", "wyndham", "ihg",
  "crowne plaza", "doubletree", "embassy suites", "fairfield inn",
  "courtyard", "residence inn", "springhill suites", "la quinta",
  "comfort inn", "quality inn", "days inn", "super 8", "motel 6",
  "four seasons", "ritz-carlton", "ritz carlton", "w hotel",
  "homewood suites", "home2 suites", "tru by hilton", "canopy by hilton",
  "aloft", "element by westin", "ac hotel", "le meridien",
  "st regis", "jw marriott", "autograph collection",
  // Restaurants
  "olive garden", "red lobster", "applebees", "applebee's",
  "chilis", "chili's", "tgi fridays", "tgi friday's",
  "outback steakhouse", "outback", "ruths chris", "ruth's chris",
  "capital grille", "the capital grille", "mortons", "morton's",
  "maggianos", "maggiano's", "dave and busters", "dave & buster's",
  "topgolf",
  // Event chains
  "bowlero", "main event", "chuck e cheese", "chuck e. cheese",
];

// Patterns that indicate franchise/chain — matched against company_name
const CHAIN_PATTERNS = [
  // "by [ChainName]" — dynamically built from CHAIN_BLOCKLIST
  // Location numbering
  /\b#\d+\b/,
  /\bunit\s+\d+\b/i,
  /\blocation\s+\d+\b/i,
  /\bstore\s+\d+\b/i,
];

/**
 * Check if a company name matches a known chain.
 * @param {string} name - company_name value
 * @returns {boolean}
 */
function isChain(name) {
  if (!name) return false;
  const lower = name.toLowerCase();

  // Check blocklist as whole-word matches
  for (const chain of CHAIN_BLOCKLIST) {
    const re = new RegExp(`\\b${chain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(lower)) return true;
  }

  // Check generic franchise patterns
  for (const pattern of CHAIN_PATTERNS) {
    if (pattern.test(name)) return true;
  }

  return false;
}
```

- [ ] **Step 4: Add metro tier lookup**

Append to `scoring-config.js`. Structure: `{ STATE: { city: tier } }`. Includes primary cities + major suburbs for Tier 1 metros.

```javascript
const METRO_TIERS = {
  // Tier 1 — 1M+ metro population
  NY: { "New York": 1, "Brooklyn": 1, "Queens": 1, "Bronx": 1, "Staten Island": 1, "Yonkers": 1, "White Plains": 1, "New Rochelle": 1 },
  CA: {
    "Los Angeles": 1, "Long Beach": 1, "Pasadena": 1, "Glendale": 1, "Santa Monica": 1, "Burbank": 1, "Torrance": 1, "Anaheim": 1, "Irvine": 1,
    "San Francisco": 1, "Oakland": 1, "San Jose": 1, "Berkeley": 1, "Fremont": 1, "Hayward": 1, "Sunnyvale": 1, "Santa Clara": 1, "Palo Alto": 1,
    "San Diego": 1, "Chula Vista": 1, "Carlsbad": 1, "Oceanside": 1, "Escondido": 1,
    "Sacramento": 1, "Elk Grove": 1, "Roseville": 1, "Folsom": 1,
    // Tier 2
    "Fresno": 2, "Bakersfield": 2, "Stockton": 2,
  },
  IL: { "Chicago": 1, "Aurora": 1, "Naperville": 1, "Evanston": 1, "Schaumburg": 1, "Joliet": 1, "Elgin": 1, "Arlington Heights": 1 },
  TX: {
    "Dallas": 1, "Fort Worth": 1, "Arlington": 1, "Plano": 1, "Frisco": 1, "McKinney": 1, "Irving": 1, "Grand Prairie": 1, "Denton": 1,
    "Houston": 1, "Sugar Land": 1, "Pearland": 1, "The Woodlands": 1, "Katy": 1, "Pasadena": 1, "League City": 1,
    "San Antonio": 1, "New Braunfels": 1,
    "Austin": 1, "Round Rock": 1, "Cedar Park": 1, "Georgetown": 1, "Pflugerville": 1,
    // Tier 2
    "El Paso": 2, "McAllen": 2,
  },
  DC: { "Washington": 1 },
  VA: { "Alexandria": 1, "Arlington": 1, "Fairfax": 1, "Reston": 1, "McLean": 1, "Tysons": 1, "Richmond": 2 },
  MD: { "Baltimore": 1, "Bethesda": 1, "Silver Spring": 1, "Rockville": 1, "Columbia": 1, "Annapolis": 1 },
  PA: { "Philadelphia": 1, "King of Prussia": 1, "Pittsburgh": 1 },
  FL: {
    "Miami": 1, "Fort Lauderdale": 1, "West Palm Beach": 1, "Boca Raton": 1, "Coral Gables": 1, "Hialeah": 1,
    "Tampa": 1, "St. Petersburg": 1, "Clearwater": 1, "Brandon": 1,
    "Orlando": 1, "Kissimmee": 1, "Winter Park": 1, "Lake Mary": 1,
    // Tier 2
    "Jacksonville": 2, "Sarasota": 2, "Cape Coral": 2, "Fort Myers": 2, "Lakeland": 2, "Deltona": 2, "Palm Bay": 2,
  },
  GA: { "Atlanta": 1, "Marietta": 1, "Roswell": 1, "Sandy Springs": 1, "Alpharetta": 1, "Decatur": 1, "Kennesaw": 1 },
  MA: { "Boston": 1, "Cambridge": 1, "Brookline": 1, "Somerville": 1, "Quincy": 1, "Newton": 1, "Worcester": 1 },
  AZ: { "Phoenix": 1, "Scottsdale": 1, "Mesa": 1, "Tempe": 1, "Chandler": 1, "Gilbert": 1, "Glendale": 1, "Tucson": 2 },
  WA: { "Seattle": 1, "Bellevue": 1, "Tacoma": 1, "Redmond": 1, "Kirkland": 1, "Everett": 1, "Spokane": 2 },
  MN: { "Minneapolis": 1, "St. Paul": 1, "Bloomington": 1, "Plymouth": 1, "Eagan": 1, "Eden Prairie": 1 },
  CO: { "Denver": 1, "Aurora": 1, "Lakewood": 1, "Arvada": 1, "Boulder": 1, "Centennial": 1, "Colorado Springs": 2 },
  MO: {
    "St. Louis": 1, "Clayton": 1, "Chesterfield": 1,
    "Kansas City": 1, "Independence": 1, "Lee's Summit": 1, "Overland Park": 1, "Olathe": 1,
  },
  KS: { "Overland Park": 1, "Olathe": 1, "Kansas City": 1, "Wichita": 2 },
  OR: { "Portland": 1, "Beaverton": 1, "Hillsboro": 1, "Lake Oswego": 1, "Tigard": 1 },
  NC: { "Charlotte": 1, "Concord": 1, "Huntersville": 1, "Raleigh": 2, "Durham": 2, "Winston-Salem": 2, "Greensboro": 2, "Greenville": 2 },
  NV: { "Las Vegas": 1, "Henderson": 1, "North Las Vegas": 1, "Reno": 2 },
  TN: { "Nashville": 1, "Franklin": 1, "Murfreesboro": 1, "Brentwood": 1, "Memphis": 2, "Knoxville": 2, "Chattanooga": 2 },
  OH: { "Cincinnati": 1, "Columbus": 2, "Dayton": 2 },
  IN: { "Indianapolis": 2, "Carmel": 2, "Fishers": 2 },
  WI: { "Milwaukee": 2, "Madison": 2 },
  LA: { "New Orleans": 2, "Metairie": 2, "Baton Rouge": 2 },
  UT: { "Salt Lake City": 2, "Provo": 2, "Ogden": 2 },
  AL: { "Birmingham": 2 },
  OK: { "Oklahoma City": 2, "Tulsa": 2 },
  KY: { "Louisville": 2 },
  SC: { "Charleston": 2, "Greenville": 2 },
  CT: { "Hartford": 2, "Bridgeport": 2 },
  NE: { "Omaha": 2 },
  NM: { "Albuquerque": 2 },
  IA: { "Des Moines": 2 },
  ID: { "Boise": 2 },
  HI: { "Honolulu": 2 },
  AR: { "Little Rock": 2 },
  MI: { "Grand Rapids": 2, "Detroit": 1, "Ann Arbor": 1, "Troy": 1, "Dearborn": 1 },
};

/**
 * Get metro tier for a city/state pair.
 * @param {string} city
 * @param {string} state - 2-letter state code
 * @returns {number} 1, 2, or 3
 */
function getMetroTier(city, state) {
  if (!city || !state) return 3;
  const stateMap = METRO_TIERS[state.toUpperCase()];
  if (!stateMap) return 3;
  // Try exact match first, then case-insensitive
  if (stateMap[city]) return stateMap[city];
  const cityLower = city.toLowerCase();
  for (const [name, tier] of Object.entries(stateMap)) {
    if (name.toLowerCase() === cityLower) return tier;
  }
  return 3;
}
```

- [ ] **Step 5: Add category matching function and exports**

Append to `scoring-config.js`:

```javascript
/**
 * Determine venue category tier from source query or company name.
 * Checks primary keywords first, then strong adjacent, then weak adjacent.
 * @param {string} sourceQuery - _source_query field (may be empty)
 * @param {string} companyName - company_name field
 * @returns {"primary"|"strongAdjacent"|"weakAdjacent"|"unknown"}
 */
function matchesKeywords(text, keywords) {
  for (const keyword of keywords) {
    const re = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text)) return true;
  }
  return false;
}

/**
 * Two-pass approach: check sourceQuery first, fall back to companyName.
 * Within each pass, checks primary > strongAdjacent > weakAdjacent.
 */
function matchCategory(sourceQuery, companyName) {
  // Pass 1: check sourceQuery if present
  if (sourceQuery) {
    if (matchesKeywords(sourceQuery, CATEGORY_KEYWORDS.primary)) return "primary";
    if (matchesKeywords(sourceQuery, CATEGORY_KEYWORDS.strongAdjacent)) return "strongAdjacent";
    if (matchesKeywords(sourceQuery, CATEGORY_KEYWORDS.weakAdjacent)) return "weakAdjacent";
  }
  // Pass 2: fall back to companyName
  if (companyName) {
    if (matchesKeywords(companyName, CATEGORY_KEYWORDS.primary)) return "primary";
    if (matchesKeywords(companyName, CATEGORY_KEYWORDS.strongAdjacent)) return "strongAdjacent";
    if (matchesKeywords(companyName, CATEGORY_KEYWORDS.weakAdjacent)) return "weakAdjacent";
  }
  return "unknown";
}

module.exports = {
  WEIGHTS,
  CATEGORY_KEYWORDS,
  CHAIN_BLOCKLIST,
  CHAIN_PATTERNS,
  METRO_TIERS,
  isChain,
  getMetroTier,
  matchCategory,
};
```

- [ ] **Step 6: Verify config module loads without errors**

Run: `node -e "const c = require('./2-enrichment/scoring-config.js'); console.log('Weights:', Object.keys(c.WEIGHTS)); console.log('Chains:', c.CHAIN_BLOCKLIST.length); console.log('isChain test:', c.isChain('Courtyard by Marriott')); console.log('getMetroTier test:', c.getMetroTier('Austin', 'TX')); console.log('matchCategory test:', c.matchCategory('banquet hall', ''));"`

Expected:
```
Weights: [ 'engagement', 'phone', 'website', 'category', 'metro', 'emailDepth', 'chain' ]
Chains: 43
isChain test: true
getMetroTier test: 1
matchCategory test: primary
```

- [ ] **Step 7: Commit**

```bash
git add 2-enrichment/scoring-config.js
git commit -m "feat: add lead scoring config with weights, chains, metros, categories"
```

---

### Task 2: Create the scorer module

**Files:**
- Create: `2-enrichment/score_leads.js`

**Dependencies:**
- `2-enrichment/scoring-config.js` (from Task 1)
- `shared/csv.js` — `readCsv`, `writeCsv`
- `shared/fields.js` — `parseLocation`, `resolveField`
- `shared/dedup.js` — `normalizeDomain`
- `shared/utils.js` — `projectPath`, `timestamp`

- [ ] **Step 1: Create scorer with CLI arg parsing and input resolution**

```javascript
#!/usr/bin/env node
/**
 * Lead scoring module.
 * Reads clean venue CSV, joins phone/email/engagement data,
 * applies weighted scoring rubric, outputs ranked CSV.
 *
 * Usage: node 2-enrichment/score_leads.js [--input <file>] [--output-dir <dir>]
 */

const fs = require("fs");
const path = require("path");
const { readCsv, writeCsv } = require("../shared/csv");
const { parseLocation, resolveField } = require("../shared/fields");
const { normalizeDomain } = require("../shared/dedup");
const { projectPath, timestamp } = require("../shared/utils");
const {
  WEIGHTS, isChain, getMetroTier, matchCategory,
} = require("./scoring-config");

// --- CLI args ---
const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const inputArg = getArg("--input");
const outputDir = getArg("--output-dir") || projectPath("data", "scored");

// --- Resolve input file: most recent data/final/clean_venues_*.csv ---
function findLatestCleanVenues() {
  const dir = projectPath("data", "final");
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith("clean_venues_") && f.endsWith(".csv"))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(dir, files[0]) : null;
}

const inputFile = inputArg || findLatestCleanVenues();
if (!inputFile) {
  console.error("No input file found. Use --input or run export_clean.js first.");
  process.exit(1);
}

// --- Build lookup maps ---

/**
 * Build phone type lookup from phone_validated segment files.
 * Key: email (lowercase). Value: "mobile"|"voip"|"landline"|"invalid"|"none".
 * Precedence: mobile > voip > landline > invalid > none.
 */
function buildPhoneTypeLookup() {
  const lookup = {};
  const segments = [
    { file: "no_phone.csv", type: "none" },
    { file: "invalid.csv", type: "invalid" },
    { file: "landline.csv", type: "landline" },
    { file: "voip.csv", type: "voip" },
    { file: "mobile.csv", type: "mobile" },
  ];
  // Load in precedence order (lowest first, highest overwrites)
  for (const { file, type } of segments) {
    const filepath = projectPath("data", "phone_validated", file);
    const { records } = readCsv(filepath);
    for (const row of records) {
      const email = (row.email || row.Email || "").toLowerCase().trim();
      if (email) lookup[email] = type;
    }
  }
  return lookup;
}

/**
 * Build email count per domain from master enriched email list.
 * Key: normalized domain. Value: count of unique emails.
 */
function buildEmailCountLookup() {
  const filepath = projectPath("data", "upload", "master_enriched_emails.csv");
  if (!fs.existsSync(filepath)) {
    console.warn("  WARNING: Master email file not found:", filepath);
    return {};
  }
  const { records } = readCsv(filepath);
  const domainEmails = {};
  for (const row of records) {
    const website = row.website || row.company_url || row.domain || "";
    const domain = normalizeDomain(website);
    const email = (row.email || "").toLowerCase().trim();
    if (domain && email) {
      if (!domainEmails[domain]) domainEmails[domain] = new Set();
      domainEmails[domain].add(email);
    }
  }
  // Convert sets to counts
  const counts = {};
  for (const [domain, emails] of Object.entries(domainEmails)) {
    counts[domain] = emails.size;
  }
  return counts;
}

/**
 * Build engagement lookup from SmartLead campaign exports in data/raw/.
 * Key: email (lowercase). Value: { open_count, click_count, reply_count }.
 */
function buildEngagementLookup() {
  const lookup = {};
  const rawDir = projectPath("data", "raw");
  if (!fs.existsSync(rawDir)) return lookup;
  const files = fs.readdirSync(rawDir)
    .filter((f) => f.endsWith(".csv"))
    .sort()
    .reverse();
  for (const file of files) {
    const { records } = readCsv(path.join(rawDir, file));
    for (const row of records) {
      const email = (row.email || row.Email || "").toLowerCase().trim();
      if (!email) continue;
      if (lookup[email]) continue; // keep most recent (files sorted desc)
      const openCount = parseInt(row.open_count || "0", 10) || 0;
      const clickCount = parseInt(row.click_count || "0", 10) || 0;
      const replyCount = parseInt(row.reply_count || "0", 10) || 0;
      if (openCount || clickCount || replyCount) {
        lookup[email] = { openCount, clickCount, replyCount };
      }
    }
  }
  return lookup;
}

// --- Score a single lead ---

/**
 * Score a lead record.
 * @param {object} lead - CSV row from clean venues
 * @param {object} phoneTypeLookup
 * @param {object} emailCountLookup
 * @param {object} engagementLookup
 * @returns {number} score 1-100
 */
function scoreLead(lead, phoneTypeLookup, emailCountLookup, engagementLookup) {
  let score = 0;
  const W = WEIGHTS;

  const email = resolveField(lead, "email").toLowerCase();
  const companyName = resolveField(lead, "companyName");
  const website = resolveField(lead, "website");
  const rawLocation = resolveField(lead, "location");
  const sourceQuery = lead._source_query || "";
  const socialMediaFlag = lead._social_media_flag || "";

  // --- Engagement ---
  const engagement = engagementLookup[email] || { openCount: 0, clickCount: 0, replyCount: 0 };
  if (engagement.replyCount > 0) score += W.engagement.reply;
  if (engagement.clickCount > 0) score += W.engagement.click;
  if (engagement.openCount >= W.engagement.openThreshold) score += W.engagement.repeatedOpens;

  // --- Phone type ---
  const phoneType = phoneTypeLookup[email] || "none";
  score += W.phone[phoneType] || 0;

  // --- Website presence (mutually exclusive) ---
  if (socialMediaFlag) {
    score += W.website.socialOnly;
  } else if (website && normalizeDomain(website)) {
    score += W.website.hasWebsite;
  }

  // --- Venue category ---
  const category = matchCategory(sourceQuery, companyName);
  score += W.category[category] || 0;

  // --- Metro tier ---
  const { city, state } = parseLocation(rawLocation);
  const tier = getMetroTier(city, state);
  if (tier === 1) score += W.metro.tier1;
  else if (tier === 2) score += W.metro.tier2;
  else score += W.metro.tier3;

  // --- Email contact depth ---
  const domain = normalizeDomain(website);
  const emailCount = domain ? (emailCountLookup[domain] || 0) : 0;
  if (emailCount >= W.emailDepth.thresholdHigh) score += W.emailDepth.threeOrMore;
  else if (emailCount >= 1) score += W.emailDepth.oneOrTwo;

  // --- Chain detection ---
  if (isChain(companyName)) {
    score += W.chain.chain;
  } else {
    score += W.chain.independent;
  }

  // Clamp to 1-100
  return Math.max(1, Math.min(100, score));
}

// --- Main ---

function main() {
  console.log(`Reading leads from: ${inputFile}`);
  const { records, columns } = readCsv(inputFile);
  if (records.length === 0) {
    console.log("No records found in input file.");
    process.exit(0);
  }

  console.log(`Loaded ${records.length} venue leads`);
  console.log("Building lookup maps...");

  const phoneTypeLookup = buildPhoneTypeLookup();
  console.log(`  Phone types: ${Object.keys(phoneTypeLookup).length} entries`);

  const emailCountLookup = buildEmailCountLookup();
  console.log(`  Email counts: ${Object.keys(emailCountLookup).length} domains`);

  const engagementLookup = buildEngagementLookup();
  console.log(`  Engagement: ${Object.keys(engagementLookup).length} leads with activity`);

  // Score all leads
  console.log("\nScoring leads...");
  for (const lead of records) {
    lead.score = scoreLead(lead, phoneTypeLookup, emailCountLookup, engagementLookup);
  }

  // Sort by score descending
  records.sort((a, b) => b.score - a.score);

  // Write output
  const outColumns = [...columns, "score"];
  const outFile = path.join(outputDir, `scored_venues_${timestamp()}.csv`);
  writeCsv(outFile, records, outColumns);
  console.log(`\nSaved to: ${outFile}`);

  // Print distribution summary
  const buckets = [
    { label: "90-100", min: 90, max: 100 },
    { label: "70-89 ", min: 70, max: 89 },
    { label: "50-69 ", min: 50, max: 69 },
    { label: "30-49 ", min: 30, max: 49 },
    { label: " 1-29 ", min: 1, max: 29 },
  ];
  console.log(`\nScored ${records.length} venues\n`);
  console.log("Score distribution:");
  for (const { label, min, max } of buckets) {
    const count = records.filter((r) => r.score >= min && r.score <= max).length;
    const pct = ((count / records.length) * 100).toFixed(1);
    console.log(`  ${label}: ${count.toLocaleString().padStart(7)} leads  (${pct}%)`);
  }

  // Top 10
  console.log("\nTop 10 leads:");
  for (let i = 0; i < Math.min(10, records.length); i++) {
    const r = records[i];
    const name = resolveField(r, "companyName") || "Unknown";
    const rawLoc = resolveField(r, "location");
    const { city, state } = parseLocation(rawLoc);
    const loc = city && state ? `${city}, ${state}` : rawLoc;
    console.log(`  ${i + 1}. ${name} (${loc}) — ${r.score}`);
  }
}

main();
```

- [ ] **Step 2: Verify the script loads without syntax errors**

Run: `node -c 2-enrichment/score_leads.js`

Expected: no output (clean parse)

- [ ] **Step 3: Commit**

```bash
git add 2-enrichment/score_leads.js
git commit -m "feat: add lead scoring module with weighted rubric and data joins"
```

---

### Task 3: Add npm script and verify end-to-end

**Files:**
- Modify: `package.json` (add `"score"` script)

- [ ] **Step 1: Add npm script**

Add to the `"scripts"` section of `package.json`, after the `"export"` entry:

```json
"score": "node 2-enrichment/score_leads.js",
```

- [ ] **Step 2: Run the scorer against real data (dry check)**

Run: `node 2-enrichment/score_leads.js`

Expected output:
```
Reading leads from: data/final/clean_venues_<latest>.csv
Loaded <N> venue leads
Building lookup maps...
  Phone types: <N> entries
  Email counts: <N> domains
  Engagement: <N> leads with activity

Scoring leads...

Saved to: data/scored/scored_venues_<timestamp>.csv

Scored <N> venues

Score distribution:
  90-100:     ... leads  (...)
  70-89 :     ... leads  (...)
  50-69 :     ... leads  (...)
  30-49 :     ... leads  (...)
   1-29 :     ... leads  (...)

Top 10 leads:
  1. ...
```

If the `data/final/` directory is empty or missing, the script will exit with a helpful error. In that case, verify the script runs without errors by pointing it at any available CSV:

Run: `node 2-enrichment/score_leads.js --input data/classified/venues.csv` (or whichever classified CSV exists)

- [ ] **Step 3: Spot-check output CSV**

Run: `head -5 data/scored/scored_venues_*.csv` to verify:
- The `score` column is the last column
- Records are sorted by score descending
- Scores are integers between 1 and 100

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "feat: add npm score script for lead scoring"
```

---

### Task 4: Manual validation and weight tuning

This task is not automated — it's a checklist for the operator (Dylan) to validate scoring output.

- [ ] **Step 1: Review the top 50 scored leads**

Open `data/scored/scored_venues_<latest>.csv` and check:
- Do the top-scored leads look like strong Intensive prospects?
- Are chains correctly penalized (should appear near the bottom)?
- Are primary venue types (banquet halls, event venues) ranking above restaurants?

- [ ] **Step 2: Review the bottom 50 scored leads**

Check:
- Are these genuinely lower-priority leads?
- Any surprises that should score higher?

- [ ] **Step 3: Adjust weights if needed**

Edit `2-enrichment/scoring-config.js` — change values in the `WEIGHTS` object and re-run `node 2-enrichment/score_leads.js`. No code changes needed, just config values.

- [ ] **Step 4: Commit final tuned weights (if changed)**

```bash
git add 2-enrichment/scoring-config.js
git commit -m "tune: adjust lead scoring weights based on manual review"
```
