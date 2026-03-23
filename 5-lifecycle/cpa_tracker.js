#!/usr/bin/env node
/**
 * Cost-per-acquisition tracker — calculates CPA at each pipeline stage.
 *
 * Combines cost report data with funnel report data to show
 * how much each lead costs at every stage of the pipeline.
 *
 * Usage:
 *   node 5-lifecycle/cpa_tracker.js
 *   node 5-lifecycle/cpa_tracker.js --subscription-cost 97
 */

const fs = require("fs");
const path = require("path");
const { readCsv } = require("../shared/csv");
const { loadJsonl, saveJson } = require("../shared/progress");
const { projectPath, ensureDir, timestamp } = require("../shared/utils");

function parseArgs() {
  const args = process.argv.slice(2);
  const idx = (flag) => args.indexOf(flag);
  return {
    subscriptionCost: idx("--subscription-cost") !== -1
      ? parseFloat(args[idx("--subscription-cost") + 1])
      : 0,
  };
}

async function safeCount(filePath) {
  try {
    const { records } = await readCsv(projectPath(filePath));
    return records.length;
  } catch {
    return 0;
  }
}

function findLatestReport(prefix) {
  const dir = projectPath("data", "reports");
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    return JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf-8"));
  } catch {
    return null;
  }
}

async function main() {
  const opts = parseArgs();

  console.log("=== Cost Per Acquisition Report ===\n");

  // Load cost data
  const costReport = findLatestReport("cost_report_");
  const totalApiCost = costReport ? costReport.total_cost : 0;
  const totalCost = totalApiCost + opts.subscriptionCost;

  if (costReport) {
    console.log(`API costs:          $${totalApiCost.toFixed(2)}`);
  } else {
    console.log("No cost report found — run: node 4-analytics/cost_report.js");
  }
  if (opts.subscriptionCost > 0) {
    console.log(`Subscription cost:  $${opts.subscriptionCost.toFixed(2)}`);
  }
  console.log(`Total spend:        $${totalCost.toFixed(2)}\n`);

  // Count at each stage
  const stages = [
    { name: "Post pre-filter", path: "data/filtered/leads.csv" },
    { name: "Classified venues", path: "data/classified/venues.csv" },
    { name: "Phone: mobile", path: "data/phone_validated/mobile.csv" },
    { name: "Phone: voip", path: "data/phone_validated/voip.csv" },
    { name: "Phone: landline", path: "data/phone_validated/landline.csv" },
  ];

  const results = [];
  for (const stage of stages) {
    const count = await safeCount(stage.path);
    const cpa = count > 0 ? totalCost / count : null;
    results.push({ name: stage.name, count, cpa });

    const cpaStr = cpa !== null ? `$${cpa.toFixed(4)}` : "—";
    console.log(
      `  ${stage.name.padEnd(22)} ${String(count).padStart(8)} leads    CPA: ${cpaStr}`
    );
  }

  // Save report
  ensureDir(projectPath("data", "reports"));
  const report = {
    generated_at: new Date().toISOString(),
    total_api_cost: totalApiCost,
    subscription_cost: opts.subscriptionCost,
    total_cost: totalCost,
    stages: results,
  };
  const outPath = projectPath("data", "reports", `cpa_report_${timestamp()}.json`);
  saveJson(outPath, report);
  console.log(`\nSaved to ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
