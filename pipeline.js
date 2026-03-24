#!/usr/bin/env node
/**
 * Pipeline orchestrator — config-driven lead processing with retry, async batch,
 * sidecar support, and master-map integration.
 *
 * Usage:
 *   node pipeline.js                                 # run all steps
 *   node pipeline.js --from classify --to export     # run subset
 *   node pipeline.js --skip escalate,phones          # skip steps
 *   node pipeline.js --campaign-id 12345             # required for upload/verify/assign
 *   node pipeline.js --dry-run                       # plan only
 *   node pipeline.js status                          # show pipeline state
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { projectPath, ensureDir, timestamp } = require("./shared/utils");
const csv = require("./shared/csv");
const { loadJson, saveJson } = require("./shared/progress");
const { STAGE_RANK, loadMaster, saveMaster, queryByStage, promoteLeads } = require("./shared/master");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIG_PATH = projectPath("pipeline-config.json");
const PIPELINE_DIR = projectPath("data", ".pipeline");
const RUN_STATE_PATH = path.join(PIPELINE_DIR, "run_state.json");
const STEP_INPUT_PATH = path.join(PIPELINE_DIR, "step_input.csv");
const RUNS_DIR = path.join(PIPELINE_DIR, "runs");

// ---------------------------------------------------------------------------
// Part 1: CLI Parsing & Config Loading
// ---------------------------------------------------------------------------

/**
 * Load pipeline configuration from pipeline-config.json.
 * @returns {object} parsed config with steps array
 */
function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  return JSON.parse(raw);
}

/**
 * Parse CLI arguments.
 * @param {string[]} argv - process.argv.slice(2) equivalent
 * @returns {{ command: string, from: string|null, to: string|null, skip: string[], campaignId: string|null, dryRun: boolean }}
 */
function parseArgs(argv) {
  const result = {
    command: "run",
    from: null,
    to: null,
    skip: [],
    campaignId: null,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (i === 0 && arg === "status") {
      result.command = "status";
      continue;
    }

    if (arg === "--dry-run") {
      result.dryRun = true;
      continue;
    }

    // Handle --flag=value and --flag value forms
    let key, value;
    if (arg.includes("=")) {
      const eqIdx = arg.indexOf("=");
      key = arg.slice(0, eqIdx);
      value = arg.slice(eqIdx + 1);
    } else {
      key = arg;
      value = argv[i + 1];
    }

    switch (key) {
      case "--from":
        result.from = value;
        if (!arg.includes("=")) i++;
        break;
      case "--to":
        result.to = value;
        if (!arg.includes("=")) i++;
        break;
      case "--skip":
        result.skip = value ? value.split(",") : [];
        if (!arg.includes("=")) i++;
        break;
      case "--campaign-id":
        result.campaignId = value;
        if (!arg.includes("=")) i++;
        break;
    }
  }

  return result;
}

/**
 * Filter steps by from/to/skip options.
 * If a skip name matches a sidecar, mark the parent with _skipSidecar instead of removing it.
 * @param {object[]} steps
 * @param {{ from: string|null, to: string|null, skip: string[] }} opts
 * @returns {object[]}
 */
