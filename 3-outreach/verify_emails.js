#!/usr/bin/env node
/**
 * Trigger and monitor SmartLead email verification for a campaign.
 *
 * SmartLead provides 80,000 free email verification credits.
 * This script triggers verification, polls until complete, and exports results.
 *
 * Usage:
 *   node 3-outreach/verify_emails.js --campaign-id 12345
 *   node 3-outreach/verify_emails.js --campaign-id 12345 --poll-interval 30
 */

const {
  verifyEmails,
  getVerificationStatus,
  getCampaign,
} = require("../shared/smartlead");
const { saveJson } = require("../shared/progress");
const { projectPath, ensureDir } = require("../shared/utils");

function parseArgs() {
  const args = process.argv.slice(2);
  const idx = (flag) => args.indexOf(flag);
  return {
    campaignId: idx("--campaign-id") !== -1 ? args[idx("--campaign-id") + 1] : null,
    pollInterval: idx("--poll-interval") !== -1
      ? parseInt(args[idx("--poll-interval") + 1], 10)
      : 60,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const opts = parseArgs();

  if (!opts.campaignId) {
    console.error("Usage: node 3-outreach/verify_emails.js --campaign-id <id> [--poll-interval 60]");
    process.exit(1);
  }

  // Check campaign exists
  const campaign = await getCampaign(opts.campaignId);
  console.log(`Campaign: ${campaign.name || opts.campaignId}`);

  // Check if verification is already running
  let status = await getVerificationStatus(opts.campaignId);
  console.log(`Current verification status: ${JSON.stringify(status)}`);

  if (status && status.status === "in_progress") {
    console.log("Verification already in progress. Polling for completion...");
  } else if (status && status.status === "completed") {
    console.log("Verification already completed.");
  } else {
    // Trigger new verification
    console.log("Triggering email verification...");
    const triggerResult = await verifyEmails(opts.campaignId);
    console.log(`Trigger response: ${JSON.stringify(triggerResult)}`);
  }

  // Poll until complete
  let polls = 0;
  while (true) {
    status = await getVerificationStatus(opts.campaignId);

    if (status && status.status === "completed") {
      console.log("\nEmail verification completed!");
      break;
    }

    polls++;
    const progress = status && status.progress ? ` (${status.progress})` : "";
    process.stdout.write(
      `\r  Polling... ${polls} checks${progress} — next in ${opts.pollInterval}s`
    );

    await sleep(opts.pollInterval * 1000);
  }

  // Export results
  const reportsDir = projectPath("data", "reports");
  ensureDir(reportsDir);
  const outPath = projectPath(
    "data",
    "reports",
    `email_verification_${opts.campaignId}.json`
  );
  saveJson(outPath, {
    campaign_id: opts.campaignId,
    status,
    completed_at: new Date().toISOString(),
  });
  console.log(`Results saved to ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
