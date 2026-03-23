/**
 * Mailbox Audit — Pull all connected email accounts from SmartLead,
 * map campaign assignments, collect warmup stats, and export signatures.
 *
 * Output: data/reports/mailbox_audit.json
 *
 * NOTE: SmartLead API does NOT expose per-account send/open/reply/bounce
 * stats for campaigns. Campaign analytics are aggregate only. We include
 * warmup stats (the only per-account metrics available) and campaign-level
 * aggregates for reference.
 */

const { apiRequest, listCampaigns } = require("../shared/smartlead");
const { ensureDir, projectPath, timestamp } = require("../shared/utils");
const fs = require("fs");

// -------------------------------------------------------------------------
// API helpers (endpoints not yet in shared/smartlead.js)
// -------------------------------------------------------------------------

async function listEmailAccounts() {
  return apiRequest("GET", "/email-accounts");
}

async function getEmailAccount(id) {
  return apiRequest("GET", `/email-accounts/${id}`);
}

async function getWarmupStats(emailAccountId) {
  return apiRequest("GET", `/email-accounts/${emailAccountId}/warmup-stats`);
}

async function getCampaignEmailAccounts(campaignId) {
  return apiRequest("GET", `/campaigns/${campaignId}/email-accounts`);
}

async function getCampaignAnalytics(campaignId) {
  return apiRequest("GET", `/campaigns/${campaignId}/analytics`);
}

// -------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------

