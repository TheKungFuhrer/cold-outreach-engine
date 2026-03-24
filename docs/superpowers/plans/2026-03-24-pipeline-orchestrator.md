# Pipeline Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing `pipeline.js` with a config-driven orchestrator that tracks per-lead state via the master CSV, supports async two-phase batch classification, and provides `run`/`status` CLI commands.

**Architecture:** A monolithic orchestrator (`pipeline.js`) reads a JSON config (`pipeline-config.json`), rebuilds the master CSV at run start via `shared/master.js`, then executes steps in order — querying the master for eligible leads before each step and promoting their `pipeline_stage` after. Async steps (batch classification) use two-phase submit/resume via `run_state.json`.

**Tech Stack:** Node.js, vitest, csv-parse/csv-stringify, child_process.spawn

**Spec:** `docs/superpowers/specs/2026-03-24-pipeline-orchestrator-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `shared/master.js` | New — master CSV load/save/query/promote logic extracted from `build-master.js` |
| `shared/master.test.js` | New — tests for master.js |
| `scripts/build-master.js` | Modified — imports merge/stage logic from `shared/master.js`, keeps CLI + ingestors + GHL exports |
| `scripts/build-master.test.js` | Modified — update imports from `./build-master` to `../shared/master` for moved exports |
| `pipeline-config.json` | New — ordered step list with timeouts, stages, sidecar |
| `pipeline.js` | Rewrite — orchestrator with run/status commands |
| `pipeline.test.js` | New — tests for orchestrator logic |

---

### Task 1: Extract shared/master.js from build-master.js

**Files:**
- Create: `shared/master.js`
- Create: `shared/master.test.js`
- Modify: `scripts/build-master.js:42-96` (remove moved code, add imports)
- Modify: `scripts/build-master.test.js:1-119` (update import paths)

- [ ] **Step 1: Write failing tests for shared/master.js**

Create `shared/master.test.js` with tests for the core functions that will be extracted:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const {
  STAGE_RANK,
  MASTER_COLUMNS,
  COMPANY_FIELDS,
  createMergeMap,
  mergeIntoMap,
  queryByStage,
  promoteLeads,
} = require("./master");

describe("STAGE_RANK", () => {
  it("has correct ordering with exported stage", () => {
    expect(STAGE_RANK.raw).toBe(0);
    expect(STAGE_RANK.filtered).toBe(1);
    expect(STAGE_RANK.classified).toBe(2);
    expect(STAGE_RANK.validated).toBe(3);
    expect(STAGE_RANK.exported).toBe(4);
    expect(STAGE_RANK.uploaded).toBe(5);
    expect(STAGE_RANK.in_campaign).toBe(6);
  });

  it("does not include enriched", () => {
    expect(STAGE_RANK.enriched).toBeUndefined();
  });
});

describe("queryByStage", () => {
  it("returns only records at the specified stage", () => {
    const map = createMergeMap();
    mergeIntoMap(map, { domain: "a.com", email: "a@a.com", pipeline_stage: "raw" });
    mergeIntoMap(map, { domain: "b.com", email: "b@b.com", pipeline_stage: "filtered" });
    mergeIntoMap(map, { domain: "c.com", email: "c@c.com", pipeline_stage: "raw" });

    const results = queryByStage(map, "raw");
    expect(results.length).toBe(2);
    expect(results.map(r => r.domain).sort()).toEqual(["a.com", "c.com"]);
  });

  it("returns empty array when no records match", () => {
    const map = createMergeMap();
    mergeIntoMap(map, { domain: "a.com", email: "a@a.com", pipeline_stage: "raw" });
    expect(queryByStage(map, "classified")).toEqual([]);
  });
});

describe("promoteLeads", () => {
  it("promotes leads to a higher stage", () => {
    const map = createMergeMap();
    mergeIntoMap(map, { domain: "a.com", email: "a@a.com", pipeline_stage: "filtered" });

    const leads = [{ domain: "a.com", email: "a@a.com" }];
    const promoted = promoteLeads(map, leads, "classified");

    expect(promoted).toBe(1);
    expect(map.get("a.com").get("a@a.com").pipeline_stage).toBe("classified");
    expect(map.get("a.com").get("a@a.com").last_updated).toBeTruthy();
  });

  it("does not demote leads to a lower stage", () => {
    const map = createMergeMap();
    mergeIntoMap(map, { domain: "a.com", email: "a@a.com", pipeline_stage: "validated" });

    const leads = [{ domain: "a.com", email: "a@a.com" }];
    const promoted = promoteLeads(map, leads, "classified");

    expect(promoted).toBe(0);
    expect(map.get("a.com").get("a@a.com").pipeline_stage).toBe("validated");
  });

  it("skips leads not found in the map", () => {
    const map = createMergeMap();
    const leads = [{ domain: "missing.com", email: "x@missing.com" }];
    const promoted = promoteLeads(map, leads, "classified");
    expect(promoted).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run shared/master.test.js`
Expected: FAIL — `Cannot find module './master'`

- [ ] **Step 3: Create shared/master.js with extracted logic**

Create `shared/master.js` containing the constants, merge functions, and new query/promote functions:

