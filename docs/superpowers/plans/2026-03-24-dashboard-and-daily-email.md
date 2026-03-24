# Dashboard & Daily Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a live Express dashboard, data refresh script, and daily email summary for the cold outreach pipeline.

**Architecture:** Single `refresh-dashboard.js` reads all source files (report JSONs, master CSV, scored venues, sync data) and writes `dashboard-data.json`. Express server on port 7777 with basic auth calls refresh on each page load and serves a self-contained Chart.js HTML dashboard. Daily email reads the same JSON and sends a mobile-friendly HTML briefing via Nodemailer/Gmail SMTP. Both refresh and email integrate into `daily-sync.js` as non-fatal steps.

**Tech Stack:** Node.js, Express, express-basic-auth, Nodemailer, Chart.js (CDN), vitest

**Spec:** `docs/superpowers/specs/2026-03-24-dashboard-and-daily-email-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `scripts/refresh-dashboard.js` | Create | Reads all source files, computes metrics, writes `data/artifacts/dashboard-data.json`. Exports `refresh()` function. |
| `scripts/dashboard-server.js` | Create | Express server on port 7777. Basic auth. Routes: `/` (refresh + serve HTML), `/api/data` (serve JSON), `/api/hot-leads.csv` (Wavv CSV export). |
| `scripts/dashboard.html` | Create | Self-contained Chart.js dashboard. Fetches `/api/data`, renders 9 sections. Mobile-first, dark theme. Stored in `scripts/` since `data/` is gitignored. |
| `scripts/daily-email.js` | Create | Builds mobile-friendly HTML email from dashboard JSON. Sends via Nodemailer Gmail SMTP. Exports `sendDailyEmail(data)`. Standalone test via `--test` flag. |
| `scripts/daily-sync.js` | Modify | Append refresh + email steps after SmartLead sync. Remove old dashboard update call if present. |
| `package.json` | Modify | Add express, express-basic-auth, nodemailer dependencies. Add `dashboard` and `dashboard:email` scripts. |
| `.env.example` | Modify | Add DASHBOARD_PORT, DASHBOARD_USER, DASHBOARD_PASS, GMAIL_USER, GMAIL_APP_PASSWORD, BRYCE_EMAIL, VPS_URL. |
| `tests/refresh-dashboard.test.js` | Create | Unit tests for data transformation logic in refresh-dashboard.js. |

---

### Task 1: Dependencies and Environment Setup

**Files:**
- Modify: `package.json`
- Modify: `.env.example`

- [ ] **Step 1: Install npm dependencies**

```bash
cd C:/Users/Administrator/projects/cold-outreach-engine
npm install express express-basic-auth nodemailer
```

- [ ] **Step 2: Add npm scripts to package.json**

Add these to the `"scripts"` section in `package.json`:

```json
"dashboard": "node scripts/dashboard-server.js",
"dashboard:refresh": "node scripts/refresh-dashboard.js",
"dashboard:email": "node scripts/daily-email.js --test"
```

- [ ] **Step 3: Update .env.example**

Append to `.env.example`:

```
# Dashboard & Email
DASHBOARD_PORT=7777
DASHBOARD_USER=admin
DASHBOARD_PASS=
GMAIL_USER=
GMAIL_APP_PASSWORD=
BRYCE_EMAIL=
VPS_URL=http://localhost:7777
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .env.example
git commit -m "chore: add express, nodemailer deps and dashboard env vars"
```

---

### Task 2: Data Refresh — Helpers and Funnel

**Files:**
- Create: `scripts/refresh-dashboard.js`
- Create: `tests/refresh-dashboard.test.js`

This task builds the first half of `refresh-dashboard.js`: the `latestFile()` helper and funnel data computation.

- [ ] **Step 1: Write failing test for `latestFile` helper**

Create `tests/refresh-dashboard.test.js`:

```javascript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { latestFile, buildFunnel } from "../scripts/refresh-dashboard.js";

describe("refresh-dashboard", () => {
  describe("latestFile", () => {
    it("should return null when no files match the glob pattern", () => {
      const result = latestFile("data/reports/nonexistent_*.json");
      expect(result).toBeNull();
    });
  });
});
```

Note: Import all functions at the top of the file (static ESM import). As new functions are added in Tasks 3-4, add them to this import line. This avoids vitest's dynamic import caching issues.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/refresh-dashboard.test.js
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the refresh-dashboard.js scaffold with latestFile**

Create `scripts/refresh-dashboard.js`:

```javascript
/**
 * Refresh Dashboard Data
 *
 * Reads all pipeline source files and writes data/artifacts/dashboard-data.json.
 * Called by dashboard-server.js on page load and by daily-sync.js before email.
 *
 * Usage: node scripts/refresh-dashboard.js
 */

const fs = require("fs");
const path = require("path");
const { projectPath, ensureDir } = require("../shared/utils");
const { loadJson, saveJson } = require("../shared/progress");
const { readCsv } = require("../shared/csv");

const ARTIFACTS_DIR = projectPath("data", "artifacts");
const REPORTS_DIR = projectPath("data", "reports");

/**
 * Find the latest file matching a glob-like pattern (simple timestamp sort).
 * Pattern: "prefix_*.ext" where * matches the timestamp portion.
 * @param {string} relPattern - Relative pattern like "data/reports/funnel_report_*.json"
 * @returns {string|null} Absolute path to latest file, or null
 */
function latestFile(relPattern) {
  const dir = projectPath(path.dirname(relPattern));
  const base = path.basename(relPattern);
  const [prefix, ext] = base.split("*");

  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith(ext))
    .sort()
    .reverse();

  return files.length > 0 ? path.join(dir, files[0]) : null;
}

// --- Funnel ---

const FUNNEL_STAGE_MAP = {
  "GeoLead net-new": "raw",
  "Post pre-filter": "filtered",
  "Classified venues": "classified",
  "Phone: mobile": "validated_mobile",
  "Phone: landline": "validated_landline",
  "Phone: invalid": "validated_invalid",
  "Phone: no phone": "validated_no_phone",
};

// Simplified funnel stages for the dashboard
const DASHBOARD_STAGES = ["raw", "filtered", "classified", "validated", "uploaded", "in_campaign"];

