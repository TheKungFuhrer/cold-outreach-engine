#!/usr/bin/env node
/**
 * SmartLead Engagement Sync — pulls lead-level status from SmartLead,
 * updates the master CSV, and generates hot_leads.csv + dead_leads.csv.
 *
 * Usage:
 *   node 5-lifecycle/sync_smartlead_status.js [--dry-run]
 */

const { readCsv, writeCsv } = require("../shared/csv");
const { resolveField } = require("../shared/fields");
const { loadJson, saveJson } = require("../shared/progress");
const { projectPath, ensureDir, timestamp } = require("../shared/utils");
const {
  listCampaigns,
  getCampaignLeads,
  getCampaignStats,
  getLeadMessageHistory,
} = require("../shared/smartlead");

// ---------------------------------------------------------------------------
// Status precedence: higher number wins in multi-campaign merge
// ---------------------------------------------------------------------------

const STATUS_PRECEDENCE = {
  sent: 1,
  bounced: 2,
  unsubscribed: 3,
  opened: 4,
  replied: 5,
};

/**
 * Derive a single status string from a SmartLead lead record's fields.
 * @param {Object} lead - Lead object with reply_count, open_count, is_bounced, is_unsubscribed
 * @returns {string} One of: replied, opened, unsubscribed, bounced, sent
 */
function deriveStatus(lead) {
  if (lead.reply_count > 0) return "replied";
  if (lead.open_count > 0) return "opened";
  if (lead.is_unsubscribed) return "unsubscribed";
  if (lead.is_bounced) return "bounced";
  return "sent";
}

/**
 * Merge a lead's engagement data into the map, applying status precedence.
 * @param {Map} map - Map<email, engagementData>
 * @param {Object} data - { email, status, last_email_sent_at, last_opened_at, last_replied_at, reply_text, campaign_id }
 */
function mergeLeadData(map, data) {
  const email = data.email.toLowerCase();
  const existing = map.get(email);

  if (!existing) {
    map.set(email, {
      smartlead_status: data.status,
      last_email_sent_at: data.last_email_sent_at || "",
      last_opened_at: data.last_opened_at || "",
      last_replied_at: data.last_replied_at || "",
      reply_text: data.reply_text || "",
      campaign_ids: [data.campaign_id],
    });
    return;
  }

  // Merge status: higher precedence wins
  if (
    (STATUS_PRECEDENCE[data.status] || 0) >
    (STATUS_PRECEDENCE[existing.smartlead_status] || 0)
  ) {
    existing.smartlead_status = data.status;
  }

  // Keep most recent timestamps
  const tsFields = ["last_email_sent_at", "last_opened_at", "last_replied_at"];
  for (const field of tsFields) {
    if (data[field] && (!existing[field] || data[field] > existing[field])) {
      existing[field] = data[field];
    }
  }

  // Concatenate reply text if new
  if (data.reply_text && !existing.reply_text.includes(data.reply_text)) {
    existing.reply_text = existing.reply_text
      ? `${existing.reply_text}\n---\n${data.reply_text}`
      : data.reply_text;
  }

  // Track campaign IDs
  if (!existing.campaign_ids.includes(data.campaign_id)) {
    existing.campaign_ids.push(data.campaign_id);
  }
}

/**
 * Build hot leads array (Wavv format) from engagement data.
 * Only includes leads who replied after lastSyncAt.
 * @param {Map} engagementMap
 * @param {Array} masterRows - Master CSV records
 * @param {string|null} lastSyncAt - ISO timestamp of last sync, or null for first run
 * @returns {Array<Object>} Wavv-formatted rows: Email, Phone, First Name, Last Name, Company, Notes
 */
function buildHotLeads(engagementMap, masterRows, lastSyncAt) {
  const hot = [];
  for (const row of masterRows) {
    const email = resolveField(row, "email").toLowerCase();
    if (!email) continue;
    const engagement = engagementMap.get(email);
    if (!engagement || engagement.smartlead_status !== "replied") continue;
    if (lastSyncAt && engagement.last_replied_at <= lastSyncAt) continue;

    hot.push({
      Email: email,
      Phone: resolveField(row, "phone"),
      "First Name": resolveField(row, "firstName"),
      "Last Name": resolveField(row, "lastName"),
      Company: resolveField(row, "companyName"),
      Notes: (engagement.reply_text || "").slice(0, 500),
    });
  }
  return hot;
}

/**
 * Build dead leads array from engagement data.
 * Includes all bounced and unsubscribed leads.
 * @param {Map} engagementMap
 * @param {Array} masterRows - Master CSV records
 * @returns {Array<Object>} Dead lead rows
 */