```js
/**
 * Master CSV state management — load, query, promote, save.
 * Extracted from scripts/build-master.js for shared use by the pipeline orchestrator.
 */

const fs = require("fs");
const path = require("path");
const csv = require("./csv");
const { projectPath } = require("./utils");

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

const COMPANY_FIELDS = [
  "company_name", "phone", "phone_type", "phone_carrier", "website",
  "location_raw", "city", "state", "zip", "is_venue", "confidence",
  "classification_reasoning", "source", "source_detail",
];

const STAGE_RANK = {
  raw: 0, filtered: 1, classified: 2, validated: 3,
  exported: 4, uploaded: 5, in_campaign: 6,
};

const MASTER_CSV_PATH = projectPath("data", "master", "leads_master.csv");

// ---------------------------------------------------------------------------
// Merge map — Map<domain, Map<email, record>>
// ---------------------------------------------------------------------------

function createMergeMap() {
  return new Map();
}

function stripEmpty(obj) {
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== "") result[k] = v;
  }
  return result;
}

function mergeIntoMap(map, record, forceFields = []) {
  const domain = record.domain;
  const email = record.email;
  if (!domain && !email) return;

  const key = domain || email;
  if (!map.has(key)) map.set(key, new Map());
  const domainMap = map.get(key);

  if (!domainMap.has(email)) {
    const inherited = {};
    if (domainMap.size > 0) {
      const firstRecord = domainMap.values().next().value;
      for (const field of COMPANY_FIELDS) {
        if (firstRecord[field]) inherited[field] = firstRecord[field];
      }
    }
    domainMap.set(email, { ...inherited, ...stripEmpty(record) });
  } else {
    const existing = domainMap.get(email);
    for (const [k, v] of Object.entries(record)) {
      if (v && (!existing[k] || forceFields.includes(k))) existing[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// Master CSV I/O
// ---------------------------------------------------------------------------

function loadMaster() {
  const { records } = csv.readCsv(MASTER_CSV_PATH);
  const map = createMergeMap();
  for (const record of records) {
    mergeIntoMap(map, record);
  }
  return map;
}

function saveMaster(map) {
  const flat = [];
  for (const [domain, emailMap] of map) {
    for (const [email, record] of emailMap) {
      const out = {};
      for (const col of MASTER_COLUMNS) {
        out[col] = record[col] || "";
      }
      flat.push(out);
    }
  }
  flat.sort((a, b) => (a.domain || "").localeCompare(b.domain || "") || (a.email || "").localeCompare(b.email || ""));
  csv.writeCsv(MASTER_CSV_PATH, flat, MASTER_COLUMNS);
  return MASTER_CSV_PATH;
}

// ---------------------------------------------------------------------------
// Query & Promote
// ---------------------------------------------------------------------------

function queryByStage(map, stage) {
  const results = [];
  for (const [domain, emailMap] of map) {
    for (const [email, record] of emailMap) {
      if (record.pipeline_stage === stage) {
        results.push({ ...record, domain, email });
      }
    }
  }
  return results;
}

function promoteLeads(map, leads, newStage) {
  const newRank = STAGE_RANK[newStage];
  if (newRank === undefined) return 0;
  const now = new Date().toISOString();
  let promoted = 0;

  for (const lead of leads) {
    const key = lead.domain || lead.email;
    if (!map.has(key)) continue;
    const domainMap = map.get(key);
    if (!domainMap.has(lead.email)) continue;

    const record = domainMap.get(lead.email);
    const currentRank = STAGE_RANK[record.pipeline_stage] || 0;
    if (newRank > currentRank) {
      record.pipeline_stage = newStage;
      record.last_updated = now;
      promoted++;
    }
  }
  return promoted;
}

module.exports = {
  MASTER_COLUMNS,
  COMPANY_FIELDS,
  STAGE_RANK,
  MASTER_CSV_PATH,
  createMergeMap,
  mergeIntoMap,
  stripEmpty,
  loadMaster,
  saveMaster,
  queryByStage,
  promoteLeads,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run shared/master.test.js`
Expected: PASS — all 7 tests pass

- [ ] **Step 5: Commit**

```bash
git add shared/master.js shared/master.test.js
git commit -m "feat: extract shared/master.js with query and promote functions"
```

---

### Task 2: Refactor build-master.js to import from shared/master.js

**Files:**
- Modify: `scripts/build-master.js:15-96` (replace constants + merge functions with imports)
- Modify: `scripts/build-master.test.js:1-3,106-119` (update import paths for moved exports)

- [ ] **Step 1: Update build-master.js imports**

Replace lines 15-96 of `scripts/build-master.js` with imports from `shared/master.js`. Remove the local definitions of `MASTER_COLUMNS`, `COMPANY_FIELDS`, `STAGE_RANK`, `createMergeMap`, `mergeIntoMap`, `stripEmpty`. Keep all ingestors, `computePipelineStage`, `enrichRecords`, GHL exports, and CLI logic.

Replace lines 15-21:
```js
const fs = require("fs");
const path = require("path");
const csv = require("../shared/csv");
const { readCsv } = csv;
const { normalizeRow, resolveField, parseLocationFull, parseName } = require("../shared/fields");
const { normalizeDomain } = require("../shared/dedup");
const { projectPath } = require("../shared/utils");
```