function buildFunnel(funnelReport, masterMap) {
  const stageCounts = {};

  // From funnel report
  if (funnelReport && funnelReport.stages) {
    for (const s of funnelReport.stages) {
      const mapped = FUNNEL_STAGE_MAP[s.name];
      if (mapped) {
        if (mapped.startsWith("validated_")) {
          stageCounts.validated = (stageCounts.validated || 0) + s.count;
        } else {
          stageCounts[mapped] = s.count;
        }
      }
    }
  }

  // From master map if available — uploaded and in_campaign
  if (masterMap) {
    let uploaded = 0, inCampaign = 0;
    for (const [, emails] of masterMap) {
      for (const [, record] of emails) {
        const stage = record.pipeline_stage;
        if (stage === "uploaded" || stage === "in_campaign") uploaded++;
        if (stage === "in_campaign") inCampaign++;
      }
    }
    stageCounts.uploaded = uploaded;
    stageCounts.in_campaign = inCampaign;
  }

  const stages = [];
  let prev = null;
  for (const name of DASHBOARD_STAGES) {
    const count = stageCounts[name] || 0;
    const conversionRate = prev !== null && prev > 0 ? +(count / prev).toFixed(3) : null;
    stages.push({ name, count, conversionRate });
    prev = count;
  }

  return { stages };
}

// Placeholder refresh — will be completed in Task 4
async function refresh() {
  ensureDir(ARTIFACTS_DIR);

  // Load funnel report
  const funnelPath = latestFile("data/reports/funnel_report_*.json");
  const funnelReport = funnelPath ? loadJson(funnelPath) : null;

  // Try to load master
  let masterMap = null;
  try {
    const { loadMaster } = require("../shared/master");
    masterMap = loadMaster();
  } catch (e) {
    console.warn("  [warn] Could not load master CSV:", e.message);
  }

  const funnel = buildFunnel(funnelReport, masterMap);

  const data = {
    generatedAt: new Date().toISOString(),
    funnel,
    campaigns: [],
    scoreDistribution: { buckets: [], mean: 0, median: 0 },
    hotLeads: [],
    deadLeads: { bounced: 0, unsubscribed: 0, total: 0 },
    costs: { perStage: [], totalSpend: 0 },
    freshness: { stages: [] },
    sourceQuality: { bySource: [], byDetail: [] },
  };

  const outPath = path.join(ARTIFACTS_DIR, "dashboard-data.json");
  saveJson(outPath, data);
  console.log(`  [ok] Dashboard data written to ${outPath}`);
  return data;
}

module.exports = { refresh, latestFile, buildFunnel };

// CLI entry point
if (require.main === module) {
  (async () => {
    const data = await refresh();
    console.log(`Dashboard data written: ${data.funnel?.stages?.length || 0} funnel stages`);
  })();
}
```

- [ ] **Step 4: Write test for buildFunnel**

Add to `tests/refresh-dashboard.test.js`:

```javascript
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
    expect(result.stages[2]).toEqual({ name: "classified", count: 8958, conversionRate: 0.638 });
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
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/refresh-dashboard.test.js
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/refresh-dashboard.js tests/refresh-dashboard.test.js
git commit -m "feat: add refresh-dashboard scaffold with funnel computation"
```

---

### Task 3: Data Refresh — Campaigns, Scores, Hot Leads, Dead Leads

**Files:**
- Modify: `scripts/refresh-dashboard.js`
- Modify: `tests/refresh-dashboard.test.js`

- [ ] **Step 1: Write failing test for buildCampaigns**

Add to `tests/refresh-dashboard.test.js`:

Update the import at top of test file to include `buildCampaigns`:

```javascript
import { latestFile, buildFunnel, buildCampaigns } from "../scripts/refresh-dashboard.js";
```

Then add the test:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/refresh-dashboard.test.js
```

Expected: FAIL — `buildCampaigns` is not exported.

- [ ] **Step 3: Implement buildCampaigns**

Add to `scripts/refresh-dashboard.js` before the `module.exports` line:

```javascript
function buildCampaigns(statsReport) {
  if (!statsReport || !statsReport.campaigns) return [];

  return statsReport.campaigns.map(c => {
    // SmartLead API returns string-typed count fields
    const sent = Number(c.sent_count) || 0;
    const opened = Number(c.open_count) || 0;
    const replied = Number(c.reply_count) || 0;
    const bounced = Number(c.bounce_count) || 0;

    return {
      name: c.name,
      id: Number(c.id),
      sent,
      opened,
      replied,
      bounced,
      openRate: sent > 0 ? +(opened / sent).toFixed(3) : 0,
      replyRate: sent > 0 ? +(replied / sent).toFixed(3) : 0,
      bounceRate: sent > 0 ? +(bounced / sent).toFixed(3) : 0,
    };
  });
}
```

Update `module.exports` to include `buildCampaigns`:

```javascript
module.exports = { refresh, latestFile, buildFunnel, buildCampaigns };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/refresh-dashboard.test.js
```

- [ ] **Step 5: Write test for buildScoreDistribution**

Update the import at top of test file to include `buildScoreDistribution`:

```javascript
import { latestFile, buildFunnel, buildCampaigns, buildScoreDistribution } from "../scripts/refresh-dashboard.js";
```

```javascript
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
    expect(result.median).toBeCloseTo(38.5, 0);
  });
});
```

- [ ] **Step 6: Implement buildScoreDistribution**

```javascript
function buildScoreDistribution(scoredRows) {
  const buckets = Array.from({ length: 10 }, (_, i) => ({
    range: `${i * 10 + 1}-${(i + 1) * 10}`,
    count: 0,
  }));

  const scores = scoredRows
    .map(r => Number(r.score))
    .filter(s => s > 0 && s <= 100);

  for (const s of scores) {
    const idx = Math.min(Math.floor((s - 1) / 10), 9);
    buckets[idx].count++;
  }

  scores.sort((a, b) => a - b);
  const mean = scores.length > 0 ? +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : 0;
  const median = scores.length > 0
    ? scores.length % 2 === 0
      ? +((scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2).toFixed(1)
      : scores[Math.floor(scores.length / 2)]
    : 0;

  return { buckets, mean, median };
}
```

- [ ] **Step 7: Implement buildHotLeads and buildDeadLeads**

