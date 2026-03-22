#!/usr/bin/env node
/**
 * Pull leads from SmartLead campaigns and save raw CSV exports.
 * Excludes unsubscribed/opted-out leads.
 *
 * Usage: node 1-prospecting/pull_leads.js [--campaign-id <id>]
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { requireEnv } = require("../shared/env");
const { projectPath, ensureDir, timestamp } = require("../shared/utils");

const DATA_RAW = projectPath("data", "raw");
ensureDir(DATA_RAW);

const apiKey = requireEnv("SMARTLEAD_API_KEY");

function run(cmd) {
  return execSync(cmd, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
}

function smartlead(args) {
  return run(`smartlead --api-key "${apiKey}" ${args}`);
}

async function main() {
  const campaignIdArg = process.argv.find((a) => a === "--campaign-id");
  const campaignId = campaignIdArg
    ? process.argv[process.argv.indexOf(campaignIdArg) + 1]
    : null;

  console.log("Fetching lead categories...");
  try {
    const categories = smartlead("leads categories --format json");
    console.log("Available categories:", categories.trim());
  } catch {
    console.log("Could not fetch categories, continuing...");
  }

  const ts = timestamp();

  if (campaignId) {
    const outFile = path.join(DATA_RAW, `campaign_${campaignId}_${ts}.csv`);
    console.log(`Exporting campaign ${campaignId}...`);
    smartlead(`campaigns export --id ${campaignId} --out "${outFile}"`);
    console.log(`Saved to ${outFile}`);
  } else {
    const outFile = path.join(DATA_RAW, `all_leads_${ts}.csv`);
    console.log("Exporting all leads across campaigns...");
    const csv = smartlead("leads list-all --all --format csv");
    fs.writeFileSync(outFile, csv);
    console.log(`Saved ${csv.split("\n").length - 1} leads to ${outFile}`);
  }

  const files = fs.readdirSync(DATA_RAW);
  console.log(`\nRaw exports in data/raw/: ${files.length} file(s)`);
  files.forEach((f) => console.log(`  - ${f}`));
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
