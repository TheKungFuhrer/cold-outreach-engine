# Pipeline Orchestrator

**Date:** 2026-03-24
**Status:** Approved

## Problem

The cold outreach pipeline has 37 scripts across Node.js and Python, each run manually or via separate cron jobs. The existing `pipeline.js` uses `execSync` to chain steps linearly but has no per-lead state tracking. The same leads can be reprocessed across runs because no mechanism tracks which leads have completed which steps. The pipeline also has two parallel paths (original SmartLead batch and GeoLead batch) that should be unified.

## Solution

A monolithic pipeline orchestrator (`pipeline.js` rewrite) that uses the master CSV's `pipeline_stage` column as the single source of truth for per-lead state. A JSON config file defines the pipeline as a DAG with sidecar support. The orchestrator queries the master CSV before each step, passes only eligible leads, and promotes their stage after completion.

## Key Design Decisions

1. **Orchestrator owns stage filtering** — the orchestrator queries the master CSV and passes only leads at the required `inputStage` to each script. Individual scripts do not need to know about the master CSV.
2. **Two-phase async for batch classification** — async steps (Haiku batch) submit and exit. The next `pipeline.js run` detects the pending batch, collects results, and continues.
3. **Partial progress is real progress** — if a step processes 3,000 of 5,000 leads then fails, those 3,000 get promoted in the master CSV immediately. The next run picks up the remaining 2,000.
4. **Linear with sidecars** — the main pipeline is linear, but steps can define a sidecar that runs on a filtered subset (e.g., `escalate` runs on ambiguous leads after `classify`).
5. **Full rebuild + incremental updates** — full master CSV rebuild at the start of each run to sync state, then incremental updates after each step during the run.

## Pipeline Config (pipeline-config.json)

