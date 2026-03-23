#!/usr/bin/env node
/**
 * Pull campaign performance metrics from SmartLead.
 *
 * Usage:
 *   node 4-analytics/campaign_stats.js
 *   node 4-analytics/campaign_stats.js --campaign-id 12345
 */

const { listCampaigns, getCampaignStats } = require("../shared/smartlead");
const { saveJson } = require("../shared/progress");
const { projectPath, ensureDir, timestamp } = require("../shared/utils");

function parseArgs() {
  const args = process.argv.slice(2);
  const idx = (flag) => args.indexOf(flag);
  return {
    campaignId: idx("--campaign-id") !== -1 ? args[idx("--campaign-id") + 1] : null,
  };
}

async function main() {
  const opts = parseArgs();

  console.log("=== Campaign Performance Stats ===\n");

  let campaigns;
  if (opts.campaignId) {
    campaigns = [{ id: opts.campaignId }];
  } else {
    campaigns = await listCampaigns();
    console.log(`Found ${campaigns.length} campaigns\n`);
  }

  const results = [];

  for (const campaign of campaigns) {
    try {
      const stats = await getCampaignStats(campaign.id);
      const entry = {
        id: campaign.id,
        name: campaign.name || stats.name || `Campaign ${campaign.id}`,
        ...stats,
      };
      results.push(entry);

      console.log(`${entry.name} (ID: ${campaign.id})`);
      if (stats.total_leads != null) console.log(`  Total leads:    ${stats.total_leads}`);
      if (stats.emails_sent != null) console.log(`  Emails sent:    ${stats.emails_sent}`);
      if (stats.opens != null) console.log(`  Opens:          ${stats.opens}`);
      if (stats.replies != null) console.log(`  Replies:        ${stats.replies}`);
      if (stats.bounces != null) console.log(`  Bounces:        ${stats.bounces}`);
      if (stats.unsubscribes != null) console.log(`  Unsubscribes:   ${stats.unsubscribes}`);
      console.log();
    } catch (err) {
      console.error(`  Campaign ${campaign.id}: ${err.message}\n`);
    }
  }

  // Save report
  ensureDir(projectPath("data", "reports"));
  const report = {
    generated_at: new Date().toISOString(),
    campaigns: results,
  };
  const outPath = projectPath("data", "reports", `campaign_stats_${timestamp()}.json`);
  saveJson(outPath, report);
  console.log(`Saved to ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