function buildDeadLeads(engagementMap, masterRows) {
  const dead = [];
  for (const row of masterRows) {
    const email = resolveField(row, "email").toLowerCase();
    if (!email) continue;
    const engagement = engagementMap.get(email);
    if (!engagement) continue;
    if (
      engagement.smartlead_status !== "bounced" &&
      engagement.smartlead_status !== "unsubscribed"
    )
      continue;

    dead.push({
      email,
      company_name: resolveField(row, "companyName"),
      phone_number: resolveField(row, "phone"),
      website: resolveField(row, "website"),
      smartlead_status: engagement.smartlead_status,
      campaign_id: (engagement.campaign_ids || []).join(";"),
    });
  }
  return dead;
}

// ---------------------------------------------------------------------------
// Main sync logic (called when script is run directly)
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  // Load config
  const config = loadJson(projectPath("5-lifecycle", "sync-config.json")) || {
    campaign_ids: [],
    sync_all_if_empty: true,
  };

  // Determine campaigns to sync
  let campaignIds = config.campaign_ids || [];
  if (campaignIds.length === 0 && config.sync_all_if_empty) {
    const allCampaigns = await listCampaigns();
    campaignIds = allCampaigns.map((c) => c.id);
  }
  console.log(`Syncing ${campaignIds.length} campaigns: ${campaignIds.join(", ")}`);

  // Load checkpoint
  const checkpointPath = projectPath("data", "lifecycle", ".sync_checkpoint.json");
  const checkpoint = loadJson(checkpointPath) || {};
  const lastSyncAt = checkpoint.last_sync_at || null;

  // Pull data from each campaign
  const engagementMap = new Map();
  const totals = { sent: 0, opened: 0, replied: 0, bounced: 0, unsubscribed: 0 };

  // SmartLead API schema:
  // - GET /campaigns/{id}/analytics → aggregate counts (sent_count, open_count, reply_count, bounce_count)
  // - GET /campaigns/{id}/leads → { data: [{campaign_lead_map_id, lead_category_id, status, lead: {id, email, is_unsubscribed, ...}}] }
  //   Lead-level data does NOT include per-lead engagement counts.
  //   lead_category_id (1-9) = leads that have replied (SmartLead sub-categories)
  //   lead_category_id = null = leads that haven't replied
  // - GET /campaigns/{id}/leads/{leadId}/message-history → { history: [{type, email_body, time, open_count}] }

  for (const campaignId of campaignIds) {
    // Get campaign analytics for aggregate totals
    console.log(`  Campaign ${campaignId}:`);
    let analytics;
    try {
      analytics = await getCampaignStats(campaignId);
    } catch (err) {
      console.warn(`    Warning: could not fetch analytics: ${err.message}`);
      analytics = {};
    }

    const campaignSent = parseInt(analytics.unique_sent_count || "0", 10);
    const campaignOpened = parseInt(analytics.unique_open_count || "0", 10);
    const campaignBounced = parseInt(analytics.bounce_count || "0", 10);
    const campaignUnsubscribed = parseInt(analytics.unsubscribed_count || "0", 10);
    console.log(`    Analytics: ${campaignSent} sent, ${campaignOpened} opened, ${campaignBounced} bounced`);

    totals.sent += campaignSent;
    totals.opened += campaignOpened;
    totals.bounced += campaignBounced;
    totals.unsubscribed += campaignUnsubscribed;

    // Pull only categorized leads (categories 1-9 = replied leads)
    // This avoids pulling all 17K+ leads when only ~200 have replied
    let repliedLeads = [];
    for (let catId = 1; catId <= 9; catId++) {
      try {
        const catLeads = await getCampaignLeads(campaignId, 100, catId);
        repliedLeads.push(...catLeads);
      } catch (err) {
        // Category may not exist, that's fine
      }
    }

    const repliedCount = repliedLeads.length;
    totals.replied += repliedCount;
    console.log(`    Replied leads: ${repliedCount}`);

    // For each replied lead, get message history for reply text
    for (const entry of repliedLeads) {
      const leadData = entry.lead || entry;
      const email = (leadData.email || "").toLowerCase();
      if (!email) continue;

      let replyText = "";
      let lastRepliedAt = "";
      let lastSentAt = "";

      try {
        const hist = await getLeadMessageHistory(campaignId, leadData.id);
        const messages = hist.history || hist || [];
        const replies = messages.filter((m) => m.type === "REPLY");
        const sentMsgs = messages.filter((m) => m.type === "SENT");

        if (replies.length > 0) {
          const lastReply = replies[replies.length - 1];
          replyText = (lastReply.email_body || "").replace(/<[^>]+>/g, "").trim();
          lastRepliedAt = lastReply.time || "";
        }
        if (sentMsgs.length > 0) {
          lastSentAt = sentMsgs[sentMsgs.length - 1].time || "";
        }
      } catch (err) {
        console.warn(`    Warning: could not fetch messages for ${email}: ${err.message}`);
      }

      mergeLeadData(engagementMap, {
        email,
        status: "replied",
        last_email_sent_at: lastSentAt,
        last_opened_at: "",
        last_replied_at: lastRepliedAt,
        reply_text: replyText,
        campaign_id: campaignId,
      });
    }

    // Pull all leads to detect unsubscribed (only if campaign has unsubscribes)
    if (campaignUnsubscribed > 0) {
      console.log(`    Scanning for ${campaignUnsubscribed} unsubscribed leads...`);
      const allLeads = await getCampaignLeads(campaignId);
      for (const entry of allLeads) {
        const leadData = entry.lead || entry;
        if (leadData.is_unsubscribed) {
          const email = (leadData.email || "").toLowerCase();
          if (!email) continue;
          mergeLeadData(engagementMap, {
            email,
            status: "unsubscribed",
            last_email_sent_at: "",
            last_opened_at: "",
            last_replied_at: "",
            reply_text: "",
            campaign_id: campaignId,
          });
        }
      }
    }
  }

  // Save raw snapshot
  const ts = timestamp();
  ensureDir(projectPath("data", "lifecycle"));
  saveJson(projectPath("data", "lifecycle", `smartlead_sync_${ts}.json`), {
    generated_at: new Date().toISOString(),
    campaigns_synced: campaignIds,
    totals,
    leads: Object.fromEntries(engagementMap),
  });

  // Load master CSV
  const masterPath = projectPath("data", "upload", "master_enriched_emails.csv");
  const { records: masterRows, columns: masterCols } = readCsv(masterPath);
  console.log(`  Master CSV: ${masterRows.length} rows`);

  // Engagement columns to add/overwrite
  const engagementCols = [
    "smartlead_status",
    "last_email_sent_at",
    "last_opened_at",
    "last_replied_at",
    "reply_text",
  ];

  // Update master rows with engagement data
  for (const row of masterRows) {
    const email = resolveField(row, "email").toLowerCase();
    const engagement = engagementMap.get(email);
    if (engagement) {
      row.smartlead_status = engagement.smartlead_status;
      row.last_email_sent_at = engagement.last_email_sent_at;
      row.last_opened_at = engagement.last_opened_at;
      row.last_replied_at = engagement.last_replied_at;
      row.reply_text = (engagement.reply_text || "").slice(0, 500);
    } else {
      for (const col of engagementCols) {
        if (!row[col]) row[col] = "";
      }
    }
  }

  // Ensure engagement columns appear in output
  const outputCols = [...new Set([...masterCols, ...engagementCols])];

  // Build hot and dead lead CSVs
  const hotLeads = buildHotLeads(engagementMap, masterRows, lastSyncAt);
  const deadLeads = buildDeadLeads(engagementMap, masterRows);

  if (dryRun) {
    console.log("\n[DRY RUN] Would write:");
    console.log(`  Master CSV: ${masterRows.length} rows with engagement columns`);
    console.log(`  Hot leads: ${hotLeads.length}`);
    console.log(`  Dead leads: ${deadLeads.length}`);
  } else {
    // Write updated master
    writeCsv(masterPath, masterRows, outputCols);

    // Write hot leads
    const hotPath = projectPath("data", "lifecycle", "hot_leads.csv");
    writeCsv(hotPath, hotLeads);
    console.log(`  Hot leads written: ${hotLeads.length} → ${hotPath}`);

    // Write dead leads
    const deadPath = projectPath("data", "lifecycle", "dead_leads.csv");
    writeCsv(deadPath, deadLeads);
    console.log(`  Dead leads written: ${deadLeads.length} → ${deadPath}`);

    // Update checkpoint
    saveJson(checkpointPath, { last_sync_at: new Date().toISOString() });
  }

  // Write JSON report
  const report = {
    generated_at: new Date().toISOString(),
    campaigns_synced: campaignIds,
    totals,
    new_replies: hotLeads.length,
    hot_leads: hotLeads.map((h) => h.Email),
    dead_leads_count: deadLeads.length,
  };
  const reportPath = projectPath("data", "reports", `smartlead_sync_${ts}.json`);
  ensureDir(projectPath("data", "reports"));
  saveJson(reportPath, report);

  // Console summary
  console.log(`\nSmartLead Sync Complete — ${new Date().toISOString().slice(0, 10)}`);
  console.log(
    `Today: ${totals.sent} sent, ${totals.opened} opened, ` +
      `${totals.replied} replied, ${totals.bounced} bounced, ${totals.unsubscribed} unsubscribed`
  );
  console.log(`New hot leads for Bryce: ${hotLeads.length}`);
  for (const h of hotLeads) {
    const snippet = h.Notes ? `"${h.Notes.slice(0, 60)}..."` : "";
    const phone = h.Phone ? ` (${h.Phone})` : "";
    console.log(`  - ${h.Company || h.Email}${phone} — ${snippet}`);
  }
  console.log(`Dead leads excluded: ${deadLeads.length}`);

  return { report, hotLeads, deadLeads };
}

// Run if called directly
if (require.main === module) {
  main().catch((err) => {
    console.error("Sync failed:", err);
    process.exit(1);
  });
}

module.exports = {
  STATUS_PRECEDENCE,
  deriveStatus,
  mergeLeadData,
  buildHotLeads,
  buildDeadLeads,
  main,
};