```javascript
/**
 * @param {object} syncData - SmartLead sync JSON
 * @param {object[]} scoredRows - Scored venues CSV rows
 * @param {Map|null} masterMap - Master lead map
 * @param {string|null} lastSyncAt - ISO timestamp of the PREVIOUS sync run (before current sync updated checkpoint).
 *   When called from daily-sync.js, this comes from the sync report's generated_at.
 *   When called standalone (refresh only), falls back to 24 hours ago.
 */
function buildHotLeads(syncData, scoredRows, masterMap, lastSyncAt) {
  if (!syncData || !syncData.leads) return [];

  // Build score lookup by email
  const scoreByEmail = new Map();
  const scoreByDomain = new Map();
  for (const row of scoredRows) {
    const email = (row.email || "").toLowerCase().trim();
    const domain = (row.website || "").toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, "").replace(/\/.*/, "");
    if (email) scoreByEmail.set(email, Number(row.score) || 0);
    if (domain) scoreByDomain.set(domain, Number(row.score) || 0);
  }

  // Default to 24h ago if no lastSyncAt provided (standalone refresh)
  const cutoff = lastSyncAt ? new Date(lastSyncAt) : new Date(Date.now() - 24 * 60 * 60 * 1000);

  const hot = [];
  for (const [email, lead] of Object.entries(syncData.leads)) {
    if (!lead.last_replied_at) continue;
    const repliedAt = new Date(lead.last_replied_at);
    if (repliedAt <= cutoff) continue;

    // Look up company/phone from master
    let company = "", phone = "";
    if (masterMap) {
      const domain = email.split("@")[1] || "";
      const domainMap = masterMap.get(domain);
      if (domainMap) {
        const record = domainMap.get(email) || domainMap.values().next().value;
        company = record?.company_name || record?.company || "";
        phone = record?.phone || "";
      }
    }

    const score = scoreByEmail.get(email) || scoreByDomain.get(email.split("@")[1] || "") || 0;

    hot.push({
      company,
      phone,
      email,
      replyPreview: (lead.reply_text || "").slice(0, 120),
      repliedAt: lead.last_replied_at,
      score,
    });
  }

  return hot.sort((a, b) => b.score - a.score);
}

function buildDeadLeads(syncData) {
  if (!syncData || !syncData.leads) return { bounced: 0, unsubscribed: 0, total: 0 };

  let bounced = 0, unsubscribed = 0;
  for (const lead of Object.values(syncData.leads)) {
    if (lead.smartlead_status === "bounced") bounced++;
    if (lead.smartlead_status === "unsubscribed") unsubscribed++;
  }

  return { bounced, unsubscribed, total: bounced + unsubscribed };
}
```

- [ ] **Step 8: Run all tests**

```bash
npx vitest run tests/refresh-dashboard.test.js
```

- [ ] **Step 9: Commit**

```bash
git add scripts/refresh-dashboard.js tests/refresh-dashboard.test.js
git commit -m "feat: add campaigns, score distribution, hot/dead leads to refresh"
```

---

### Task 4: Data Refresh — Costs, Freshness, Source Quality, and Full Refresh

**Files:**
- Modify: `scripts/refresh-dashboard.js`
- Modify: `tests/refresh-dashboard.test.js`

- [ ] **Step 1: Write test for buildCosts**

Update the import at top of test file to include `buildCosts`:

```javascript
import { latestFile, buildFunnel, buildCampaigns, buildScoreDistribution, buildCosts } from "../scripts/refresh-dashboard.js";
```

```javascript
describe("buildCosts", () => {
  it("should reshape cost report into per-stage array", () => {
    const costReport = {
      haiku: { records: 14052, cost: 42.15 },
      sonnet: { records: 76, cost: 3.80 },
      numverify: { calls: 8958, cost: 8.96 },
      smartlead_verification: { cost: 0 },
      total_cost: 54.91,
    };
    const result = buildCosts(costReport);
    expect(result.perStage).toHaveLength(4);
    expect(result.perStage[0].stage).toBe("haiku");
    expect(result.perStage[0].costPerLead).toBeCloseTo(0.003, 3);
    expect(result.totalSpend).toBe(54.91);
  });
});
```

- [ ] **Step 2: Implement buildCosts**

```javascript
function buildCosts(costReport) {
  if (!costReport) return { perStage: [], totalSpend: 0 };

  const perStage = [];
  const stages = ["haiku", "sonnet", "numverify", "smartlead_verification"];

  for (const stage of stages) {
    const data = costReport[stage];
    if (!data) continue;
    const records = data.records || data.calls || 0;
    const cost = data.cost || 0;
    perStage.push({
      stage,
      costPerLead: records > 0 ? +(cost / records).toFixed(4) : 0,
      totalCost: +cost.toFixed(2),
    });
  }

  return {
    perStage,
    totalSpend: +(costReport.total_cost || 0).toFixed(2),
  };
}
```

- [ ] **Step 3: Implement buildFreshness**

```javascript
function buildFreshness(funnel) {
  if (!funnel || !funnel.stages) return { stages: [] };

  const stages = [];
  for (let i = 0; i < funnel.stages.length - 1; i++) {
    const current = funnel.stages[i];
    const next = funnel.stages[i + 1];
    const unprocessed = Math.max(0, current.count - next.count);

    // Check oldest file modification time in the stage directory
    const stageDirs = {
      raw: "data/enriched",
      filtered: "data/filtered",
      classified: "data/classified",
      validated: "data/phone_validated",
      uploaded: "data/upload",
    };
    let oldestDays = 0;
    const dir = stageDirs[current.name];
    if (dir) {
      const fullDir = projectPath(dir);
      try {
        const files = fs.readdirSync(fullDir).filter(f => f.endsWith(".csv"));
        if (files.length > 0) {
          const oldest = files
            .map(f => fs.statSync(path.join(fullDir, f)).mtimeMs)
            .reduce((min, t) => Math.min(min, t), Infinity);
          oldestDays = Math.floor((Date.now() - oldest) / (1000 * 60 * 60 * 24));
        }
      } catch (e) { /* dir may not exist */ }
    }

    stages.push({
      name: current.name,
      unprocessedCount: unprocessed,
      oldestDays,
    });
  }

  return { stages };
}
```

- [ ] **Step 4: Implement buildSourceQuality**

```javascript
function buildSourceQuality(masterMap, scoreByEmail) {
  if (!masterMap) return { bySource: [], byDetail: [] };

  const srcGroups = new Map();
  const detailGroups = new Map();

  for (const [, emails] of masterMap) {
    for (const [email, record] of emails) {
      const source = record.source || "unknown";
      const detail = record.source_detail || "unknown";
      const score = scoreByEmail?.get(email) || 0;
      const inCampaign = record.pipeline_stage === "in_campaign" ? 1 : 0;

      // By source
      if (!srcGroups.has(source)) srcGroups.set(source, { count: 0, scoreSum: 0, converted: 0 });
      const sg = srcGroups.get(source);
      sg.count++;
      sg.scoreSum += score;
      sg.converted += inCampaign;

      // By detail
      if (detail !== "unknown") {
        if (!detailGroups.has(detail)) detailGroups.set(detail, { count: 0, scoreSum: 0, converted: 0 });
        const dg = detailGroups.get(detail);
        dg.count++;
        dg.scoreSum += score;
        dg.converted += inCampaign;
      }
    }
  }

  const bySource = [...srcGroups.entries()].map(([source, g]) => ({
    source,
    count: g.count,
    avgScore: g.count > 0 ? +(g.scoreSum / g.count).toFixed(1) : 0,
    conversionRate: g.count > 0 ? +(g.converted / g.count).toFixed(3) : 0,
  }));

  const byDetail = [...detailGroups.entries()]
    .map(([searchTerm, g]) => ({
      searchTerm,
      count: g.count,
      avgScore: g.count > 0 ? +(g.scoreSum / g.count).toFixed(1) : 0,
      conversionRate: g.count > 0 ? +(g.converted / g.count).toFixed(3) : 0,
    }))
    .sort((a, b) => b.avgScore - a.avgScore);

  return { bySource, byDetail };
}
```