With:
```js
const fs = require("fs");
const path = require("path");
const csv = require("../shared/csv");
const { readCsv } = csv;
const { normalizeRow, resolveField, parseLocationFull, parseName } = require("../shared/fields");
const { normalizeDomain } = require("../shared/dedup");
const { projectPath } = require("../shared/utils");
const {
  MASTER_COLUMNS,
  COMPANY_FIELDS,
  STAGE_RANK,
  createMergeMap,
  mergeIntoMap,
  stripEmpty,
} = require("../shared/master");
```

Delete lines 23-96 (the local `MASTER_COLUMNS`, `COMPANY_FIELDS`, `STAGE_RANK`, `createMergeMap`, `mergeIntoMap`, `stripEmpty` definitions — these now come from shared/master.js).

Update line 459 `writeMasterCsv` to use the shared path constant:

```js
const { MASTER_CSV_PATH } = require("../shared/master");
```

And change `writeMasterCsv` to use `MASTER_CSV_PATH` instead of computing it locally:

```js
function writeMasterCsv(records) {
  const rows = records.map(r => {
    const out = {};
    for (const col of MASTER_COLUMNS) {
      out[col] = r[col] || "";
    }
    return out;
  });
  csv.writeCsv(MASTER_CSV_PATH, rows, MASTER_COLUMNS);
  return MASTER_CSV_PATH;
}
```

Update the `module.exports` at line 674 to re-export from shared/master:

```js
module.exports = {
  // Re-exported from shared/master.js
  createMergeMap,
  mergeIntoMap,
  MASTER_COLUMNS,
  STAGE_RANK,
  // Local to build-master.js
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
};
```

- [ ] **Step 2: Update build-master.test.js imports**

The test file imports `STAGE_RANK`, `createMergeMap`, `mergeIntoMap` from `./build-master`. Since `build-master.js` re-exports these, the existing imports on lines 106-119 continue to work. No changes needed to the test imports.

