#!/usr/bin/env node
/**
 * Assign verified leads to a SmartLead campaign.
 *
 * Supports segmenting by phone type (mobile, voip, landline) or uploading all.
 * Resumable via JSONL checkpoint.
 *
 * Usage:
 *   node 3-outreach/assign_campaigns.js --campaign-id 12345 --input data/final/clean_venues.csv
 *   node 3-outreach/assign_campaigns.js --campaign-id 12345 --segment mobile
 *   node 3-outreach/assign_campaigns.js --campaign-id 12345 --segment mobile --limit 500 --dry-run
 */

const { readCsv, findField } = require("../shared/csv");
const { addLeadsToCampaign, chunkArray } = require("../shared/smartlead");
const { loadJsonl, appendJsonl } = require("../shared/progress");
const { projectPath, ensureDir } = require("../shared/utils");

const EMAIL_FIELDS = ["email", "Email", "email_address", "one_email", "decision_maker_email"];

const SEGMENT_PATHS = {
  mobile: "data/phone_validated/mobile.csv",
  voip: "data/phone_validated/voip.csv",
  landline: "data/phone_validated/landline.csv",
};

function parseArgs() {
  const args = process.argv.slice(2);
  const idx = (flag) => args.indexOf(flag);
  return {
    campaignId: idx("--campaign-id") !== -1 ? args[idx("--campaign-id") + 1] : null,
    input: idx("--input") !== -1 ? args[idx("--input") + 1] : null,
    segment: idx("--segment") !== -1 ? args[idx("--segment") + 1] : null,
    limit: idx("--limit") !== -1 ? parseInt(args[idx("--limit") + 1], 10) : Infinity,
    dryRun: args.includes("--dry-run"),
  };
}

function resolveInput(opts) {
  if (opts.input) return opts.input;
  if (opts.segment && SEGMENT_PATHS[opts.segment]) {
    return projectPath(SEGMENT_PATHS[opts.segment]);
  }
  console.error("Provide --input <csv> or --segment <mobile|voip|landline>");
  process.exit(1);
}

async function main() {
  const opts = parseArgs();

  if (!opts.campaignId) {
    console.error(
      "Usage: node 3-outreach/assign_campaigns.js --campaign-id <id> --input <csv> | --segment <type> [--limit N] [--dry-run]"
    );
    process.exit(1);
  }

  const inputPath = resolveInput(opts);
  const { records } = await readCsv(inputPath);
  console.log(`Loaded ${records.length} records from ${inputPath}`);

  // Extract unique emails
  const emails = [];
  const seen = new Set();
  for (const row of records) {
    const email = (findField(row, EMAIL_FIELDS) || "").trim().toLowerCase();
    if (email && !seen.has(email)) {
      seen.add(email);
      emails.push(email);
    }
  }
  console.log(`Unique emails: ${emails.length}`);

  // Load checkpoint
  ensureDir(projectPath("data", "reports"));
  const checkpointPath = projectPath(
    "data",
    "reports",
    `.assign_${opts.campaignId}_progress.jsonl`
  );
  const checkpoint = loadJsonl(checkpointPath);
  const assigned = new Set(checkpoint.flatMap((r) => r.emails || []));
  const pending = emails.filter((e) => !assigned.has(e));
  const toAssign = pending.slice(0, opts.limit);

  console.log(`Already assigned: ${assigned.size}, pending: ${toAssign.length}`);

  if (opts.dryRun) {
    console.log(`\n[DRY RUN] Would assign ${toAssign.length} leads to campaign ${opts.campaignId}`);
    return;
  }

  if (toAssign.length === 0) {
    console.log("Nothing to assign.");
    return;
  }

  const batches = chunkArray(toAssign, 400);
  console.log(`Assigning ${toAssign.length} leads in ${batches.length} batches...`);

  let totalAssigned = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      const result = await addLeadsToCampaign(opts.campaignId, batch);

      appendJsonl(checkpointPath, {
        batch: i + 1,
        count: batch.length,
        emails: batch,
        result,
        timestamp: new Date().toISOString(),
      });

      totalAssigned += batch.length;
      console.log(`  Batch ${i + 1}/${batches.length}: ${batch.length} leads assigned`);
    } catch (err) {
      console.error(`  Batch ${i + 1}/${batches.length} FAILED: ${err.message}`);
    }
  }

  console.log(`\n--- Assignment Summary ---`);
  console.log(`Campaign:  ${opts.campaignId}`);
  console.log(`Assigned:  ${totalAssigned}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