- [ ] **Step 5: Wire everything into the refresh() function**

Update the `refresh()` function to call all builders:

```javascript
/**
 * @param {object} [options]
 * @param {string} [options.lastSyncAt] - ISO timestamp of previous sync. Passed from daily-sync.js
 *   to ensure hot leads are calculated relative to the correct baseline (before checkpoint update).
 *   When omitted (standalone refresh), defaults to 24h ago inside buildHotLeads.
 */
async function refresh({ lastSyncAt } = {}) {
  ensureDir(ARTIFACTS_DIR);
  console.log("Refreshing dashboard data...");

  // Load all source files
  const funnelPath = latestFile("data/reports/funnel_report_*.json");
  const funnelReport = funnelPath ? loadJson(funnelPath) : null;

  const statsPath = latestFile("data/reports/campaign_stats_*.json");
  const statsReport = statsPath ? loadJson(statsPath) : null;

  const costPath = latestFile("data/reports/cost_report_*.json");
  const costReport = costPath ? loadJson(costPath) : null;

  const syncPath = latestFile("data/lifecycle/smartlead_sync_*.json");
  const syncData = syncPath ? loadJson(syncPath) : null;

  const scoredPath = latestFile("data/scored/scored_venues_*.csv");
  const scoredRows = scoredPath ? readCsv(scoredPath).records : [];

  // Try master
  let masterMap = null;
  try {
    const { loadMaster } = require("../shared/master");
    masterMap = loadMaster();
  } catch (e) {
    console.warn("  [warn] Could not load master CSV:", e.message);
  }

  // Build score lookup
  const scoreByEmail = new Map();
  for (const row of scoredRows) {
    const email = (row.email || "").toLowerCase().trim();
    if (email) scoreByEmail.set(email, Number(row.score) || 0);
  }

  // Build all sections
  const funnel = buildFunnel(funnelReport, masterMap);
  const campaigns = buildCampaigns(statsReport);
  const scoreDistribution = buildScoreDistribution(scoredRows);
  const hotLeads = buildHotLeads(syncData, scoredRows, masterMap, lastSyncAt);
  const deadLeads = buildDeadLeads(syncData);
  const costs = buildCosts(costReport);
  const freshness = buildFreshness(funnel);
  const sourceQuality = buildSourceQuality(masterMap, scoreByEmail);

  const data = {
    generatedAt: new Date().toISOString(),
    funnel,
    campaigns,
    scoreDistribution,
    hotLeads,
    deadLeads,
    costs,
    freshness,
    sourceQuality,
  };

  const outPath = path.join(ARTIFACTS_DIR, "dashboard-data.json");
  saveJson(outPath, data);
  console.log(`  [ok] Dashboard data written to ${outPath}`);
  return data;
}
```

- [ ] **Step 6: Update module.exports**

```javascript
module.exports = {
  refresh,
  latestFile,
  buildFunnel,
  buildCampaigns,
  buildScoreDistribution,
  buildHotLeads,
  buildDeadLeads,
  buildCosts,
  buildFreshness,
  buildSourceQuality,
};
```

- [ ] **Step 7: Run all tests**

```bash
npx vitest run tests/refresh-dashboard.test.js
```

- [ ] **Step 8: Run refresh standalone to verify with real data**

```bash
node scripts/refresh-dashboard.js
```

Expected: `Dashboard data written to data/artifacts/dashboard-data.json` — inspect the JSON to verify structure.

- [ ] **Step 9: Commit**

```bash
git add scripts/refresh-dashboard.js tests/refresh-dashboard.test.js
git commit -m "feat: complete refresh-dashboard with all metric builders"
```

---

### Task 5: Express Dashboard Server

**Files:**
- Create: `scripts/dashboard-server.js`

- [ ] **Step 1: Create dashboard-server.js**

```javascript
/**
 * Dashboard Server
 *
 * Express server serving the outreach dashboard on port 7777.
 * Basic HTTP auth. Refreshes data on each page load.
 *
 * Usage: node scripts/dashboard-server.js
 * Env: DASHBOARD_PORT (default 7777), DASHBOARD_USER (default admin), DASHBOARD_PASS (required)
 */

const express = require("express");
const basicAuth = require("express-basic-auth");
const path = require("path");
const fs = require("fs");
const { projectPath } = require("../shared/utils");
const { refresh } = require("./refresh-dashboard");

const PORT = process.env.DASHBOARD_PORT || 7777;
const USER = process.env.DASHBOARD_USER || "admin";
const PASS = process.env.DASHBOARD_PASS;

if (!PASS) {
  console.error("DASHBOARD_PASS environment variable is required.");
  console.error("Set it in .env or export it before starting the server.");
  process.exit(1);
}

const app = express();

// Basic auth
app.use(basicAuth({
  users: { [USER]: PASS },
  challenge: true,
  realm: "OMG Outreach Dashboard",
}));

// GET / — refresh data, serve dashboard HTML
app.get("/", async (req, res) => {
  try {
    await refresh();
  } catch (err) {
    console.error("  [error] Refresh failed:", err.message);
    // Serve stale data if available
  }

  const htmlPath = projectPath("scripts", "dashboard.html");
  if (!fs.existsSync(htmlPath)) {
    return res.status(500).send("Dashboard HTML not found. Run the build first.");
  }
  res.sendFile(htmlPath);
});

// GET /api/data — serve dashboard JSON
app.get("/api/data", (req, res) => {
  const jsonPath = projectPath("data", "artifacts", "dashboard-data.json");
  if (!fs.existsSync(jsonPath)) {
    return res.status(404).json({ error: "No dashboard data. Visit / first to trigger refresh." });
  }
  res.sendFile(jsonPath);
});

// GET /api/hot-leads.csv — Wavv-ready CSV download
app.get("/api/hot-leads.csv", (req, res) => {
  const jsonPath = projectPath("data", "artifacts", "dashboard-data.json");
  if (!fs.existsSync(jsonPath)) {
    return res.status(404).send("No data available");
  }

  const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const leads = data.hotLeads || [];

  const header = "company,phone,email,score,reply_preview";
  const rows = leads.map(l => {
    const esc = (s) => `"${(s || "").replace(/"/g, '""')}"`;
    return `${esc(l.company)},${esc(l.phone)},${esc(l.email)},${l.score},${esc(l.replyPreview)}`;
  });

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="hot_leads_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send([header, ...rows].join("\n"));
});