However, update the `computePipelineStage` test on line 130-131 to account for the removed `enriched` stage. The `enriched` stage is removed from `STAGE_RANK` so the test "returns enriched for anymailfinder emails" still tests `computePipelineStage` output (which still returns `"enriched"` — the function is in `build-master.js` and doesn't use `STAGE_RANK`). Leave this test as-is since `computePipelineStage` still returns `"enriched"` for backward compatibility with the rebuild logic.

- [ ] **Step 3: Run all tests**

Run: `npx vitest run`
Expected: All tests pass — both `shared/master.test.js` and `scripts/build-master.test.js`

- [ ] **Step 4: Commit**

```bash
git add scripts/build-master.js scripts/build-master.test.js
git commit -m "refactor: build-master.js imports constants and merge logic from shared/master.js"
```

---

### Task 3: Create pipeline-config.json

**Files:**
- Create: `pipeline-config.json`

- [ ] **Step 1: Create pipeline-config.json**

```json
{
  "steps": [
    {
      "name": "prefilter",
      "script": "node 2-enrichment/prefilter.js",
      "inputStage": "raw",
      "outputStage": "filtered",
      "inputFlag": "--input",
      "outputPath": "data/filtered/leads.csv",
      "timeout": 300000
    },
    {
      "name": "classify",
      "script": "python 2-enrichment/classify_batch.py",
      "inputStage": "filtered",
      "outputStage": "classified",
      "inputFlag": "--input",
      "outputPath": "data/classified/venues.csv",
      "async": true,
      "timeout": 600000,
      "sidecar": {
        "name": "escalate",
        "script": "python 2-enrichment/escalate_sonnet.py",
        "inputSource": "data/classified/ambiguous.csv",
        "outputStage": "classified",
        "inputFlag": "--input",
        "outputPath": "data/verified/venues.csv",
        "timeout": 600000
      }
    },
    {
      "name": "validate_phones",
      "script": "python 2-enrichment/validate_phones.py",
      "inputStage": "classified",
      "outputStage": "validated",
      "inputFlag": "--input",
      "outputPath": "data/phone_validated/mobile.csv",
      "timeout": 7200000
    },
    {
      "name": "export",
      "script": "node 2-enrichment/export_clean.js",
      "inputStage": "validated",
      "outputStage": "exported",
      "outputPath": "data/final/",
      "timeout": 300000
    },
    {
      "name": "upload",
      "script": "node 3-outreach/upload_leads.js",
      "inputStage": "exported",
      "outputStage": "uploaded",
      "inputFlag": "--input",
      "outputPath": null,
      "requiresCampaign": true,
      "timeout": 1800000
    },
    {
      "name": "verify",
      "script": "node 3-outreach/verify_emails.js",
      "inputStage": "uploaded",
      "outputStage": "uploaded",
      "requiresCampaign": true,
      "timeout": 600000
    },
    {
      "name": "assign",
      "script": "node 3-outreach/assign_campaigns.js",
      "inputStage": "uploaded",
      "outputStage": "uploaded",
      "requiresCampaign": true,
      "timeout": 600000
    },
    {
      "name": "dashboards",
      "script": "node scripts/update-dashboards.js",
      "inputStage": null,
      "outputStage": null,
      "timeout": 120000
    }
  ],
  "campaignSteps": ["upload", "verify", "assign"],
  "retries": { "default": 2, "delay": 5000 }
}
```

- [ ] **Step 2: Commit**

```bash
git add pipeline-config.json
git commit -m "feat: add pipeline-config.json with ordered step definitions"
```

---

### Task 4: Write pipeline.js orchestrator — CLI parsing and config loading

**Files:**
- Create: `pipeline.test.js`
- Rewrite: `pipeline.js`

- [ ] **Step 1: Write failing tests for CLI parsing and step filtering**

Create `pipeline.test.js`:

```js
import { describe, it, expect } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const { parseArgs, getActiveSteps, loadConfig } = require("./pipeline");

describe("loadConfig", () => {
  it("loads pipeline-config.json and returns steps array", () => {
    const config = loadConfig();
    expect(Array.isArray(config.steps)).toBe(true);
    expect(config.steps.length).toBeGreaterThan(0);
    expect(config.steps[0].name).toBe("prefilter");
  });

  it("has retries config", () => {
    const config = loadConfig();
    expect(config.retries.default).toBe(2);
    expect(config.retries.delay).toBe(5000);
  });
});

describe("parseArgs", () => {
  it("parses --from flag", () => {
    const opts = parseArgs(["run", "--from", "classify"]);
    expect(opts.from).toBe("classify");
  });

  it("parses --to flag", () => {
    const opts = parseArgs(["run", "--to", "export"]);
    expect(opts.to).toBe("export");
  });

  it("parses --skip flag", () => {
    const opts = parseArgs(["run", "--skip", "escalate,dashboards"]);
    expect(opts.skip).toEqual(["escalate", "dashboards"]);
  });

  it("parses --campaign-id", () => {
    const opts = parseArgs(["run", "--campaign-id", "3071191"]);
    expect(opts.campaignId).toBe("3071191");
  });

  it("parses --dry-run", () => {
    const opts = parseArgs(["run", "--dry-run"]);
    expect(opts.dryRun).toBe(true);
  });

  it("detects status command", () => {
    const opts = parseArgs(["status"]);
    expect(opts.command).toBe("status");
  });

  it("defaults to run command", () => {
    const opts = parseArgs(["run"]);
    expect(opts.command).toBe("run");
  });
});

describe("getActiveSteps", () => {
  const steps = [
    { name: "prefilter" },
    { name: "classify", sidecar: { name: "escalate" } },
    { name: "validate_phones" },
    { name: "export" },
    { name: "upload" },
  ];

  it("returns all steps when no filters", () => {
    const result = getActiveSteps(steps, {});
    expect(result.map(s => s.name)).toEqual(
      ["prefilter", "classify", "validate_phones", "export", "upload"]
    );
  });

  it("filters with --from", () => {
    const result = getActiveSteps(steps, { from: "classify" });
    expect(result[0].name).toBe("classify");
    expect(result.length).toBe(4);
  });

  it("filters with --to", () => {
    const result = getActiveSteps(steps, { to: "validate_phones" });
    expect(result.length).toBe(3);
    expect(result[result.length - 1].name).toBe("validate_phones");
  });

  it("filters with --skip", () => {
    const result = getActiveSteps(steps, { skip: ["export"] });
    expect(result.map(s => s.name)).not.toContain("export");
  });

  it("skip removes sidecars by name", () => {
    const result = getActiveSteps(steps, { skip: ["escalate"] });
    const classifyStep = result.find(s => s.name === "classify");
    expect(classifyStep._skipSidecar).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run pipeline.test.js`
Expected: FAIL — `Cannot find module './pipeline'` or missing exports

- [ ] **Step 3: Write pipeline.js with CLI parsing and config loading**

Rewrite `pipeline.js` with the exported functions. Start with just the CLI parsing, config loading, and step filtering — no execution logic yet:

```js
#!/usr/bin/env node
/**
 * Pipeline orchestrator — config-driven step execution with per-lead state tracking.
 *
 * Usage:
 *   node pipeline.js run                          # full pipeline
 *   node pipeline.js run --from=classify          # start from step
 *   node pipeline.js run --to=validate_phones     # stop after step
 *   node pipeline.js run --skip=escalate          # skip step/sidecar
 *   node pipeline.js run --campaign-id=3071191    # enable campaign steps
 *   node pipeline.js run --dry-run                # show plan only
 *   node pipeline.js status                       # show leads per stage
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { projectPath, ensureDir, timestamp } = require("./shared/utils");
const csv = require("./shared/csv");
const { loadJson, saveJson } = require("./shared/progress");
const {
  STAGE_RANK,
  createMergeMap,
  mergeIntoMap,
  loadMaster,
  saveMaster,
  queryByStage,
  promoteLeads,
} = require("./shared/master");

const CONFIG_PATH = projectPath("pipeline-config.json");
const PIPELINE_DIR = projectPath("data", ".pipeline");
const RUN_STATE_PATH = path.join(PIPELINE_DIR, "run_state.json");
const STEP_INPUT_PATH = path.join(PIPELINE_DIR, "step_input.csv");
const RUNS_DIR = path.join(PIPELINE_DIR, "runs");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// CLI Parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv || process.argv.slice(2);
  const command = args[0] === "status" ? "status" : "run";

  const opts = { command, from: null, to: null, skip: [], campaignId: null, dryRun: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--from" || arg.startsWith("--from=")) {
      opts.from = arg.includes("=") ? arg.split("=")[1] : args[++i];
    } else if (arg === "--to" || arg.startsWith("--to=")) {
      opts.to = arg.includes("=") ? arg.split("=")[1] : args[++i];
    } else if (arg === "--skip" || arg.startsWith("--skip=")) {
      const val = arg.includes("=") ? arg.split("=")[1] : args[++i];
      opts.skip = val.split(",");
    } else if (arg === "--campaign-id" || arg.startsWith("--campaign-id=")) {
      opts.campaignId = arg.includes("=") ? arg.split("=")[1] : args[++i];
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Step Filtering
// ---------------------------------------------------------------------------

function getActiveSteps(steps, opts) {
  let result = [...steps];
  let startIdx = 0;
  let endIdx = result.length - 1;

  if (opts.from) {
    startIdx = result.findIndex(s => s.name === opts.from);
    if (startIdx === -1) {
      console.error(`Unknown step: ${opts.from}`);
      console.error(`Valid steps: ${result.map(s => s.name).join(", ")}`);
      process.exit(1);
    }
  }
  if (opts.to) {
    endIdx = result.findIndex(s => s.name === opts.to);
    if (endIdx === -1) {
      console.error(`Unknown step: ${opts.to}`);
      process.exit(1);
    }
  }

  result = result.slice(startIdx, endIdx + 1);

  // Handle sidecar skipping
  const skipSet = new Set(opts.skip || []);
  result = result.filter(s => !skipSet.has(s.name));
  result = result.map(s => {
    if (s.sidecar && skipSet.has(s.sidecar.name)) {
      return { ...s, _skipSidecar: true };
    }
    return s;
  });

  return result;
}

module.exports = { loadConfig, parseArgs, getActiveSteps };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run pipeline.test.js`
Expected: PASS — all tests pass

- [ ] **Step 5: Commit**

```bash
git add pipeline.js pipeline.test.js
git commit -m "feat: pipeline.js CLI parsing, config loading, and step filtering"
```

---

### Task 5: Pipeline orchestrator — step execution engine

**Files:**
- Modify: `pipeline.test.js` (add execution tests)
- Modify: `pipeline.js` (add runStep, handleSidecar, retry logic)

- [ ] **Step 1: Write failing tests for step execution helpers**

Add to `pipeline.test.js`:

```js
const { runCommand, readStepOutput } = require("./pipeline");

describe("runCommand", () => {
  it("runs a simple command and resolves on success", async () => {
    const result = await runCommand("node -e \"console.log('hello')\"", { timeout: 5000 });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("hello");
  });

  it("rejects on non-zero exit code", async () => {
    const result = await runCommand("node -e \"process.exit(1)\"", { timeout: 5000 });
    expect(result.code).toBe(1);
  });

  it("captures stderr", async () => {
    const result = await runCommand("node -e \"console.error('oops')\"", { timeout: 5000 });
    expect(result.stderr).toContain("oops");
  });
});

describe("readStepOutput", () => {
  const fs = require("fs");
  const path = require("path");
  const os = require("os");

  it("reads CSV file and returns records", () => {
    const tmp = path.join(os.tmpdir(), "test_output.csv");
    fs.writeFileSync(tmp, "domain,email\na.com,a@a.com\nb.com,b@b.com\n");
    const records = readStepOutput(tmp);
    expect(records.length).toBe(2);
    expect(records[0].domain).toBe("a.com");
    fs.unlinkSync(tmp);
  });

  it("returns empty array for non-existent file", () => {
    const records = readStepOutput("/tmp/does_not_exist_12345.csv");
    expect(records).toEqual([]);
  });

  it("reads most recent CSV from directory", () => {
    const tmpDir = path.join(os.tmpdir(), "test_output_dir_" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "old.csv"), "domain,email\nold.com,old@old.com\n");
    // Touch with slight delay to ensure different mtime
    fs.writeFileSync(path.join(tmpDir, "new.csv"), "domain,email\nnew.com,new@new.com\n");
    const records = readStepOutput(tmpDir);
    expect(records.length).toBe(1);
    expect(records[0].domain).toBe("new.com");
    fs.rmSync(tmpDir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run pipeline.test.js`
Expected: FAIL — `runCommand` and `readStepOutput` not exported

- [ ] **Step 3: Implement runCommand and readStepOutput**

Add to `pipeline.js` before the `module.exports`:

```js
// ---------------------------------------------------------------------------
// Step Execution
// ---------------------------------------------------------------------------

function runCommand(cmd, opts = {}) {
  return new Promise((resolve) => {
    const [bin, ...args] = cmd.split(" ");
    const child = spawn(bin, args, {
      cwd: projectPath(),
      shell: true,
      timeout: opts.timeout || 300000,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    child.on("close", (code) => {
      resolve({ code: code || 0, stdout, stderr });
    });

    child.on("error", (err) => {
      resolve({ code: 1, stdout, stderr: stderr + err.message });
    });
  });
}

function readStepOutput(outputPath) {
  if (!outputPath) return [];
  const fullPath = projectPath(outputPath);

  try {
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      const files = fs.readdirSync(fullPath)
        .filter(f => f.endsWith(".csv"))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(fullPath, f)).mtime }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length === 0) return [];
      return csv.readCsv(path.join(fullPath, files[0].name)).records;
    }
    return csv.readCsv(fullPath).records;
  } catch {
    return [];
  }
}
```

Update `module.exports`:

```js
module.exports = { loadConfig, parseArgs, getActiveSteps, runCommand, readStepOutput };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run pipeline.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline.js pipeline.test.js
git commit -m "feat: pipeline.js runCommand and readStepOutput helpers"
```

---

### Task 6: Pipeline orchestrator — run and status commands

**Files:**
- Modify: `pipeline.js` (add main run loop, status command, async handling)

- [ ] **Step 1: Write failing test for status command output**

Add to `pipeline.test.js`:

```js
const { formatStatus } = require("./pipeline");

describe("formatStatus", () => {
  it("formats stage counts into a table", () => {
    const { createMergeMap, mergeIntoMap } = require("./shared/master");
    const map = createMergeMap();
    mergeIntoMap(map, { domain: "a.com", email: "a@a.com", pipeline_stage: "raw" });
    mergeIntoMap(map, { domain: "b.com", email: "b@b.com", pipeline_stage: "raw" });
    mergeIntoMap(map, { domain: "c.com", email: "c@c.com", pipeline_stage: "classified" });

    const output = formatStatus(map, null);
    expect(output).toContain("raw");
    expect(output).toContain("2");
    expect(output).toContain("classified");
    expect(output).toContain("1");
    expect(output).toContain("3 total leads");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run pipeline.test.js`
Expected: FAIL — `formatStatus` not exported

- [ ] **Step 3: Implement formatStatus, runPipeline, and main**

Add to `pipeline.js`:

```js
// ---------------------------------------------------------------------------
// Status Command
// ---------------------------------------------------------------------------

function formatStatus(masterMap, runState) {
  const stageCounts = {};
  let total = 0;
  for (const [, emailMap] of masterMap) {
    for (const [, record] of emailMap) {
      const stage = record.pipeline_stage || "raw";
      stageCounts[stage] = (stageCounts[stage] || 0) + 1;
      total++;
    }
  }

  const lines = [`Pipeline Status (${total.toLocaleString()} total leads)`];
  lines.push("─".repeat(40));

  // Sort stages by rank
  const stages = Object.keys(stageCounts).sort(
    (a, b) => (STAGE_RANK[a] || 99) - (STAGE_RANK[b] || 99)
  );
  for (const stage of stages) {
    lines.push(`${stage.padEnd(20)} ${stageCounts[stage].toLocaleString()}`);
  }
  lines.push("─".repeat(40));

  if (runState?.pending_batch) {
    const pb = runState.pending_batch;
    lines.push(`Pending batch: ${pb.step} (${pb.batch_id}, submitted ${pb.submitted_at})`);
  } else {
    lines.push("Pending batches: none");
  }

  if (runState?.failures?.length > 0) {
    lines.push(`Failures: ${runState.failures.map(f => `${f.step} (${f.remaining} remaining)`).join(", ")}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Async Batch Handling
// ---------------------------------------------------------------------------

async function checkPendingBatch(runState, masterMap) {
  if (!runState?.pending_batch) return { hasPending: false };

  const pb = runState.pending_batch;
  console.log(`Checking pending batch for ${pb.step}: ${pb.batch_id}...`);

  const statusResult = await runCommand(`python scripts/batch-helper.py status ${pb.batch_id}`, { timeout: 30000 });
  const statusOutput = statusResult.stdout.trim();

  if (statusOutput.includes("ended") || statusOutput.includes("completed")) {
    console.log("Batch complete — downloading results...");
    await runCommand(`python scripts/batch-helper.py results ${pb.batch_id}`, { timeout: 120000 });

    // Read classified output and promote leads
    const records = readStepOutput("data/classified/venues.csv");
    if (records.length > 0) {
      const promoted = promoteLeads(masterMap, records, pb.outputStage || "classified");
      saveMaster(masterMap);
      console.log(`Promoted ${promoted} leads to ${pb.outputStage || "classified"}`);
    }

    runState.pending_batch = null;
    saveJson(RUN_STATE_PATH, runState);
    return { hasPending: false, resumeFrom: pb.resumeAfter };
  }

  const elapsed = Date.now() - new Date(pb.submitted_at).getTime();
  const hours = (elapsed / 3600000).toFixed(1);
  console.log(`Batch ${pb.batch_id} still processing (submitted ${hours}h ago)`);
  return { hasPending: true };
}

// ---------------------------------------------------------------------------
// Run Pipeline
// ---------------------------------------------------------------------------

async function runPipeline(opts) {
  const config = loadConfig();
  ensureDir(PIPELINE_DIR);
  ensureDir(RUNS_DIR);

  // Phase 1 — Sync State
  console.log("=== Pipeline Orchestrator ===\n");
  console.log("Rebuilding master CSV...");

  // Run build-master to rebuild
  const rebuildResult = await runCommand("node scripts/build-master.js", { timeout: 120000 });
  if (rebuildResult.code !== 0) {
    console.error("Master rebuild failed:", rebuildResult.stderr);
    process.exit(1);
  }

  const masterMap = loadMaster();
  let totalLeads = 0;
  for (const [, emailMap] of masterMap) totalLeads += emailMap.size;
  console.log(`Master CSV loaded: ${totalLeads.toLocaleString()} leads\n`);

  // Check pending async batches
  const runState = loadJson(RUN_STATE_PATH) || { pending_batch: null, failures: [] };
  const batchStatus = await checkPendingBatch(runState, masterMap);
  if (batchStatus.hasPending) return;

  // Phase 2 — Plan
  const activeSteps = getActiveSteps(config.steps, opts);

  // Validate campaign requirement
  const needsCampaign = activeSteps.some(s => config.campaignSteps?.includes(s.name));
  if (needsCampaign && !opts.campaignId) {
    const campaignStepNames = activeSteps.filter(s => config.campaignSteps?.includes(s.name)).map(s => s.name);
    console.error(`Steps requiring --campaign-id: ${campaignStepNames.join(", ")}`);
    process.exit(1);
  }

  // Report planned counts
  console.log("Plan:");
  let hasWork = false;
  for (const step of activeSteps) {
    if (step.inputStage === null || step.inputStage === undefined) {
      console.log(`  ${step.name}: utility step (always runs)`);
      hasWork = true;
    } else {
      const leads = queryByStage(masterMap, step.inputStage);
      console.log(`  ${step.name}: ${leads.length} leads at '${step.inputStage}'`);
      if (leads.length > 0) hasWork = true;
    }
  }
  console.log();

  if (!hasWork) {
    console.log("Nothing to process.");
    return;
  }

  if (opts.dryRun) {
    console.log("[DRY RUN] Would execute above steps.");
    return;
  }

  // Phase 3 — Execute
  const runLog = { started: new Date().toISOString(), steps: [], failures: [] };

  for (const step of activeSteps) {
    let leads = [];
    if (step.inputStage !== null && step.inputStage !== undefined) {
      leads = queryByStage(masterMap, step.inputStage);
      if (leads.length === 0) {
        console.log(`--- [${step.name}] 0 leads, skipping ---\n`);
        continue;
      }
    }

    console.log(`--- [${step.name}] ${leads.length > 0 ? leads.length + " leads" : "utility step"} ---`);

    // Write temp input CSV if step takes input
    if (step.inputFlag && leads.length > 0) {
      csv.writeCsv(STEP_INPUT_PATH, leads);
    }

    // Build command
    const parts = [step.script];
    if (step.inputFlag && leads.length > 0) {
      parts.push(step.inputFlag, STEP_INPUT_PATH);
    }
    if (step.requiresCampaign && opts.campaignId) {
      parts.push("--campaign-id", opts.campaignId);
    }
    const cmd = parts.join(" ");
    console.log(`  $ ${cmd}`);

    // Execute with retry
    const maxRetries = config.retries?.default || 2;
    const retryDelay = config.retries?.delay || 5000;
    let success = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        console.log(`  Retry ${attempt}/${maxRetries}...`);
        // Check for partial output before retry
        if (step.outputPath) {
          const partial = readStepOutput(step.outputPath);
          if (partial.length > 0 && step.outputStage) {
            const promoted = promoteLeads(masterMap, partial, step.outputStage);
            if (promoted > 0) {
              saveMaster(masterMap);
              console.log(`  Promoted ${promoted} partial results`);
              leads = queryByStage(masterMap, step.inputStage);
              if (leads.length === 0) { success = true; break; }
              csv.writeCsv(STEP_INPUT_PATH, leads);
            }
          }
        }
        await new Promise(r => setTimeout(r, retryDelay));
      }

      const startTime = Date.now();
      const result = await runCommand(cmd, { timeout: step.timeout || 300000 });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (result.code === 0) {
        console.log(`  Done in ${elapsed}s`);

        // Handle async step — capture batch ID
        if (step.async) {
          const batchMatch = result.stdout.match(/BATCH_ID:(\S+)/);
          if (batchMatch) {
            runState.pending_batch = {
              step: step.name,
              batch_id: batchMatch[1],
              submitted_at: new Date().toISOString(),
              outputStage: step.outputStage,
              resumeAfter: step.name,
            };
            saveJson(RUN_STATE_PATH, runState);
            console.log(`  Batch submitted: ${batchMatch[1]}`);
            console.log(`  Run 'node pipeline.js run' again to check results.\n`);
            runLog.steps.push({ name: step.name, status: "async", elapsed });
            // Save run log and exit
            saveJson(path.join(RUNS_DIR, `${timestamp()}.json`), runLog);
            return;
          }
        }

        // Promote leads from output
        if (step.outputPath && step.outputStage) {
          const output = readStepOutput(step.outputPath);
          if (output.length > 0) {
            const promoted = promoteLeads(masterMap, output, step.outputStage);
            saveMaster(masterMap);
            console.log(`  Promoted ${promoted} leads to '${step.outputStage}'`);
          }
        }

        // Run sidecar if present and not skipped
        if (step.sidecar && !step._skipSidecar) {
          const sidecar = step.sidecar;
          const sidecarInput = projectPath(sidecar.inputSource);
          if (fs.existsSync(sidecarInput) && fs.statSync(sidecarInput).size > 0) {
            console.log(`  Running sidecar: ${sidecar.name}`);
            const sidecarCmd = `${sidecar.script} ${sidecar.inputFlag} ${sidecarInput}`;
            console.log(`  $ ${sidecarCmd}`);
            const sidecarResult = await runCommand(sidecarCmd, { timeout: sidecar.timeout || 300000 });
            if (sidecarResult.code === 0 && sidecar.outputPath && sidecar.outputStage) {
              const sidecarOutput = readStepOutput(sidecar.outputPath);
              if (sidecarOutput.length > 0) {
                const promoted = promoteLeads(masterMap, sidecarOutput, sidecar.outputStage);
                saveMaster(masterMap);
                console.log(`  Sidecar promoted ${promoted} leads to '${sidecar.outputStage}'`);
              }
            } else if (sidecarResult.code !== 0) {
              console.log(`  Sidecar ${sidecar.name} failed (non-blocking)`);
            }
          }
        }

        runLog.steps.push({ name: step.name, status: "ok", elapsed, leads: leads.length });
        success = true;
        break;
      } else {
        console.log(`  Failed (exit ${result.code}) in ${elapsed}s`);
        if (result.stderr) console.log(`  ${result.stderr.split("\n")[0]}`);
      }
    }

    if (!success) {
      console.log(`  Step ${step.name} failed after ${maxRetries + 1} attempts`);
      // Save partial progress
      if (step.outputPath && step.outputStage) {
        const partial = readStepOutput(step.outputPath);
        if (partial.length > 0) {
          const promoted = promoteLeads(masterMap, partial, step.outputStage);
          saveMaster(masterMap);
          console.log(`  Saved ${promoted} partial results`);
        }
      }
      const remaining = queryByStage(masterMap, step.inputStage).length;
      runState.failures = runState.failures || [];
      runState.failures.push({
        step: step.name,
        error: "max retries exceeded",
        remaining,
        timestamp: new Date().toISOString(),
      });
      runLog.failures.push({ name: step.name, remaining });
    }
    console.log();
  }

  // Phase 4 — Report
  runLog.completed = new Date().toISOString();
  saveJson(RUN_STATE_PATH, runState);
  saveJson(path.join(RUNS_DIR, `${timestamp()}.json`), runLog);

  console.log("=== Pipeline Summary ===");
  console.log(`Steps run: ${runLog.steps.length}`);
  console.log(`Failures: ${runLog.failures.length}`);
  for (const s of runLog.steps) {
    console.log(`  ${s.name}: ${s.status} (${s.elapsed}s${s.leads ? ", " + s.leads + " leads" : ""})`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  if (opts.command === "status") {
    const masterMap = loadMaster();
    const runState = loadJson(RUN_STATE_PATH);
    console.log(formatStatus(masterMap, runState));
    return;
  }

  await runPipeline(opts);
}

// Run main only when executed directly
if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
```

Update `module.exports`:

```js
module.exports = {
  loadConfig, parseArgs, getActiveSteps,
  runCommand, readStepOutput, formatStatus,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run pipeline.test.js`
Expected: PASS — all tests pass

- [ ] **Step 5: Commit**

```bash
git add pipeline.js pipeline.test.js
git commit -m "feat: pipeline.js run/status commands with retry, async, and sidecar support"
```

---

### Task 7: Add classify_batch.py BATCH_ID output

**Files:**
- Modify: `2-enrichment/classify_batch.py` (add `BATCH_ID:` print line after batch submission)

- [ ] **Step 1: Read classify_batch.py to find the batch submission code**

Read the file and find where it calls `client.messages.batches.create()` or equivalent.

- [ ] **Step 2: Add BATCH_ID output after submission**

After the batch is submitted and the batch ID is available, add:

```python
print(f"BATCH_ID:{batch.id}", flush=True)
```

This must print to stdout in the format `BATCH_ID:<id>` so the orchestrator can parse it.

- [ ] **Step 3: Verify the script still runs standalone**

Run: `python 2-enrichment/classify_batch.py --help` (or with `--dry-run` if supported)
Expected: No errors, help text or dry-run output

- [ ] **Step 4: Commit**

```bash
git add 2-enrichment/classify_batch.py
git commit -m "feat: classify_batch.py prints BATCH_ID to stdout for orchestrator"
```

---

### Task 8: Update package.json and run integration test

**Files:**
- Modify: `package.json` (update pipeline script)

- [ ] **Step 1: Update package.json pipeline script**

Change the `"pipeline"` script from `"node pipeline.js"` to `"node pipeline.js run"`:

```json
"pipeline": "node pipeline.js run",
"pipeline:status": "node pipeline.js status",
```

- [ ] **Step 2: Run the full test suite**

Run: `npx vitest run`
Expected: All tests pass — `shared/master.test.js`, `scripts/build-master.test.js`, `pipeline.test.js`, `shared/fields.test.js`

- [ ] **Step 3: Verify pipeline.js status command works**

Run: `node pipeline.js status`
Expected: Prints stage counts table (or "Master CSV not found" if no data)

- [ ] **Step 4: Verify pipeline.js dry-run works**

Run: `node pipeline.js run --dry-run`
Expected: Prints plan with lead counts per step, then "[DRY RUN] Would execute above steps."

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "chore: update package.json pipeline scripts for new orchestrator"
```
