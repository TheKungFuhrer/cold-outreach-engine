#!/usr/bin/env node
/**
 * Pull leads from SmartLead campaigns and save raw CSV exports.
 * Excludes unsubscribed/opted-out leads.
 *
 * Usage: node 1-prospecting/pull_leads.js [--campaign-id <id>]
 */

const fs = require("fs");
const path = require("path");
const { projectPath, ensureDir, timestamp } = require("../shared/utils");
const {
  getLeadCategories,
  exportCampaignCsv,
  exportAllLeadsCsv,
} = require("../shared/smartlead");

const DATA_RAW = projectPath("data", "raw");
ensureDir(DATA_RAW);

async function main() {
  const campaignIdArg = process.argv.find((a) => a === "--campaign-id");
  const campaignId = campaignIdArg
    ? process.argv[process.argv.indexOf(campaignIdArg) + 1]
    : null;

  console.log("Fetching lead categories...");
  try {
    const categories = getLeadCategories();
    console.log("Available categories:", JSON.stringify(categories));
  } catch {
    console.log("Could not fetch categories, continuing...");
  }

  const ts = timestamp();

  if (campaignId) {
    const outFile = path.join(DATA_RAW, `campaign_${campaignId}_${ts}.csv`);
    console.log(`Exporting campaign ${campaignId}...`);
    const success = exportCampaignCsv(campaignId, outFile);
    console.log(success ? `Saved to ${outFile}` : `Export failed for campaign ${campaignId}`);
  } else {
    const outFile = path.join(DATA_RAW, `all_leads_${ts}.csv`);
    console.log("Exporting all leads across campaigns...");
    const csv = exportAllLeadsCsv();
    if (csv) {
      fs.writeFileSync(outFile, csv);
      console.log(`Saved ${csv.split("\n").length - 1} leads to ${outFile}`);
    } else {
      console.error("Failed to export leads.");
    }
  }

  const files = fs.readdirSync(DATA_RAW);
  console.log(`\nRaw exports in data/raw/: ${files.length} file(s)`);
  files.forEach((f) => console.log(`  - ${f}`));
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