app.listen(PORT, () => {
  console.log(`OMG Outreach Dashboard running at http://localhost:${PORT}`);
  console.log(`Auth: ${USER} / ****`);
});
```

- [ ] **Step 2: Test server starts**

```bash
DASHBOARD_PASS=test node scripts/dashboard-server.js &
sleep 2
curl -s -u admin:test http://localhost:7777/api/data | head -c 200
kill %1
```

Expected: Either JSON output or 404 (if no data yet). Server should start without errors.

- [ ] **Step 3: Commit**

```bash
git add scripts/dashboard-server.js
git commit -m "feat: add Express dashboard server with basic auth"
```

---

### Task 6: Dashboard HTML

**Files:**
- Create: `scripts/dashboard.html`

This is a large self-contained HTML file. Stored in `scripts/` (not `data/`) because `data/` is gitignored.

- [ ] **Step 1: Create the HTML scaffold with header and fetch logic**

Create `scripts/dashboard.html` with the full HTML structure. The file should be self-contained with inline CSS and JS. Key structure:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OMG Outreach Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    /* Dark theme, mobile-first responsive grid */
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #1a1a2e; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 16px; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
    .header h1 { font-size: 1.5rem; color: #fff; }
    .header .meta { color: #888; font-size: 0.85rem; }
    .btn { background: #0f3460; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
    .btn:hover { background: #16213e; }
    .btn-accent { background: #e94560; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 20px; }
    @media (min-width: 768px) { .grid { grid-template-columns: repeat(2, 1fr); } }
    @media (min-width: 1200px) { .grid { grid-template-columns: repeat(3, 1fr); } }
    .card { background: #16213e; border-radius: 12px; padding: 20px; }
    .card-full { grid-column: 1 / -1; }
    .card h2 { font-size: 1.1rem; color: #e94560; margin-bottom: 12px; }
    .stat-row { display: flex; gap: 16px; flex-wrap: wrap; }
    .stat { text-align: center; flex: 1; min-width: 80px; }
    .stat .value { font-size: 1.8rem; font-weight: bold; color: #fff; }
    .stat .label { font-size: 0.75rem; color: #888; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th { text-align: left; padding: 8px; color: #888; border-bottom: 1px solid #2a2a4a; }
    td { padding: 8px; border-bottom: 1px solid #2a2a4a; }
    .good { color: #4ade80; }
    .warn { color: #fbbf24; }
    .bad { color: #f87171; }
    .lead-card { background: #1a1a2e; border-radius: 8px; padding: 14px; margin-bottom: 10px; }
    .lead-card .company { font-weight: bold; color: #fff; }
    .lead-card .phone a { color: #60a5fa; text-decoration: none; }
    .lead-card .preview { color: #aaa; font-size: 0.85rem; margin-top: 6px; font-style: italic; }
    .lead-card .score-badge { display: inline-block; background: #e94560; color: #fff; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: bold; }
    canvas { max-height: 300px; }
    .funnel-bar { display: flex; align-items: center; margin-bottom: 8px; }
    .funnel-bar .label { width: 120px; font-size: 0.85rem; color: #ccc; }
    .funnel-bar .bar { height: 28px; background: #0f3460; border-radius: 4px; display: flex; align-items: center; padding: 0 8px; font-size: 0.8rem; color: #fff; min-width: 40px; transition: width 0.5s; }
    .funnel-bar .rate { margin-left: 8px; font-size: 0.75rem; color: #888; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>OMG Outreach Dashboard</h1>
      <div class="meta">Last refreshed: <span id="refreshed-at">—</span></div>
    </div>
    <div>
      <button class="btn" onclick="loadData()">Refresh</button>
      <button class="btn btn-accent" onclick="exportCsv()">Export Hot Leads CSV</button>
    </div>
  </div>

  <div class="grid">
    <!-- Section 1: Pipeline Funnel -->
    <div class="card card-full">
      <h2>Pipeline Funnel</h2>
      <div id="funnel"></div>
    </div>

    <!-- Section 2: Campaign Performance -->
    <div class="card card-full">
      <h2>Campaign Performance</h2>
      <div style="overflow-x:auto"><table id="campaigns-table"><thead><tr><th>Campaign</th><th>Sent</th><th>Opened</th><th>Replied</th><th>Bounced</th><th>Open %</th><th>Reply %</th><th>Bounce %</th></tr></thead><tbody></tbody></table></div>
    </div>

    <!-- Section 3: Lead Score Distribution -->
    <div class="card">
      <h2>Lead Score Distribution</h2>
      <canvas id="score-chart"></canvas>
      <div class="stat-row" style="margin-top:12px">
        <div class="stat"><div class="value" id="score-mean">—</div><div class="label">Mean</div></div>
        <div class="stat"><div class="value" id="score-median">—</div><div class="label">Median</div></div>
      </div>
    </div>

    <!-- Section 4: Hot Leads -->
    <div class="card">
      <h2>Hot Leads <span id="hot-count" style="color:#888;font-size:0.85rem"></span></h2>
      <div id="hot-leads"></div>
    </div>

    <!-- Section 5: Dead Leads -->
    <div class="card">
      <h2>Dead Leads</h2>
      <div class="stat-row">
        <div class="stat"><div class="value bad" id="dead-bounced">0</div><div class="label">Bounced</div></div>
        <div class="stat"><div class="value warn" id="dead-unsub">0</div><div class="label">Unsubscribed</div></div>
        <div class="stat"><div class="value" id="dead-total">0</div><div class="label">Total Dead</div></div>
      </div>
    </div>

    <!-- Section 6: Cost Metrics -->
    <div class="card">
      <h2>Cost Metrics</h2>
      <table id="cost-table"><thead><tr><th>Stage</th><th>Cost/Lead</th><th>Total</th></tr></thead><tbody></tbody></table>
      <div style="margin-top:12px;text-align:right;font-weight:bold;color:#e94560">
        Total: $<span id="total-spend">0</span>
      </div>
    </div>

    <!-- Section 7: Pipeline Freshness -->
    <div class="card">
      <h2>Pipeline Freshness</h2>
      <table id="freshness-table"><thead><tr><th>Stage</th><th>Unprocessed</th><th>Oldest (days)</th></tr></thead><tbody></tbody></table>
    </div>

    <!-- Section 8: Source Quality — By Source -->
    <div class="card">
      <h2>Source Quality</h2>
      <canvas id="source-chart"></canvas>
    </div>

    <!-- Section 9: Source Quality — By Search Term -->
    <div class="card card-full">
      <h2>Top Search Terms</h2>
      <div style="overflow-x:auto"><table id="source-detail-table"><thead><tr><th>Search Term</th><th>Count</th><th>Avg Score</th><th>Conv %</th></tr></thead><tbody></tbody></table></div>
    </div>
  </div>

  <script>
    let scoreChart = null;
    let sourceChart = null;

    function fmt(n) { return (n || 0).toLocaleString(); }
    function pct(n) { return ((n || 0) * 100).toFixed(1) + "%"; }
    function rateClass(rate, good, bad) { return rate >= good ? "good" : rate <= bad ? "bad" : "warn"; }

    async function loadData() {
      try {
        const res = await fetch("/api/data");
        const data = await res.json();
        render(data);
      } catch (err) {
        console.error("Failed to load data:", err);
      }
    }

    function exportCsv() {
      window.location.href = "/api/hot-leads.csv";
    }

    function render(d) {
      // Timestamp
      document.getElementById("refreshed-at").textContent = new Date(d.generatedAt).toLocaleString();

      // Funnel
      const funnelEl = document.getElementById("funnel");
      const maxCount = Math.max(...d.funnel.stages.map(s => s.count), 1);
      funnelEl.innerHTML = d.funnel.stages.map(s => {
        const width = Math.max((s.count / maxCount) * 100, 5);
        const rate = s.conversionRate !== null ? `${pct(s.conversionRate)}` : "";
        return `<div class="funnel-bar"><span class="label">${s.name}</span><div class="bar" style="width:${width}%">${fmt(s.count)}</div><span class="rate">${rate}</span></div>`;
      }).join("");

      // Campaigns
      const tbody = document.querySelector("#campaigns-table tbody");
      tbody.innerHTML = d.campaigns.map(c => `<tr>
        <td>${c.name}</td><td>${fmt(c.sent)}</td><td>${fmt(c.opened)}</td><td>${fmt(c.replied)}</td><td>${fmt(c.bounced)}</td>
        <td class="${rateClass(c.openRate, 0.20, 0.10)}">${pct(c.openRate)}</td>
        <td class="${rateClass(c.replyRate, 0.01, 0.003)}">${pct(c.replyRate)}</td>
        <td class="${rateClass(1 - c.bounceRate, 0.95, 0.90)}">${pct(c.bounceRate)}</td>
      </tr>`).join("");

      // Score Distribution
      if (scoreChart) scoreChart.destroy();
      const ctx = document.getElementById("score-chart").getContext("2d");
      scoreChart = new Chart(ctx, {
        type: "bar",
        data: {
          labels: d.scoreDistribution.buckets.map(b => b.range),
          datasets: [{ label: "Leads", data: d.scoreDistribution.buckets.map(b => b.count), backgroundColor: "#0f3460", borderRadius: 4 }],
        },
        options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { color: "#888" } }, x: { ticks: { color: "#888" } } } },
      });
      document.getElementById("score-mean").textContent = d.scoreDistribution.mean;
      document.getElementById("score-median").textContent = d.scoreDistribution.median;

      // Hot Leads
      const hotEl = document.getElementById("hot-leads");
      document.getElementById("hot-count").textContent = d.hotLeads.length > 0 ? `(${d.hotLeads.length})` : "";
      if (d.hotLeads.length === 0) {
        hotEl.innerHTML = '<div style="color:#888;padding:20px;text-align:center">No new replies since last sync</div>';
      } else {
        hotEl.innerHTML = d.hotLeads.map(l => `<div class="lead-card">
          <div class="company">${l.company || "Unknown"} <span class="score-badge">${l.score}</span></div>
          <div class="phone"><a href="tel:${l.phone}">${l.phone || "No phone"}</a> &middot; ${l.email}</div>
          <div class="preview">"${l.replyPreview}"</div>
        </div>`).join("");
      }

      // Dead Leads
      document.getElementById("dead-bounced").textContent = fmt(d.deadLeads.bounced);
      document.getElementById("dead-unsub").textContent = fmt(d.deadLeads.unsubscribed);
      document.getElementById("dead-total").textContent = fmt(d.deadLeads.total);

      // Cost Metrics
      const costBody = document.querySelector("#cost-table tbody");
      costBody.innerHTML = d.costs.perStage.map(c => `<tr><td>${c.stage}</td><td>$${c.costPerLead.toFixed(4)}</td><td>$${c.totalCost.toFixed(2)}</td></tr>`).join("");
      document.getElementById("total-spend").textContent = d.costs.totalSpend.toFixed(2);

      // Freshness
      const freshBody = document.querySelector("#freshness-table tbody");
      freshBody.innerHTML = d.freshness.stages.map(s => {
        const cls = s.unprocessedCount > 500 ? "bad" : s.unprocessedCount > 100 ? "warn" : "good";
        const dayCls = s.oldestDays > 7 ? "bad" : s.oldestDays > 3 ? "warn" : "good";
        return `<tr><td>${s.name}</td><td class="${cls}">${fmt(s.unprocessedCount)}</td><td class="${dayCls}">${s.oldestDays}d</td></tr>`;
      }).join("");

      // Source Quality — Bar Chart
      if (sourceChart) sourceChart.destroy();
      if (d.sourceQuality.bySource.length > 0) {
        const sCtx = document.getElementById("source-chart").getContext("2d");
        sourceChart = new Chart(sCtx, {
          type: "bar",
          data: {
            labels: d.sourceQuality.bySource.map(s => s.source),
            datasets: [
              { label: "Avg Score", data: d.sourceQuality.bySource.map(s => s.avgScore), backgroundColor: "#0f3460", borderRadius: 4 },
              { label: "Conv %", data: d.sourceQuality.bySource.map(s => +(s.conversionRate * 100).toFixed(1)), backgroundColor: "#e94560", borderRadius: 4 },
            ],
          },
          options: { responsive: true, scales: { y: { beginAtZero: true, ticks: { color: "#888" } }, x: { ticks: { color: "#888" } } }, plugins: { legend: { labels: { color: "#ccc" } } } },
        });
      }

      // Source Quality — Detail Table
      const detailBody = document.querySelector("#source-detail-table tbody");
      const top20 = d.sourceQuality.byDetail.slice(0, 20);
      detailBody.innerHTML = top20.map((s, i) => {
        const highlight = i < 5 ? ' style="background:#1e2d4a"' : "";
        return `<tr${highlight}><td>${s.searchTerm}</td><td>${fmt(s.count)}</td><td>${s.avgScore}</td><td>${pct(s.conversionRate)}</td></tr>`;
      }).join("");
    }

    // Load on page ready
    loadData();
  </script>
</body>
</html>
```

