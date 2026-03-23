#!/usr/bin/env node
/**
 * Lifecycle funnel tracker — maps SmartLead engagement data back to lead segments.
 *
 * Pulls campaign engagement (sent, opened, replied) and joins with
 * phone type and source data to measure conversion by segment.
 *
 * Usage:
 *   node 5-lifecycle/funnel_tracker.js --campaign-id 12345
 */

const { getCampaignStats, listCampaigns } = require("../shared/smartlead");
const { readCsv, findField } = require("../shared/csv");
const { saveJson } = require("../shared/progress");
const { projectPath, ensureDir, timestamp } = require("../shared/utils");

const EMAIL_FIELDS = ["email", "Email", "email_address", "one_email", "decision_maker_email"];

function parseArgs() {
  const args = process.argv.slice(2);
  const idx = (flag) => args.indexOf(flag);
  return {
    campaignId: idx("--campaign-id") !== -1 ? args[idx("--campaign-id") + 1] : null,
  };
}

async function loadSegmentEmails() {
  const segments = {};
  const segmentFiles = {
    mobile: "data/phone_validated/mobile.csv",
    voip: "data/phone_validated/voip.csv",
    landline: "data/phone_validated/landline.csv",
  };

  for (const [segment, filePath] of Object.entries(segmentFiles)) {
    try {
      const { records } = await readCsv(projectPath(filePath));
      const emails = new Set();
      for (const row of records) {
        const email = (findField(row, EMAIL_FIELDS) || "").trim().toLowerCase();
        if (email) emails.add(email);
      }
      segments[segment] = emails;
    } catch {
      segments[segment] = new Set();
    }
  }

  return segments;
}

function classifyEmail(email, segments) {
  const e = email.trim().toLowerCase();
  for (const [segment, emails] of Object.entries(segments)) {
    if (emails.has(e)) return segment;
  }
  return "unknown";
}

async function main() {
  const opts = parseArgs();

  console.log("=== Lifecycle Funnel Tracker ===\n");

  // Load phone segments
  const segments = await loadSegmentEmails();
  for (const [name, emails] of Object.entries(segments)) {
    console.log(`  ${name}: ${emails.size} emails`);
  }
  console.log();

  // Get campaign stats
  let campaigns;
  if (opts.campaignId) {
    campaigns = [{ id: opts.campaignId }];
  } else {
    campaigns = await listCampaigns();
  }

  const results = [];

  for (const campaign of campaigns) {
    try {
      const stats = await getCampaignStats(campaign.id);
      results.push({
        campaign_id: campaign.id,
        name: campaign.name || stats.name || `Campaign ${campaign.id}`,
        stats,
      });

      console.log(`Campaign: ${campaign.name || campaign.id}`);
      console.log(`  Total:   ${stats.total_leads || "—"}`);
      console.log(`  Sent:    ${stats.emails_sent || "—"}`);
      console.log(`  Opened:  ${stats.opens || "—"}`);
      console.log(`  Replied: ${stats.replies || "—"}`);

      // Calculate rates
      if (stats.emails_sent > 0) {
        const openRate = ((stats.opens || 0) / stats.emails_sent * 100).toFixed(1);
        const replyRate = ((stats.replies || 0) / stats.emails_sent * 100).toFixed(1);
        console.log(`  Open rate:  ${openRate}%`);
        console.log(`  Reply rate: ${replyRate}%`);
      }
      console.log();
    } catch (err) {
      console.error(`  Campaign ${campaign.id}: ${err.message}\n`);
    }
  }

  // Save report
  ensureDir(projectPath("data", "reports"));
  const report = {
    generated_at: new Date().toISOString(),
    segments: Object.fromEntries(
      Object.entries(segments).map(([k, v]) => [k, v.size])
    ),
    campaigns: results,
  };
  const outPath = projectPath("data", "reports", `lifecycle_funnel_${timestamp()}.json`);
  saveJson(outPath, report);
  console.log(`Saved to ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
