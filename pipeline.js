#!/usr/bin/env node
/**
 * Pipeline orchestrator — runs the full lead processing flow with one command.
 *
 * Steps: dedup → prefilter → classify → escalate → phones → export → upload → verify → assign
 *
 * Usage:
 *   node pipeline.js --campaign-id 12345
 *   node pipeline.js --start-at prefilter --stop-after export
 *   node pipeline.js --start-at upload --campaign-id 12345
 *   node pipeline.js --skip escalate,phones --campaign-id 12345
 *   node pipeline.js --dry-run
 *   node pipeline.js --force   # re-run steps even if output exists
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { projectPath } = require("./shared/utils");

const STEPS = [
  {
    name: "dedup",
    cmd: "node",
    script: "1-prospecting/dedup/dedup_geolead.js",
    output: "data/enriched/geolead_net_new.csv",
    description: "Deduplicate GeoLead results against existing sources",
  },
  {
    name: "prefilter",
    cmd: "node",
    script: "2-enrichment/prefilter.js",
    output: "data/filtered/leads.csv",
    inputFlag: "--input",
    inputFrom: "dedup",
    description: "Pre-filter: remove government, schools, parks, etc.",
  },
  {
    name: "classify",
    cmd: "python",
    script: "2-enrichment/classify_batch.py",
    output: "data/classified/venues.csv",
    inputFlag: "--input",
    inputFrom: "prefilter",
    description: "AI classification via Haiku Batch API",
  },
  {
    name: "escalate",
    cmd: "python",
    script: "2-enrichment/escalate_sonnet.py",
    output: "data/verified/venues.csv",
    optional: true,
    description: "Sonnet escalation for ambiguous leads",
  },
  {
    name: "phones",
    cmd: "python",
    script: "2-enrichment/validate_phones.py",
    output: "data/phone_validated/mobile.csv",
    inputFlag: "--input",
    inputFrom: "classify",
    description: "Phone validation via Numverify API",
  },
  {
    name: "export",
    cmd: "node",
    script: "2-enrichment/export_clean.js",
    output: "data/final/",
    outputIsDir: true,
    description: "Merge confirmed venues into clean CSV",
  },
  {
    name: "upload",
    cmd: "node",
    script: "3-outreach/upload_leads.js",
    output: "data/reports/.upload_progress.jsonl",
    requiresCampaign: true,
    inputFlag: "--input",
    inputFrom: "export",
    campaignFlag: "--campaign-id",
    description: "Upload leads to SmartLead",
  },
  {
    name: "verify",
    cmd: "node",
    script: "3-outreach/verify_emails.js",
    requiresCampaign: true,
    campaignFlag: "--campaign-id",
    description: "Run SmartLead email verification",
  },
  {
    name: "assign",
    cmd: "node",
    script: "3-outreach/assign_campaigns.js",
    requiresCampaign: true,
    inputFlag: "--input",
    inputFrom: "export",
    campaignFlag: "--campaign-id",
    description: "Assign verified leads to campaign",
  },
  {
    name: "dashboards",
    cmd: "node",
    script: "scripts/update-dashboards.js",
    extraFlags: ["--skip-api"],
    description: "Update HTML dashboards with latest data",
  },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const idx = (flag) => args.indexOf(flag);
  return {
    startAt: idx("--start-at") !== -1 ? args[idx("--start-at") + 1] : null,
    stopAfter: idx("--stop-after") !== -1 ? args[idx("--stop-after") + 1] : null,
    campaignId: idx("--campaign-id") !== -1 ? args[idx("--campaign-id") + 1] : null,
    input: idx("--input") !== -1 ? args[idx("--input") + 1] : null,
    skip: idx("--skip") !== -1 ? args[idx("--skip") + 1].split(",") : [],
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
  };
}

function stepOutputExists(step) {
  if (!step.output) return false;
  const fullPath = projectPath(step.output);
  if (step.outputIsDir) {
    try {
      const files = fs.readdirSync(fullPath);
      return files.some((f) => f.endsWith(".csv"));
    } catch {
      return false;
    }
  }
  try {
    const stat = fs.statSync(fullPath);
    return stat.size > 0;
  } catch {
    return false;
  }
}

function resolveInput(step, opts) {
  // First step or explicit override
  if (opts.input && step === getActiveSteps(opts)[0]) {
    return opts.input;
  }
  if (!step.inputFrom) return null;

  const source = STEPS.find((s) => s.name === step.inputFrom);
  if (!source || !source.output) return null;

  if (source.outputIsDir) {
    // Find most recent CSV in the directory
    const dir = projectPath(source.output);
    try {
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".csv"))
        .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtime }))
        .sort((a, b) => b.mtime - a.mtime);
      return files.length > 0 ? path.join(dir, files[0].name) : null;
    } catch {
      return null;
    }
  }

  return projectPath(source.output);
}

function getActiveSteps(opts) {
  let steps = [...STEPS];
  let startIdx = 0;
  let endIdx = steps.length - 1;

  if (opts.startAt) {
    startIdx = steps.findIndex((s) => s.name === opts.startAt);
    if (startIdx === -1) {
      console.error(`Unknown step: ${opts.startAt}`);
      console.error(`Valid steps: ${steps.map((s) => s.name).join(", ")}`);
      process.exit(1);
    }
  }
  if (opts.stopAfter) {
    endIdx = steps.findIndex((s) => s.name === opts.stopAfter);
    if (endIdx === -1) {
      console.error(`Unknown step: ${opts.stopAfter}`);
      process.exit(1);
    }
  }

  steps = steps.slice(startIdx, endIdx + 1);
  steps = steps.filter((s) => !opts.skip.includes(s.name));
  return steps;
}

function main() {
  const opts = parseArgs();
  const steps = getActiveSteps(opts);

  // Validate campaign requirement
  const needsCampaign = steps.some((s) => s.requiresCampaign);
  if (needsCampaign && !opts.campaignId) {
    console.error(
      "Steps requiring --campaign-id: " +
        steps
          .filter((s) => s.requiresCampaign)
          .map((s) => s.name)
          .join(", ")
    );
    process.exit(1);
  }

  console.log("=== Cold Outreach Pipeline ===\n");
  console.log(
    `Steps: ${steps.map((s) => s.name).join(" → ")}` +
      (opts.dryRun ? " [DRY RUN]" : "")
  );
  console.log();

  for (const step of steps) {
    const exists = stepOutputExists(step);
    const skip = exists && !opts.force;

    console.log(`--- [${step.name}] ${step.description} ---`);

    if (skip) {
      console.log(`  ⏭  Output exists, skipping (use --force to re-run)\n`);
      continue;
    }

    // Build command
    const parts = [step.cmd, step.script];
    const inputPath = resolveInput(step, opts);
    if (step.inputFlag && inputPath) {
      parts.push(step.inputFlag, inputPath);
    }
    if (step.requiresCampaign && step.campaignFlag) {
      parts.push(step.campaignFlag, opts.campaignId);
    }
    if (step.extraFlags) {
      parts.push(...step.extraFlags);
    }

    const cmd = parts.join(" ");
    console.log(`  $ ${cmd}`);

    if (opts.dryRun) {
      console.log("  [DRY RUN] Would execute above command\n");
      continue;
    }

    const startTime = Date.now();
    try {
      execSync(cmd, {
        cwd: projectPath(),
        stdio: "inherit",
        timeout: 7200000, // 2 hour timeout (for Haiku batch)
      });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  Done in ${elapsed}s\n`);
    } catch (err) {
      if (step.optional) {
        console.log(`  Optional step failed, continuing.\n`);
        continue;
      }
      console.error(`\n  FAILED: ${step.name}`);
      console.error(`  Exit code: ${err.status}`);
      process.exit(err.status || 1);
    }
  }

  console.log("=== Pipeline complete ===");
}

main();
