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
const { readCsv } = require("../shared/csv");
const { resolveField } = require("../shared/fields");
const { saveJson } = require("../shared/progress");
const { projectPath, ensureDir, timestamp } = require("../shared/utils");

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
        const email = resolveField(row, "email").toLowerCase();
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
      // Normalize field names (API returns sent_count, open_count, etc.)
      const total = parseInt(stats.total_count || stats.total_leads || 0);
      const sent = parseInt(stats.sent_count || stats.emails_sent || stats.unique_sent_count || 0);
      const uniqueSent = parseInt(stats.unique_sent_count || sent);
      const opened = parseInt(stats.open_count || stats.opens || 0);
      const uniqueOpened = parseInt(stats.unique_open_count || opened);
      const replied = parseInt(stats.reply_count || stats.replies || 0);
      const clicked = parseInt(stats.click_count || stats.clicks || 0);
      const bounced = parseInt(stats.bounce_count || stats.bounces || 0);
      const interested = parseInt((stats.campaign_lead_stats || {}).interested || 0);
      const completed = parseInt((stats.campaign_lead_stats || {}).completed || 0);
      const inProgress = parseInt((stats.campaign_lead_stats || {}).inprogress || 0);

      results.push({
        campaign_id: campaign.id,
        name: campaign.name || stats.name || `Campaign ${campaign.id}`,
        total, sent, uniqueSent, opened, uniqueOpened, replied, clicked, bounced, interested, completed, inProgress,
        raw: stats,
      });

      console.log(`Campaign: ${stats.name || campaign.name || campaign.id}`);
      console.log(`  Leads:         ${(stats.campaign_lead_stats || {}).total || total}`);
      console.log(`  Completed:     ${completed} | In-progress: ${inProgress}`);
      console.log(`  Interested:    ${interested}`);
      console.log(`  Emails sent:   ${sent} total (${uniqueSent} unique leads)`);
      console.log(`  Opens:         ${opened} total (${uniqueOpened} unique)`);
      console.log(`  Replies:       ${replied}`);
      console.log(`  Clicks:        ${clicked}`);
      console.log(`  Bounces:       ${bounced}`);

      // Calculate rates based on unique leads contacted
      if (uniqueSent > 0) {
        const openRate = (uniqueOpened / uniqueSent * 100).toFixed(1);
        const replyRate = (replied / uniqueSent * 100).toFixed(1);
        const bounceRate = (bounced / uniqueSent * 100).toFixed(1);
        const interestedRate = (interested / uniqueSent * 100).toFixed(1);
        console.log(`  --- Rates (per unique lead) ---`);
        console.log(`  Open rate:       ${openRate}%`);
        console.log(`  Reply rate:      ${replyRate}%`);
        console.log(`  Bounce rate:     ${bounceRate}%`);
        console.log(`  Interested rate: ${interestedRate}%`);
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
