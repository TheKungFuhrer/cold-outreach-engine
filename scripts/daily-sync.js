#!/usr/bin/env node
/**
 * Daily Engagement Sync — orchestrates SmartLead status sync + GHL push.
 *
 * Cron: 0 8 * * * (8 AM daily)
 *
 * Usage:
 *   node scripts/daily-sync.js [--dry-run]
 */

const path = require("path");
const { readCsv } = require("../shared/csv");
const { projectPath } = require("../shared/utils");

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  console.log(`=== Daily Engagement Sync — ${new Date().toISOString().slice(0, 10)} ===`);
  if (dryRun) console.log("[DRY RUN MODE]\n");

  // Step 1: Run SmartLead sync
  console.log("Step 1: Syncing SmartLead engagement data...\n");
  const sync = require("../5-lifecycle/sync_smartlead_status");
  const { report, hotLeads } = await sync.main();

  // Step 2: Push hot leads to GHL if any exist
  if (hotLeads && hotLeads.length > 0) {
    console.log("\nStep 2: Pushing hot leads to GHL...\n");
    const ghlPush = require("../5-lifecycle/push_ghl_hot_leads");
    await ghlPush.main();
  } else {
    console.log("\nStep 2: No hot leads — skipping GHL push.");
  }

  console.log("\n=== Daily Sync Complete ===");
}

main().catch((err) => {
  console.error("\nDaily sync failed:", err);
  process.exit(1);
});