- [ ] **Step 2: Test dashboard loads in browser**

```bash
DASHBOARD_PASS=test node scripts/dashboard-server.js &
sleep 2
curl -s -u admin:test -o /dev/null -w "%{http_code}" http://localhost:7777/
kill %1
```

Expected: HTTP 200.

- [ ] **Step 3: Commit**

```bash
git add scripts/dashboard.html
git commit -m "feat: add self-contained Chart.js dashboard HTML"
```

---

### Task 7: Daily Email Summary

**Files:**
- Create: `scripts/daily-email.js`

- [ ] **Step 1: Create daily-email.js**

```javascript
/**
 * Daily Email Summary
 *
 * Sends a mobile-friendly HTML email briefing from dashboard-data.json.
 * Uses Nodemailer with Gmail SMTP (app password).
 *
 * Usage:
 *   node scripts/daily-email.js --test    # send test email to yourself
 *   Programmatic: const { sendDailyEmail } = require('./daily-email'); await sendDailyEmail(data);
 *
 * Env: GMAIL_USER, GMAIL_APP_PASSWORD, BRYCE_EMAIL (optional), VPS_URL
 */

const nodemailer = require("nodemailer");
const path = require("path");
const { loadJson } = require("../shared/progress");
const { projectPath } = require("../shared/utils");

function buildSubject(data) {
  const replies = (data.hotLeads || []).length;
  const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const inCampaign = data.funnel?.stages?.find(s => s.name === "in_campaign")?.count || 0;
  return `OMG Outreach Daily — ${date} | ${replies} replies, ${inCampaign.toLocaleString()} in campaign`;
}

function fmt(n) { return (n || 0).toLocaleString(); }
function pct(n) { return ((n || 0) * 100).toFixed(1) + "%"; }

function buildHtml(data) {
  const vpsUrl = process.env.VPS_URL || "http://localhost:7777";

  // Pipeline snapshot
  const pipeline = (data.funnel?.stages || [])
    .map(s => `<strong>${s.name}:</strong> ${fmt(s.count)}`)
    .join(" → ");

  // Campaign table rows
  const campaignRows = (data.campaigns || []).map(c =>
    `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${c.name}</td>
     <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center">${fmt(c.sent)}</td>
     <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center">${fmt(c.opened)}</td>
     <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center">${fmt(c.replied)}</td>
     <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center">${fmt(c.bounced)}</td></tr>`
  ).join("");

  // Hot leads
  let hotSection = '<p style="color:#888">No new replies today.</p>';
  if (data.hotLeads && data.hotLeads.length > 0) {
    hotSection = data.hotLeads.map(l =>
      `<div style="background:#f8f9fa;border-radius:8px;padding:12px;margin-bottom:10px;border-left:4px solid #e94560">
        <div style="font-weight:bold;color:#1a1a2e">${l.company || "Unknown"} <span style="background:#e94560;color:#fff;padding:2px 6px;border-radius:10px;font-size:12px">${l.score}</span></div>
        <div><a href="tel:${l.phone}" style="color:#2563eb">${l.phone || "No phone"}</a> · ${l.email}</div>
        <div style="color:#666;font-style:italic;margin-top:4px;font-size:14px">"${(l.replyPreview || "").slice(0, 150)}"</div>
      </div>`
    ).join("");
  }

  // Action items
  const actions = [];
  if (data.hotLeads?.length > 0) {
    actions.push(`${data.hotLeads.length} hot lead${data.hotLeads.length > 1 ? "s" : ""} ready for Wavv import`);
  }
  const staleStages = (data.freshness?.stages || []).filter(s => s.unprocessedCount > 100 && s.oldestDays > 3);
  for (const s of staleStages) {
    actions.push(`${fmt(s.unprocessedCount)} leads sitting unprocessed in ${s.name} for ${s.oldestDays}+ days`);
  }
  if (actions.length === 0) {
    actions.push("Pipeline healthy, no action needed");
  }
  const actionHtml = actions.map(a => `<li style="margin-bottom:4px">${a}</li>`).join("");

  // Score distribution change (simplified — just show current)
  const scoreLine = data.scoreDistribution?.mean
    ? `<p style="color:#666;font-size:14px">Mean score: <strong>${data.scoreDistribution.mean}</strong> · Median: <strong>${data.scoreDistribution.median}</strong></p>`
    : "";

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden">

  <!-- Header -->
  <div style="background:#1a1a2e;color:#fff;padding:20px 24px">
    <h1 style="margin:0;font-size:20px">OMG Outreach Daily</h1>
    <p style="margin:4px 0 0;color:#aaa;font-size:14px">${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</p>
  </div>

  <div style="padding:20px 24px">

    <!-- Pipeline Snapshot -->
    <h2 style="font-size:16px;color:#1a1a2e;margin:0 0 8px;border-bottom:2px solid #e94560;padding-bottom:4px">Pipeline Snapshot</h2>
    <p style="font-size:14px;line-height:1.6">${pipeline}</p>

    <!-- Campaign Performance -->
    <h2 style="font-size:16px;color:#1a1a2e;margin:20px 0 8px;border-bottom:2px solid #e94560;padding-bottom:4px">Campaign Performance</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#f8f9fa">
        <th style="padding:6px 10px;text-align:left">Campaign</th>
        <th style="padding:6px 10px;text-align:center">Sent</th>
        <th style="padding:6px 10px;text-align:center">Opened</th>
        <th style="padding:6px 10px;text-align:center">Replied</th>
        <th style="padding:6px 10px;text-align:center">Bounced</th>
      </tr></thead>
      <tbody>${campaignRows}</tbody>
    </table>

    <!-- Hot Leads -->
    <h2 style="font-size:16px;color:#1a1a2e;margin:20px 0 8px;border-bottom:2px solid #e94560;padding-bottom:4px">Hot Leads for Bryce</h2>
    ${hotSection}

    <!-- Score Distribution -->
    ${scoreLine ? `<h2 style="font-size:16px;color:#1a1a2e;margin:20px 0 8px;border-bottom:2px solid #e94560;padding-bottom:4px">Score Distribution</h2>${scoreLine}` : ""}

    <!-- Action Items -->
    <h2 style="font-size:16px;color:#1a1a2e;margin:20px 0 8px;border-bottom:2px solid #e94560;padding-bottom:4px">Action Items</h2>
    <ul style="margin:0;padding-left:20px;font-size:14px">${actionHtml}</ul>

  </div>

  <!-- Footer -->
  <div style="background:#f8f9fa;padding:16px 24px;text-align:center;font-size:13px;color:#888">
    <a href="${vpsUrl}" style="color:#2563eb;text-decoration:none">View Full Dashboard →</a>
  </div>

</div>
</body>
</html>`;
}

async function sendDailyEmail(data) {
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;

  if (!gmailUser || !gmailPass) {
    console.warn("  [warn] GMAIL_USER and GMAIL_APP_PASSWORD required for email. Skipping.");
    return;
  }

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: { user: gmailUser, pass: gmailPass },
  });

  const subject = buildSubject(data);
  const html = buildHtml(data);

  const mailOptions = {
    from: gmailUser,
    to: gmailUser,
    subject,
    html,
  };

  // CC Bryce only when there are hot leads
  const bryceEmail = process.env.BRYCE_EMAIL;
  if (bryceEmail && data.hotLeads && data.hotLeads.length > 0) {
    mailOptions.cc = bryceEmail;
  }

  const info = await transporter.sendMail(mailOptions);
  console.log(`  [ok] Daily email sent: ${info.messageId}`);
  if (mailOptions.cc) {
    console.log(`  [ok] CC'd ${bryceEmail} (${data.hotLeads.length} hot leads)`);
  }
  return info;
}