The DAG is defined as a JSON array of step objects:

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
        "filter": { "field": "confidence", "op": "<", "value": 0.7 },
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
      "outputStage": "validated",
      "outputPath": "data/final/",
      "timeout": 300000
    },
    {
      "name": "upload",
      "script": "node 3-outreach/upload_leads.js",
      "inputStage": "validated",
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

### Config Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique step identifier |
| `script` | Yes | Command to execute (`node ...` or `python ...`) |
| `inputStage` | No | Required `pipeline_stage` for input leads. `null` = no lead filtering (utility steps like dashboards) |
| `outputStage` | No | Stage to promote leads to on success. `null` = no promotion |
| `inputFlag` | No | CLI flag for passing the temp input CSV (e.g., `--input`) |
| `outputPath` | No | Expected output file/directory to read results from |
| `async` | No | `true` = two-phase submit/resume behavior |
| `timeout` | No | Max execution time in ms (default from config or 300000) |
| `requiresCampaign` | No | `true` = needs `--campaign-id` CLI arg |
| `sidecar` | No | A sub-step that runs on a filtered subset of this step's output |
| `sidecar.filter` | Yes (if sidecar) | `{ field, op, value }` — filter criteria for which leads go to the sidecar |

## Orchestrator Flow

### Phase 1 — Sync State

1. Load `pipeline-config.json`
2. Full master CSV rebuild via `shared/master.js` `rebuildMaster()` — reads all source CSVs, merges by domain+email, writes `data/master/leads_master.csv`
3. Check `data/.pipeline/run_state.json` for pending async batches. If found, check batch status. If complete, download results, update master, clear pending state. If still processing, print status and exit.

### Phase 2 — Plan

4. Determine active steps from config, respecting `--from`, `--to`, `--skip` CLI args
5. For each active step with an `inputStage`, query master CSV for leads at that stage. Report counts: `"prefilter: 342 leads, classify: 0 leads (skip), validate_phones: 1,208 leads"`
6. If all counts are zero and no utility steps to run, print "Nothing to process" and exit
7. In `--dry-run` mode, print the plan and exit without executing

### Phase 3 — Execute

8. For each active step with leads > 0 (or `inputStage: null` for utility steps):
   - Write eligible leads to `data/.pipeline/step_input.csv`
   - Spawn the script via `child_process.spawn` (captures stdout/stderr, respects timeout)
   - **On success:** Read output CSV, call `promoteLeads()` to update master CSV incrementally, log timing
   - **On failure:** Retry up to N times with delay. Before each retry, check for partial output — if present, promote partial results and re-query for remaining leads only. After retries exhausted, log failure to `run_state.json`, move to next step.
   - **If step has sidecar:** After main step succeeds, filter output for matching leads (per sidecar's `filter`), write temp input, run sidecar script, merge results back into master
   - **If step is async:** Spawn script, capture batch ID from stdout, save to `run_state.json`, print "Batch submitted" message, exit cleanly

### Phase 4 — Report

9. Print summary: steps run, leads promoted per step, failures, total time elapsed
10. Save run log to `data/.pipeline/runs/YYYY-MM-DD_HHmmss.json`

## CLI Interface

```
node pipeline.js run                          # full pipeline
node pipeline.js run --from=classify          # start from classify step
node pipeline.js run --to=validate_phones     # stop after validate_phones
node pipeline.js run --skip=escalate          # skip specific step/sidecar
node pipeline.js run --campaign-id=3071191    # enable upload/verify/assign steps
node pipeline.js run --dry-run                # show plan without executing
node pipeline.js status                       # show lead counts per pipeline_stage
```

### `status` Command

Reads the master CSV and outputs a table:

```
Pipeline Status (112,045 total leads)
─────────────────────────────────
raw              342
filtered         1,208
classified       5,420
validated        18,321
enriched         55,984
uploaded         24,044
in_campaign      6,726
─────────────────────────────────
Pending batches: none
Last run: 2026-03-24T09:15:00Z (3 steps, 0 failures)
```

## shared/master.js — Extracted Module

Core functions extracted from `build-master.js`:

| Function | Description |
|----------|-------------|
| `rebuildMaster()` | Full rebuild from all source CSVs. Returns in-memory map, writes `data/master/leads_master.csv` |
| `loadMaster()` | Reads existing master CSV into `Map<domain, Map<email, record>>` |
| `queryByStage(masterMap, stage)` | Returns array of records whose `pipeline_stage` equals the given stage |
| `promoteLeads(masterMap, leads, newStage)` | Updates `pipeline_stage` and `last_updated` for matched leads. Only moves forward (never demotes). |
| `saveMaster(masterMap)` | Writes the map back to `data/master/leads_master.csv` |

`build-master.js` imports from `shared/master.js` instead of having its own merge logic. Standalone usage (`node scripts/build-master.js --export ghl`) continues to work unchanged.

### Stage Ordering

Stages have a strict ordering enforced by `promoteLeads`:

```
raw(0) < filtered(1) < classified(2) < validated(3) < enriched(4) < uploaded(5) < in_campaign(6)
```

A lead at `validated` cannot be demoted to `classified`. This prevents regressions when steps produce partial output.

## Async Two-Phase Flow

For steps with `async: true` (batch classification):

**Submit phase:**
1. Orchestrator writes eligible leads to temp input
2. Script submits to Anthropic Batch API, prints batch ID to stdout
3. Orchestrator saves `{ "pending_batch": { "step": "classify", "batch_id": "...", "submitted_at": "..." } }` to `run_state.json`
4. Orchestrator exits with message: `"Batch submitted. Run 'node pipeline.js run' again to check results."`

**Resume phase:**
1. On next `run`, Phase 1 checks `run_state.json` for pending batches
2. Calls `batch-helper.py status <batch_id>` to check completion
3. If complete: runs `batch-helper.py results <batch_id>`, updates master CSV, clears pending state, continues pipeline from next step
4. If still processing: prints `"Batch <id> still processing (submitted <time> ago)"` and exits

No retry for async steps — the batch either completes or fails on Anthropic's side. On batch failure, pending state is cleared and leads remain at `filtered` for the next submit.

## Retry Logic

- On step failure, retry up to `retries.default` times (config, default: 2) with `retries.delay` ms between attempts
- Before each retry, check if partial output exists at `outputPath`. If so, read it, promote partial results in master, and re-query for only remaining leads
- After all retries exhausted: log failure to `run_state.json` with error details and remaining count, move to next step
- `run_state.json` failure format: `{ "failures": [{ "step": "validate_phones", "error": "...", "remaining": 847, "timestamp": "..." }] }`
- `pipeline.js status` surfaces any recorded failures

## File Structure

```
pipeline.js                          # Orchestrator (rewrite)
pipeline-config.json                 # DAG config
shared/master.js                     # Extracted master CSV logic
data/.pipeline/                      # Orchestrator working directory
  step_input.csv                     # Temp input for current step
  run_state.json                     # Pending batches, failures
  runs/                              # Run history logs
    2026-03-24_091500.json
```

## What Changes

| Component | Change |
|-----------|--------|
| `pipeline.js` | Full rewrite — DAG execution with stage filtering |
| `shared/master.js` | New file — extracted from `build-master.js` |
| `scripts/build-master.js` | Refactored to import from `shared/master.js` |
| `pipeline-config.json` | New file — DAG definition |
| `data/.pipeline/` | New directory — orchestrator state |

## What Doesn't Change

- All individual pipeline scripts (`prefilter.js`, `classify_batch.py`, `validate_phones.py`, etc.) remain unchanged — they still accept `--input` and write to their existing output paths
- `shared/csv.js`, `shared/dedup.js`, `shared/fields.js` unchanged
- `scripts/daily-prospect.js` unchanged (it has its own pipeline logic for daily runs)
- Data directory layout unchanged
- GHL export via `build-master.js --export ghl` unchanged
