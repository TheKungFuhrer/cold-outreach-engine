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

  // Step 3: Refresh dashboard data
  // IMPORTANT: Pass lastSyncAt from the sync report's generated_at timestamp.
  // The sync checkpoint has already been updated by this point, so we can't read it.
  // The report.generated_at captures when the sync started (before checkpoint update).
  console.log("\n--- Step 3: Refresh dashboard data ---");
  try {
    const { refresh } = require("./refresh-dashboard");
    const dashboardData = await refresh({ lastSyncAt: report?.generated_at });

    // Step 4: Send daily email
    console.log("\n--- Step 4: Send daily email ---");
    try {
      const { sendDailyEmail } = require("./daily-email");
      await sendDailyEmail(dashboardData);
    } catch (emailErr) {
      console.error("  [warn] Daily email failed (non-fatal):", emailErr.message);
    }
  } catch (refreshErr) {
    console.error("  [warn] Dashboard refresh failed (non-fatal):", refreshErr.message);
  }

  console.log("\n=== Daily Sync Complete ===");
}

main().catch((err) => {
  console.error("\nDaily sync failed:", err);
  process.exit(1);
});