module.exports = { sendDailyEmail, buildSubject, buildHtml };

// CLI entry point
if (require.main === module) {
  const isTest = process.argv.includes("--test");

  (async () => {
    // Load dashboard data
    const jsonPath = projectPath("data", "artifacts", "dashboard-data.json");
    let data = loadJson(jsonPath);

    if (!data) {
      console.log("No dashboard data found. Running refresh first...");
      const { refresh } = require("./refresh-dashboard");
      data = await refresh();
    }

    if (isTest) {
      console.log("Sending test email...");
      // Force no CC for test
      delete process.env.BRYCE_EMAIL;
    }

    await sendDailyEmail(data);
  })().catch(err => {
    console.error("Email failed:", err.message);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Test email builds without sending**

```bash
node -e "
  const { buildSubject, buildHtml } = require('./scripts/daily-email');
  const data = { funnel: { stages: [{ name: 'raw', count: 17901 }] }, hotLeads: [{ company: 'Test', phone: '555', email: 'a@b.com', replyPreview: 'Hi', score: 90 }], campaigns: [], scoreDistribution: { mean: 42, median: 38, buckets: [] }, deadLeads: { bounced: 0, unsubscribed: 0, total: 0 }, costs: { perStage: [], totalSpend: 0 }, freshness: { stages: [] }, sourceQuality: { bySource: [], byDetail: [] } };
  console.log('Subject:', buildSubject(data));
  console.log('HTML length:', buildHtml(data).length);
"
```

Expected: Subject line printed, HTML length > 1000.

- [ ] **Step 3: Commit**

```bash
git add scripts/daily-email.js
git commit -m "feat: add daily email summary via Nodemailer Gmail SMTP"
```

---

### Task 8: Daily Sync Integration

**Files:**
- Modify: `scripts/daily-sync.js`

- [ ] **Step 1: Read current daily-sync.js to identify exact insertion point**

Read `scripts/daily-sync.js` to find the end of the existing workflow.

- [ ] **Step 2: Add refresh and email steps to daily-sync.js**

After the existing GHL push step (or at the end of the main function), add:

```javascript
// Step 3: Refresh dashboard data
// IMPORTANT: Pass lastSyncAt from the sync report's generated_at timestamp.
// The sync checkpoint has already been updated by this point, so we can't read it.
// The report.generated_at captures when the sync started (before checkpoint update).
console.log("\n--- Step 3: Refresh dashboard data ---");
try {
  const { refresh } = require("./refresh-dashboard");
  const dashboardData = await refresh({ lastSyncAt: report?.generated_at });

  // Step 4: Send daily email
  console.log("\n--- Step 4: Send daily email ---");
  try {
    const { sendDailyEmail } = require("./daily-email");
    await sendDailyEmail(dashboardData);
  } catch (emailErr) {
    console.error("  [warn] Daily email failed (non-fatal):", emailErr.message);
  }
} catch (refreshErr) {
  console.error("  [warn] Dashboard refresh failed (non-fatal):", refreshErr.message);
}
```

Note: `report` comes from the `sync.main()` return value in Step 1 (`const { report, hotLeads } = await sync.main()`). Its `generated_at` field is the timestamp when the sync began, which is the correct baseline for determining "new" replies.

- [ ] **Step 3: Remove old dashboard update call if present**

Search `daily-sync.js` for any reference to `update-dashboards` and remove it. Keep the script file itself — just stop calling it.

- [ ] **Step 4: Test daily-sync runs end to end**

```bash
node scripts/daily-sync.js --dry-run
```

Expected: Steps 1-4 print without errors. Email step may warn about missing GMAIL_USER (that's fine in dry-run).

- [ ] **Step 5: Commit**

```bash
git add scripts/daily-sync.js
git commit -m "feat: integrate dashboard refresh + daily email into daily-sync"
```

---

### Task 9: Final Integration Test and VPS Setup

**Files:** None new — testing existing files.

- [ ] **Step 1: Run the full data refresh**

```bash
node scripts/refresh-dashboard.js
```

Verify `data/artifacts/dashboard-data.json` is created and has all sections populated.

- [ ] **Step 2: Start the dashboard server and verify all routes**

```bash
DASHBOARD_PASS=test node scripts/dashboard-server.js &
sleep 2

# Test main page
curl -s -u admin:test -o /dev/null -w "GET /: %{http_code}\n" http://localhost:7777/

# Test API data
curl -s -u admin:test http://localhost:7777/api/data | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log('Sections:', Object.keys(d).join(', '))"

# Test CSV export
curl -s -u admin:test http://localhost:7777/api/hot-leads.csv | head -3

# Test auth rejection
curl -s -o /dev/null -w "No auth: %{http_code}\n" http://localhost:7777/

kill %1
```

Expected: 200 for authenticated routes, 401 for unauthenticated. JSON has all sections. CSV has header row.

- [ ] **Step 3: Send test email**

```bash
node scripts/daily-email.js --test
```

Expected: Email received in Gmail inbox with correct formatting.

- [ ] **Step 4: Add dashboard startup instructions**

Add to `package.json` scripts (if not already done in Task 1):

```json
"dashboard": "node scripts/dashboard-server.js"
```

- [ ] **Step 5: Set up persistent service on VPS**

Install pm2 globally if not present, then start:

```bash
npm install -g pm2
pm2 start scripts/dashboard-server.js --name outreach-dashboard
pm2 save
pm2 startup
```

This ensures the dashboard server restarts on VPS reboot.

- [ ] **Step 6: Run all tests**

```bash
npx vitest run
```

Expected: All tests pass.

- [ ] **Step 7: Final commit**

```bash
git add package.json scripts/dashboard-server.js scripts/refresh-dashboard.js scripts/dashboard.html scripts/daily-email.js scripts/daily-sync.js tests/refresh-dashboard.test.js .env.example
git commit -m "chore: finalize dashboard and email integration"
```