function getActiveSteps(steps, opts) {
  let result = [...steps];

  // Apply from filter
  if (opts.from) {
    const fromIdx = result.findIndex((s) => s.name === opts.from);
    if (fromIdx !== -1) {
      result = result.slice(fromIdx);
    }
  }

  // Apply to filter
  if (opts.to) {
    const toIdx = result.findIndex((s) => s.name === opts.to);
    if (toIdx !== -1) {
      result = result.slice(0, toIdx + 1);
    }
  }

  // Apply skip filter — if skip name matches a sidecar, mark parent instead
  if (opts.skip.length > 0) {
    result = result.filter((step) => {
      if (opts.skip.includes(step.name)) return false;
      // Check if skip targets a sidecar
      if (step.sidecar && opts.skip.includes(step.sidecar.name)) {
        step = Object.assign({}, step); // avoid mutating original
        step._skipSidecar = true;
      }
      return true;
    });

    // Re-apply sidecar skip marks (since filter creates new refs only on removal)
    result = result.map((step) => {
      if (step.sidecar && opts.skip.includes(step.sidecar.name)) {
        return { ...step, _skipSidecar: true };
      }
      return step;
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Part 2: Step Execution
// ---------------------------------------------------------------------------

/**
 * Run a shell command via spawn, capturing output.
 * @param {string} cmd - full command string
 * @param {{ timeout?: number }} opts
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runCommand(cmd, opts = {}) {
  const timeout = opts.timeout || 300000;
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, cwd: projectPath() });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeout);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code || 0, stdout, stderr });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr + err.message });
    });
  });
}

/**
 * Read step output CSV. If outputPath is a directory, reads the most recent CSV by mtime.
 * @param {string|null} outputPath - relative path from project root
 * @returns {object[]} array of records
 */
function readStepOutput(outputPath) {
  if (!outputPath) return [];

  try {
    const fullPath = projectPath(outputPath);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      const files = fs.readdirSync(fullPath)
        .filter((f) => f.endsWith(".csv"))
        .map((f) => ({
          name: f,
          mtime: fs.statSync(path.join(fullPath, f)).mtime.getTime(),
        }))
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length === 0) return [];
      return csv.readCsv(path.join(fullPath, files[0].name)).records;
    }

    return csv.readCsv(fullPath).records;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Part 3: Run & Status Commands
// ---------------------------------------------------------------------------

/**
 * Format a status table showing lead counts per pipeline_stage.
 * @param {Map} masterMap - master merge map
 * @param {object|null} runState - run_state.json contents
 * @returns {string}
 */
function formatStatus(masterMap, runState) {
  const lines = [];
  lines.push("=== Pipeline Status ===\n");

  // Count leads per stage
  const stageCounts = {};
  for (const stage of Object.keys(STAGE_RANK)) {
    stageCounts[stage] = 0;
  }
  for (const [domain, emailMap] of masterMap) {
    for (const [email, record] of emailMap) {
      const stage = record.pipeline_stage || "raw";
      if (stageCounts[stage] !== undefined) {
        stageCounts[stage]++;
      } else {
        stageCounts[stage] = 1;
      }
    }
  }

  // Sort by STAGE_RANK order
  const sortedStages = Object.keys(stageCounts).sort(
    (a, b) => (STAGE_RANK[a] ?? 99) - (STAGE_RANK[b] ?? 99)
  );

  const maxNameLen = Math.max(...sortedStages.map((s) => s.length));
  for (const stage of sortedStages) {
    if (stageCounts[stage] > 0) {
      lines.push(`  ${stage.padEnd(maxNameLen)}  ${stageCounts[stage].toLocaleString()}`);
    }
  }

  // Pending batches
  if (runState && runState.pendingBatch) {
    lines.push("");
    lines.push(`Pending batch: ${runState.pendingBatch.batchId} (step: ${runState.pendingBatch.step})`);
  }

  // Failures
  if (runState && runState.failures && runState.failures.length > 0) {
    lines.push("");
    lines.push("Failures:");
    for (const f of runState.failures) {
      lines.push(`  - ${f.step}: ${f.error || "unknown error"}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Check if a pending async batch exists and handle completion.
 * @param {object} runState
 * @param {Map} masterMap
 * @returns {Promise<{ hasPending: boolean, resumeFrom?: string }>}
 */
async function checkPendingBatch(runState, masterMap) {
  if (!runState || !runState.pendingBatch) {
    return { hasPending: false };
  }

  const { batchId, step } = runState.pendingBatch;
  console.log(`Checking pending batch ${batchId} for step "${step}"...`);

  const result = await runCommand(`python scripts/batch-helper.py status ${batchId}`);
  const output = result.stdout.trim();

  if (output.includes("complete") || output.includes("COMPLETE")) {
    console.log("Batch complete! Downloading results...");
    const dlResult = await runCommand(`python scripts/batch-helper.py download ${batchId}`);

    if (dlResult.code === 0) {
      // Read output and promote leads
      const config = loadConfig();
      const stepConfig = config.steps.find((s) => s.name === step);
      if (stepConfig && stepConfig.outputPath) {
        const records = readStepOutput(stepConfig.outputPath);
        if (records.length > 0 && stepConfig.outputStage) {
          const promoted = promoteLeads(masterMap, records, stepConfig.outputStage);
          console.log(`Promoted ${promoted} leads to "${stepConfig.outputStage}"`);
          saveMaster(masterMap);
        }
      }

      // Clear pending state
      delete runState.pendingBatch;
      saveJson(RUN_STATE_PATH, runState);
      console.log("Batch cleared. Resuming pipeline.\n");

      // Find the next step after the completed one
      const stepIdx = config.steps.findIndex((s) => s.name === step);
      const nextStep = stepIdx < config.steps.length - 1 ? config.steps[stepIdx + 1] : null;
      return { hasPending: false, resumeFrom: nextStep ? nextStep.name : null };
    }
  }

  console.log(`Batch ${batchId} still processing. Run again later.\n`);
  return { hasPending: true };
}

/**
 * Main pipeline orchestrator loop.
 * @param {object} opts - parsed CLI options
 */
async function runPipeline(opts) {
  ensureDir(PIPELINE_DIR);
  ensureDir(RUNS_DIR);

  const config = loadConfig();
  const runLog = {
    startedAt: new Date().toISOString(),
    opts,
    steps: [],
    summary: {},
  };

  // ------------------------------------------------------------------
  // Phase 1: Sync State
  // ------------------------------------------------------------------
  console.log("=== Cold Outreach Pipeline ===\n");
  console.log("[Phase 1] Syncing master state...");

  await runCommand("node scripts/build-master.js");
  let masterMap = loadMaster();

  const runState = loadJson(RUN_STATE_PATH) || { failures: [] };
  const batchCheck = await checkPendingBatch(runState, masterMap);
  if (batchCheck.hasPending) {
    console.log("Pipeline paused — async batch still pending.");
    return;
  }

  // If batch just completed, adjust from
  if (batchCheck.resumeFrom && !opts.from) {
    opts.from = batchCheck.resumeFrom;
    console.log(`Resuming from "${opts.from}" after batch completion.`);
  }

  // Reload master after potential batch promotion
  masterMap = loadMaster();

  // ------------------------------------------------------------------
  // Phase 2: Plan
  // ------------------------------------------------------------------
  console.log("[Phase 2] Planning execution...\n");

  const activeSteps = getActiveSteps(config.steps, opts);

  // Validate campaign requirement
  const needsCampaign = activeSteps.some((s) => s.requiresCampaign);
  if (needsCampaign && !opts.campaignId) {
    const campSteps = activeSteps.filter((s) => s.requiresCampaign).map((s) => s.name);
    console.error(`ERROR: Steps requiring --campaign-id: ${campSteps.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  // Report lead counts per step
  let hasWork = false;
  for (const step of activeSteps) {
    if (step.inputStage === null) {
      console.log(`  [${step.name}] utility step (always runs)`);
      hasWork = true;
      continue;
    }
    const leads = queryByStage(masterMap, step.inputStage);
    console.log(`  [${step.name}] ${leads.length} leads at stage "${step.inputStage}"`);
    if (leads.length > 0) hasWork = true;
  }
  console.log();

  if (!hasWork) {
    console.log("Nothing to process. All stages empty.");
    return;
  }

  if (opts.dryRun) {
    console.log(`[DRY RUN] Would execute: ${activeSteps.map((s) => s.name).join(" -> ")}`);
    return;
  }

  // ------------------------------------------------------------------
  // Phase 3: Execute
  // ------------------------------------------------------------------
  console.log("[Phase 3] Executing steps...\n");

  const retries = (config.retries && config.retries.default) || 2;
  const retryDelay = (config.retries && config.retries.delay) || 5000;

  for (const step of activeSteps) {
    const stepLog = { name: step.name, startedAt: new Date().toISOString(), status: "pending" };

    // Utility steps (inputStage: null) always run
    if (step.inputStage === null) {
      console.log(`--- [${step.name}] utility step ---`);
      const result = await runCommand(step.script, { timeout: step.timeout });
      stepLog.status = result.code === 0 ? "success" : "failed";
      stepLog.code = result.code;
      runLog.steps.push(stepLog);
      if (result.code === 0) {
        console.log(`  Done.\n`);
      } else {
        console.log(`  Failed (exit ${result.code})\n`);
      }
      continue;
    }

    // Query leads at input stage
    let leads = queryByStage(masterMap, step.inputStage);
    if (leads.length === 0) {
      console.log(`--- [${step.name}] 0 leads at "${step.inputStage}", skipping ---\n`);
      stepLog.status = "skipped";
      stepLog.reason = "no leads";
      runLog.steps.push(stepLog);
      continue;
    }

    console.log(`--- [${step.name}] ${leads.length} leads ---`);

    let success = false;
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      if (attempt > 1) {
        console.log(`  Retry ${attempt - 1}/${retries}...`);
        // Check partial output and promote before retry
        if (step.outputPath) {
          const partial = readStepOutput(step.outputPath);
          if (partial.length > 0 && step.outputStage) {
            const promoted = promoteLeads(masterMap, partial, step.outputStage);
            if (promoted > 0) {
              console.log(`  Promoted ${promoted} partial results`);
              saveMaster(masterMap);
            }
          }
        }
        // Re-query remaining leads
        leads = queryByStage(masterMap, step.inputStage);
        if (leads.length === 0) {
          console.log(`  All leads processed via partial results.\n`);
          success = true;
          break;
        }
        await new Promise((r) => setTimeout(r, retryDelay));
      }

      // Write leads to temp CSV
      csv.writeCsv(STEP_INPUT_PATH, leads);

      // Build command
      const parts = [step.script];
      if (step.inputFlag) {
        parts.push(step.inputFlag, STEP_INPUT_PATH);
      }
      if (step.requiresCampaign && opts.campaignId) {
        parts.push("--campaign-id", opts.campaignId);
      }
      const cmd = parts.join(" ");
      console.log(`  $ ${cmd}`);

      const result = await runCommand(cmd, { timeout: step.timeout });

      // Check for async batch
      if (step.async) {
        const batchMatch = result.stdout.match(/BATCH_ID:(\S+)/);
        if (batchMatch) {
          const batchId = batchMatch[1];
          console.log(`  Async batch submitted: ${batchId}`);
          runState.pendingBatch = { batchId, step: step.name, submittedAt: new Date().toISOString() };
          saveJson(RUN_STATE_PATH, runState);
          stepLog.status = "async_pending";
          stepLog.batchId = batchId;
          runLog.steps.push(stepLog);
          console.log("  Pipeline paused — re-run to check batch status.\n");

          // Save run log and exit early
          runLog.summary.stoppedAt = step.name;
          runLog.summary.reason = "async_batch";
          const logPath = path.join(RUNS_DIR, `${timestamp()}.json`);
          saveJson(logPath, runLog);
          return;
        }
      }

      if (result.code === 0) {
        success = true;

        // Read output and promote leads
        if (step.outputPath && step.outputStage) {
          const records = readStepOutput(step.outputPath);
          if (records.length > 0) {
            const promoted = promoteLeads(masterMap, records, step.outputStage);
            console.log(`  Promoted ${promoted} leads to "${step.outputStage}"`);
            saveMaster(masterMap);
          }
        }

        // Handle sidecar
        if (step.sidecar && !step._skipSidecar) {
          const sidecar = step.sidecar;
          const sidecarInput = projectPath(sidecar.inputSource);
          try {
            const stat = fs.statSync(sidecarInput);
            if (stat.size > 0) {
              console.log(`  Running sidecar: ${sidecar.name}`);
              const scParts = [sidecar.script];
              if (sidecar.inputFlag) {
                scParts.push(sidecar.inputFlag, sidecarInput);
              }
              const scResult = await runCommand(scParts.join(" "), { timeout: sidecar.timeout });
              if (scResult.code === 0 && sidecar.outputPath && sidecar.outputStage) {
                const scRecords = readStepOutput(sidecar.outputPath);
                if (scRecords.length > 0) {
                  const scPromoted = promoteLeads(masterMap, scRecords, sidecar.outputStage);
                  console.log(`  Sidecar promoted ${scPromoted} leads to "${sidecar.outputStage}"`);
                  saveMaster(masterMap);
                }
              }
            }
          } catch {
            // Sidecar input doesn't exist — skip silently
          }
        }

        const elapsed = ((Date.now() - new Date(stepLog.startedAt).getTime()) / 1000).toFixed(1);
        console.log(`  Done in ${elapsed}s\n`);
        break;
      } else {
        console.log(`  Failed (exit ${result.code})`);
        if (result.stderr) {
          const errLines = result.stderr.split("\n").slice(0, 5).join("\n");
          console.log(`  ${errLines}`);
        }
      }
    }

    stepLog.status = success ? "success" : "failed";
    runLog.steps.push(stepLog);

    if (!success) {
      console.log(`  Step "${step.name}" failed after ${retries + 1} attempts.\n`);
      if (!runState.failures) runState.failures = [];
      runState.failures.push({
        step: step.name,
        error: `Failed after ${retries + 1} attempts`,
        at: new Date().toISOString(),
      });
      saveJson(RUN_STATE_PATH, runState);
      // Continue to next step
    }
  }

  // ------------------------------------------------------------------
  // Phase 4: Report
  // ------------------------------------------------------------------
  console.log("[Phase 4] Summary\n");

  const succeeded = runLog.steps.filter((s) => s.status === "success").length;
  const failed = runLog.steps.filter((s) => s.status === "failed").length;
  const skipped = runLog.steps.filter((s) => s.status === "skipped").length;

  runLog.summary = { succeeded, failed, skipped, completedAt: new Date().toISOString() };
  console.log(`  Succeeded: ${succeeded}  Failed: ${failed}  Skipped: ${skipped}`);
  console.log();

  // Save run log
  const logPath = path.join(RUNS_DIR, `${timestamp()}.json`);
  saveJson(logPath, runLog);
  console.log(`Run log saved: ${logPath}`);
  console.log("\n=== Pipeline complete ===");
}

/**
 * CLI entry point.
 */
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.command === "status") {
    const masterMap = loadMaster();
    const runState = loadJson(RUN_STATE_PATH);
    console.log(formatStatus(masterMap, runState));
    return;
  }

  await runPipeline(opts);
}

// ---------------------------------------------------------------------------
// Exports & CLI
// ---------------------------------------------------------------------------

module.exports = { loadConfig, parseArgs, getActiveSteps, runCommand, readStepOutput, formatStatus };

if (require.main === module) {
  main().catch((err) => {
    console.error("Pipeline error:", err);
    process.exitCode = 1;
  });
}