async function main() {
  console.log("=== SmartLead Mailbox Audit ===\n");

  // Step 1: Fetch all email accounts
  console.log("1. Fetching email accounts...");
  const accounts = await listEmailAccounts();
  console.log(`   Found ${accounts.length} email accounts.\n`);

  // Step 2: Fetch all campaigns
  console.log("2. Fetching campaigns...");
  const campaigns = await listCampaigns();
  console.log(`   Found ${campaigns.length} campaigns.\n`);

  // Step 3: For each campaign, get assigned email accounts → build reverse map
  console.log("3. Mapping email accounts to campaigns...");
  const accountCampaignMap = {}; // emailAccountId → [{ id, name }]
  const campaignAnalyticsMap = {}; // campaignId → analytics

  for (const campaign of campaigns) {
    const cid = campaign.id;
    const cname = campaign.name || `Campaign ${cid}`;
    process.stdout.write(`   Campaign ${cid}: ${cname}...`);

    try {
      const emailAccounts = await getCampaignEmailAccounts(cid);
      const analytics = await getCampaignAnalytics(cid);

      campaignAnalyticsMap[cid] = {
        id: cid,
        name: cname,
        status: campaign.status,
        ...normalizeAnalytics(analytics),
      };

      for (const ea of emailAccounts) {
        if (!accountCampaignMap[ea.id]) accountCampaignMap[ea.id] = [];
        accountCampaignMap[ea.id].push({ id: cid, name: cname, status: campaign.status });
      }
      console.log(` ${emailAccounts.length} accounts`);
    } catch (err) {
      console.log(` ERROR: ${err.message}`);
    }
  }
  console.log();

  // Step 4: Fetch warmup stats per account
  console.log("4. Fetching warmup stats per account...");
  const warmupMap = {};
  for (const account of accounts) {
    try {
      const stats = await getWarmupStats(account.id);
      warmupMap[account.id] = stats;
    } catch (err) {
      warmupMap[account.id] = { error: err.message };
    }
  }
  console.log(`   Done.\n`);

  // Step 5: Assemble audit records
  console.log("5. Assembling audit records...");
  const auditRecords = accounts.map((acct) => {
    const warmup = warmupMap[acct.id] || {};
    const assignedCampaigns = accountCampaignMap[acct.id] || [];
    const warmupDetails = acct.warmup_details || {};

    return {
      id: acct.id,
      from_name: acct.from_name,
      from_email: acct.from_email,
      type: acct.type,

      // Connection health
      smtp_connected: acct.is_smtp_success || false,
      imap_connected: acct.is_imap_success || false,
      smtp_error: acct.smtp_failure_error || null,
      imap_error: acct.imap_failure_error || null,

      // Sending config
      message_per_day: acct.message_per_day,
      daily_sent_count: acct.daily_sent_count,
      custom_tracking_domain: acct.custom_tracking_domain || null,

      // Warmup status
      warmup: {
        status: warmupDetails.status || "UNKNOWN",
        reputation: warmupDetails.warmup_reputation || null,
        total_sent: parseInt(warmup.sent_count, 10) || 0,
        total_spam: parseInt(warmup.spam_count, 10) || 0,
        inbox_count: parseInt(warmup.inbox_count, 10) || 0,
        warmup_received: parseInt(warmup.warmup_email_received_count, 10) || 0,
        reply_rate: warmupDetails.reply_rate ?? null,
        blocked_reason: warmupDetails.blocked_reason || null,
        daily_breakdown: warmup.stats_by_date || [],
      },

      // Warmup deliverability metrics (calculated)
      warmup_deliverability: calculateWarmupDeliverability(warmup),

      // Campaign assignments
      campaign_count: assignedCampaigns.length,
      campaigns: assignedCampaigns,

      // Signature
      has_signature: acct.signature != null && acct.signature.length > 0,
      signature_html: acct.signature || null,

      // Activity flag — no campaigns + no warmup sends = inactive candidate
      appears_inactive:
        assignedCampaigns.length === 0 &&
        (parseInt(warmup.sent_count, 10) || 0) === 0 &&
        acct.daily_sent_count === 0,
    };
  });

  // Sort: inactive first, then by campaign count ascending
  auditRecords.sort((a, b) => {
    if (a.appears_inactive !== b.appears_inactive)
      return a.appears_inactive ? -1 : 1;
    return a.campaign_count - b.campaign_count;
  });

  // Step 6: Summary stats
  const summary = {
    total_accounts: auditRecords.length,
    smtp_type: auditRecords.filter((a) => a.type === "SMTP").length,
    gmail_type: auditRecords.filter((a) => a.type === "GMAIL").length,
    smtp_connected: auditRecords.filter((a) => a.smtp_connected).length,
    smtp_disconnected: auditRecords.filter((a) => !a.smtp_connected).length,
    imap_connected: auditRecords.filter((a) => a.imap_connected).length,
    imap_disconnected: auditRecords.filter((a) => !a.imap_connected).length,
    warmup_active: auditRecords.filter((a) => a.warmup.status === "ACTIVE").length,
    warmup_inactive: auditRecords.filter((a) => a.warmup.status !== "ACTIVE").length,
    with_signature: auditRecords.filter((a) => a.has_signature).length,
    without_signature: auditRecords.filter((a) => !a.has_signature).length,
    appears_inactive: auditRecords.filter((a) => a.appears_inactive).length,
    assigned_to_campaigns: auditRecords.filter((a) => a.campaign_count > 0).length,
  };

  // Step 7: Write output
  const output = {
    generated_at: new Date().toISOString(),
    summary,
    campaign_analytics: Object.values(campaignAnalyticsMap),
    accounts: auditRecords,
    _notes: {
      per_account_campaign_stats:
        "SmartLead API does NOT provide per-email-account send/open/reply/bounce " +
        "stats for campaigns. Campaign analytics (/campaigns/{id}/analytics) are " +
        "aggregate across all accounts. The warmup_deliverability metrics reflect " +
        "warmup email performance only, not campaign sends.",
      inactive_flag:
        "appears_inactive is true when an account has 0 campaign assignments, " +
        "0 warmup sends, and 0 daily sends. Verify in SmartLead UI before removing.",
      signatures:
        "signature_html contains raw HTML. 'has_signature' is a convenience boolean.",
    },
  };

  const outDir = projectPath("data", "reports");
  ensureDir(outDir);
  const outPath = projectPath("data", "reports", "mailbox_audit.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n=== Audit complete ===`);
  console.log(`Output: ${outPath}`);
  printSummary(summary);
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function normalizeAnalytics(analytics) {
  // SmartLead analytics response shape varies; normalize what we can
  if (!analytics || typeof analytics !== "object") return {};
  return {
    sent: analytics.sent_count ?? analytics.sent ?? 0,
    opened: analytics.open_count ?? analytics.opened ?? 0,
    clicked: analytics.click_count ?? analytics.clicked ?? 0,
    replied: analytics.reply_count ?? analytics.replied ?? 0,
    bounced: analytics.bounce_count ?? analytics.bounced ?? 0,
    unsubscribed: analytics.unsubscribe_count ?? analytics.unsubscribed ?? 0,
    open_rate: safeRate(analytics.open_count ?? analytics.opened, analytics.sent_count ?? analytics.sent),
    reply_rate: safeRate(analytics.reply_count ?? analytics.replied, analytics.sent_count ?? analytics.sent),
    bounce_rate: safeRate(analytics.bounce_count ?? analytics.bounced, analytics.sent_count ?? analytics.sent),
  };
}

function calculateWarmupDeliverability(warmup) {
  if (!warmup || !warmup.sent_count) return null;
  const sent = parseInt(warmup.sent_count, 10) || 0;
  const spam = parseInt(warmup.spam_count, 10) || 0;
  const inbox = parseInt(warmup.inbox_count, 10) || 0;
  if (sent === 0) return null;

  return {
    inbox_rate: round((inbox / sent) * 100),
    spam_rate: round((spam / sent) * 100),
    inbox_placement: `${inbox}/${sent}`,
  };
}

function safeRate(numerator, denominator) {
  const n = Number(numerator) || 0;
  const d = Number(denominator) || 0;
  if (d === 0) return null;
  return round((n / d) * 100);
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function printSummary(s) {
  console.log(`
  Total accounts:       ${s.total_accounts}
  SMTP / Gmail:         ${s.smtp_type} / ${s.gmail_type}
  SMTP connected:       ${s.smtp_connected} (${s.smtp_disconnected} disconnected)
  IMAP connected:       ${s.imap_connected} (${s.imap_disconnected} disconnected)
  Warmup active:        ${s.warmup_active} (${s.warmup_inactive} inactive)
  With signature:       ${s.with_signature} (${s.without_signature} without)
  Assigned to campaigns: ${s.assigned_to_campaigns}
  Appears inactive:     ${s.appears_inactive}
  `);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
