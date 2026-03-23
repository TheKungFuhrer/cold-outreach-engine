#!/usr/bin/env node
/**
 * Update HTML dashboard artifacts with real pipeline data.
 *
 * Reads actual data from pipeline output files and SmartLead API,
 * then rewrites each dashboard HTML with current numbers.
 *
 * Usage:
 *   node scripts/update-dashboards.js
 *   node scripts/update-dashboards.js --skip-api   # skip SmartLead API calls
 */

const fs = require("fs");
const path = require("path");
const { readCsv, findField } = require("../shared/csv");
const { loadJson, loadJsonl } = require("../shared/progress");
const { projectPath } = require("../shared/utils");

const ARTIFACTS_DIR = projectPath("data", "artifacts");
const SKIP_API = process.argv.includes("--skip-api");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function csvCount(relPath) {
  try {
    const { records } = readCsv(projectPath(relPath));
    return records.length;
  } catch {
    return 0;
  }
}

function fileMtime(relPath) {
  try {
    return fs.statSync(projectPath(relPath)).mtime;
  } catch {
    return null;
  }
}

function fmtDate(date) {
  if (!date) return "—";
  const d = new Date(date);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtNum(n) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toLocaleString("en-US");
}

function latestJsonReport(prefix) {
  const dir = projectPath("data", "reports");
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    return JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf-8"));
  } catch {
    return null;
  }
}

function readHtml(filename) {
  return fs.readFileSync(path.join(ARTIFACTS_DIR, filename), "utf-8");
}

function writeHtml(filename, content) {
  fs.writeFileSync(path.join(ARTIFACTS_DIR, filename), content, "utf-8");
}

/** Replace <!-- PLACEHOLDER -->value with <!-- PLACEHOLDER -->newValue */
function rp(html, placeholder, newValue) {
  const re = new RegExp(`(<!-- ${placeholder} -->)[^<]*`, "g");
  return html.replace(re, `$1${newValue}`);
}

// ---------------------------------------------------------------------------
// Data gathering
// ---------------------------------------------------------------------------

function gatherPipelineCounts() {
  const orig = {
    raw: 17901, // fixed historical
    prefilterRemoved: 3849,
    prefilterPassed: 14052,
    venues: csvCount("data/classified/venues.csv"),
    nonVenues: csvCount("data/classified/non_venues.csv"),
    ambiguous: csvCount("data/classified/ambiguous.csv"),
  };

  const geo1 = {
    raw: csvCount("data/enriched/geolead_net_new.csv"),
    prefilterPassed: 25230, // from session
    venues: csvCount("data/classified_geolead/venues.csv"),
    nonVenues: csvCount("data/classified_geolead/non_venues.csv"),
    ambiguous: csvCount("data/classified_geolead/ambiguous.csv"),
    sonnetVenues: csvCount("data/verified_geolead/venues.csv"),
    sonnetNon: csvCount("data/verified_geolead/non_venues.csv"),
  };

  const geo2 = {
    raw: 263,
    venues: csvCount("data/classified_geolead_batch2/venues.csv"),
    nonVenues: csvCount("data/classified_geolead_batch2/non_venues.csv"),
  };

  const newRaw = geo1.raw + 263; // batch1 + batch2 outstanding leads
  const newPrefilterRemoved = newRaw - geo1.prefilterPassed - geo2.raw + (geo2.raw - 263); // approximate

  const totalVenues = orig.venues + geo1.venues + geo1.sonnetVenues + geo2.venues;
  const totalNon = orig.nonVenues + geo1.nonVenues + geo1.sonnetNon + geo2.nonVenues;

  // Phone counts
  const phone = {
    mobileOrig: csvCount("data/phone_validated/mobile.csv"),
    mobileGeo: csvCount("data/phone_validated_geolead/mobile.csv"),
    landlineOrig: csvCount("data/phone_validated/landline.csv"),
    landlineGeo: csvCount("data/phone_validated_geolead/landline.csv"),
    invalidOrig: csvCount("data/phone_validated/invalid.csv") + csvCount("data/phone_validated/no_phone.csv"),
    invalidGeo: csvCount("data/phone_validated_geolead/invalid.csv") + csvCount("data/phone_validated_geolead/no_phone.csv"),
  };

  return { orig, geo1, geo2, newRaw, totalVenues, totalNon, phone };
}

function gatherEmailEnrichment() {
  // Count AnyMailFinder emails
  let amfOrigCount = 0;
  try {
    const { records } = readCsv(projectPath("data", "anymailfinder", "additional_contacts.csv"));
    const emails = new Set();
    for (const row of records) {
      const str = row.valid_emails || row.emails_found || "";
      for (const e of str.split(";")) {
        const t = e.trim().toLowerCase();
        if (t) emails.add(t);
      }
    }
    amfOrigCount = emails.size;
  } catch {}

  const amfGeoCount = csvCount("data/anymailfinder/geolead_additional_contacts.csv");

  // Master list
  let masterTotal = 0;
  let masterNetNew = 0;
  try {
    const { records } = readCsv(projectPath("data", "upload", "master_enriched_emails.csv"));
    masterTotal = records.length;
    masterNetNew = records.filter((r) => r.in_smartlead !== "yes").length;
  } catch {}

  // Upload state
  let uploadedCount = 0;
  try {
    const entries = loadJsonl(projectPath("data", "reports", ".upload_progress.jsonl"));
    const emails = new Set();
    for (const e of entries) {
      for (const em of e.emails || []) emails.add(em);
    }
    uploadedCount = emails.size;
  } catch {}

  return { amfOrigCount, amfGeoCount, masterTotal, masterNetNew, uploadedCount };
}

function gatherCostData() {
  const report = latestJsonReport("cost_report_");
  if (!report) return { total: 0, haiku: 0, sonnet: 0 };
  return {
    total: report.total_cost || 0,
    haiku: report.haiku?.cost || 0,
    sonnet: report.sonnet?.cost || 0,
    numverifyCalls: report.numverify?.calls || 0,
  };
}

function gatherFreshness() {
  return {
    prefilter: fileMtime("data/filtered/leads.csv"),
    haiku: fileMtime("data/classified_geolead/venues.csv"),
    sonnet: fileMtime("data/verified_geolead/venues.csv"),
    phone: fileMtime("data/phone_validated_geolead/mobile.csv"),
    email: fileMtime("data/anymailfinder/geolead_additional_contacts.csv"),
    upload: fileMtime("data/reports/.upload_progress.jsonl"),
  };
}

async function gatherSmartLeadStats() {
  if (SKIP_API) return null;
  try {
    const { listCampaigns, getCampaignStats } = require("../shared/smartlead");
    const campaigns = await listCampaigns();
    const stats = {};
    for (const c of campaigns) {
      try {
        const s = await getCampaignStats(c.id);
        stats[c.id] = { name: c.name, ...s };
      } catch {}
    }
    return { campaigns, stats };
  } catch (err) {
    console.warn(`  SmartLead API skipped: ${err.message}`);
    return null;
  }
}

function gatherMailboxStatus() {
  return loadJson(projectPath("data", "reports", "mailbox_audit.json"));
}

// ---------------------------------------------------------------------------
// Dashboard updaters
// ---------------------------------------------------------------------------

function updatePipelineDashboard(data, emails) {
  let html = readHtml("cold_outreach_pipeline_final_v8.html");
  const p = data;
  const newVenues = p.geo1.venues + p.geo1.sonnetVenues + p.geo2.venues;
  const newNon = p.geo1.nonVenues + p.geo1.sonnetNon + p.geo2.nonVenues;
  const newPrefilterPassed = p.geo1.prefilterPassed + p.geo2.raw;
  const newPrefilterRemoved = p.newRaw - newPrefilterPassed;
  const totalPrefilterRemoved = p.orig.prefilterRemoved + newPrefilterRemoved;
  const totalPrefilterPassed = p.orig.prefilterPassed + newPrefilterPassed;
  const totalClassified = p.totalVenues + p.totalNon;

  // Row 1: Raw scraped leads
  html = html.replace(/>17,901</, `>${fmtNum(p.orig.raw)}<`);
  html = html.replace(/>26,802</, `>${fmtNum(p.newRaw)}<`);
  html = html.replace(/>44,703</, `>${fmtNum(p.orig.raw + p.newRaw)}<`);

  // Row 2: Pre-filter removed
  html = html.replace(/>-3,849</, `>-${fmtNum(p.orig.prefilterRemoved)}<`);
  html = html.replace(/>-1,309</, `>-${fmtNum(newPrefilterRemoved)}<`);
  html = html.replace(/>-5,158</, `>-${fmtNum(totalPrefilterRemoved)}<`);

  // Row 3: Leads passed to Haiku
  html = html.replace(/>14,052</, `>${fmtNum(p.orig.prefilterPassed)}<`);
  html = html.replace(/>25,493</, `>${fmtNum(newPrefilterPassed)}<`);
  html = html.replace(/>39,545</, `>${fmtNum(totalPrefilterPassed)}<`);

  // Classification total
  html = html.replace(/>39,469<\/td>/, `>${fmtNum(totalClassified)}</td>`);

  // Confirmed venues
  html = html.replace(/>8,958</, `>${fmtNum(p.orig.venues)}<`);
  html = html.replace(/>15,086</, `>${fmtNum(newVenues)}<`);
  html = html.replace(/>24,044</, `>${fmtNum(p.totalVenues)}<`);

  // Confirmed non-venues
  html = html.replace(/>5,094</, `>${fmtNum(p.orig.nonVenues)}<`);
  html = html.replace(/>10,407</, `>${fmtNum(newNon)}<`);
  html = html.replace(/>15,425</, `>${fmtNum(p.totalNon)}<`);

  // Sonnet
  html = html.replace(/\+29 venues, \+57 non/, `+${p.geo1.sonnetVenues} venues, +${p.geo1.sonnetNon} non`);
  html = html.replace(/86 resolved/, `${p.geo1.sonnetVenues + p.geo1.sonnetNon} resolved`);

  // AnyMailFinder emails
  html = html.replace(/>50,448</, `>${fmtNum(emails.amfOrigCount)}<`);
  html = html.replace(/>40,504</, `>${fmtNum(emails.amfGeoCount)}<`);
  html = html.replace(/>90,952</g, `>${fmtNum(emails.amfOrigCount + emails.amfGeoCount)}<`);

  // Total unique venue emails
  html = html.replace(/>~107,538</, `>${fmtNum(emails.masterTotal)}<`);

  // Already uploaded
  html = html.replace(/>16,586</g, `>${fmtNum(emails.uploadedCount)}<`);

  // Net-new ready for upload
  html = html.replace(/>~90,952</, `>${fmtNum(emails.masterNetNew)}<`);

  // Venues without domains
  html = html.replace(/>~7,458</g, `>${fmtNum(p.totalVenues - emails.uploadedCount)}<`);

  // Phone breakdown
  html = html.replace(/>1,799</, `>${fmtNum(p.phone.mobileOrig)}<`);
  html = html.replace(/>3,945</, `>${fmtNum(p.phone.mobileGeo)}<`);
  html = html.replace(/>5,744</, `>${fmtNum(p.phone.mobileOrig + p.phone.mobileGeo)}<`);
  html = html.replace(/>6,263</, `>${fmtNum(p.phone.landlineOrig)}<`);
  html = html.replace(/>9,933</, `>${fmtNum(p.phone.landlineGeo)}<`);
  html = html.replace(/>16,196</, `>${fmtNum(p.phone.landlineOrig + p.phone.landlineGeo)}<`);
  html = html.replace(/>896</, `>${fmtNum(p.phone.invalidOrig)}<`);
  html = html.replace(/>1,001</, `>${fmtNum(p.phone.invalidGeo)}<`);
  html = html.replace(/>1,897</, `>${fmtNum(p.phone.invalidOrig + p.phone.invalidGeo)}<`);

  writeHtml("cold_outreach_pipeline_final_v8.html", html);
  return true;
}

function updateCostDashboard(costs, pipeline, emails) {
  let html = readHtml("cost-report-dashboard.html");
  const totalSpend = costs.total || 0;
  const venues = pipeline.totalVenues || 1;
  const totalEmails = emails.masterTotal || 1;

  html = rp(html, "TIMESTAMP", fmtDate(new Date()));
  html = rp(html, "TOTAL_SPEND", `$${totalSpend.toFixed(2)}`);
  html = rp(html, "COST_PER_VENUE", `$${(totalSpend / venues).toFixed(4)}`);
  html = rp(html, "COST_PER_EMAIL", `$${(totalSpend / totalEmails).toFixed(4)}`);
  html = rp(html, "COST_PER_APPT", "TBD");
  html = rp(html, "HAIKU_COST", `~$${costs.haiku.toFixed(2)}`);
  html = rp(html, "SONNET_COST", `~$${costs.sonnet.toFixed(2)}`);
  html = rp(html, "NUMVERIFY_COST", `~$${((costs.numverifyCalls || 0) * 0.001).toFixed(2)}`);
  html = rp(html, "AMF_COST", "$0.00");
  html = rp(html, "SL_VERIFY_USED", "0 / 80,000");
  html = rp(html, "TOTAL_SPEND_2", `~$${totalSpend.toFixed(2)}`);

  // Update sub-text counts
  html = html.replace(/24,044 venues classified/, `${fmtNum(venues)} venues classified`);
  html = html.replace(/~107,538 unique emails/, `~${fmtNum(totalEmails)} unique emails`);
  html = html.replace(/~39,545 leads/, `~${fmtNum(pipeline.totalVenues + pipeline.totalNon)} leads`);
  html = html.replace(/~24,044 venues/, `~${fmtNum(venues)} venues`);

  writeHtml("cost-report-dashboard.html", html);
  return true;
}

function updateCampaignDashboard(sl) {
  let html = readHtml("campaign-performance-tracker.html");
  html = rp(html, "TIMESTAMP", fmtDate(new Date()));

  if (!sl || !sl.stats) {
    writeHtml("campaign-performance-tracker.html", html);
    return true;
  }

  // Aggregate stats across campaigns
  let totalSent = 0, totalOpens = 0, totalReplies = 0, totalBounces = 0;

  // Campaign mapping by known IDs
  const campMap = {
    2434779: { prefix: "CAMP1" },
    3071191: { prefix: "CAMP2" },
    3071192: { prefix: "CAMP3" },
  };

  for (const [id, info] of Object.entries(sl.stats)) {
    const sent = parseInt(info.sent_count || info.emails_sent || 0);
    const opens = parseInt(info.open_count || info.opens || 0);
    const replies = parseInt(info.reply_count || info.replies || 0);
    const bounces = parseInt(info.bounce_count || info.bounces || 0);
    const leads = info.campaign_lead_stats?.total || parseInt(info.total_count || 0);

    totalSent += sent;
    totalOpens += opens;
    totalReplies += replies;
    totalBounces += bounces;

    const camp = campMap[id];
    if (camp) {
      html = rp(html, `${camp.prefix}_LEADS`, leads ? fmtNum(leads) : "—");
      html = rp(html, `${camp.prefix}_SENT`, sent ? fmtNum(sent) : "—");
      html = rp(html, `${camp.prefix}_OPENED`, opens ? fmtNum(opens) : "—");
      html = rp(html, `${camp.prefix}_REPLIED`, replies ? fmtNum(replies) : "—");
      html = rp(html, `${camp.prefix}_BOUNCED`, bounces ? fmtNum(bounces) : "—");
    }
  }

  // KPI cards
  html = rp(html, "SENT", totalSent ? fmtNum(totalSent) : "—");
  html = rp(html, "OPEN_RATE", totalSent ? `${((totalOpens / totalSent) * 100).toFixed(1)}%` : "—");
  html = rp(html, "REPLY_RATE", totalSent ? `${((totalReplies / totalSent) * 100).toFixed(1)}%` : "—");
  html = rp(html, "BOUNCE_RATE", totalSent ? `${((totalBounces / totalSent) * 100).toFixed(1)}%` : "—");

  writeHtml("campaign-performance-tracker.html", html);
  return true;
}

function updateLeadSourceDashboard(pipeline) {
  let html = readHtml("lead-source-quality.html");
  html = rp(html, "TIMESTAMP", fmtDate(new Date()));

  // Pipeline efficiency table — update GeoLead batch 2 venue count
  html = html.replace(
    /(<td>GeoLead batch 2<\/td>[\s\S]*?<td class="num teal">)207/,
    `$1${pipeline.geo2.venues}`
  );

  writeHtml("lead-source-quality.html", html);
  return true;
}

function updateFreshnessDashboard(freshness, pipeline, emails, sl) {
  let html = readHtml("pipeline-freshness-dashboard.html");

  html = rp(html, "TIMESTAMP", fmtDate(new Date()));
  html = rp(html, "LAST_RUN", fmtDate(freshness.upload));
  html = rp(html, "LAST_RUN_AGO", freshness.upload ? timeAgo(freshness.upload) : "never run end-to-end");
  html = rp(html, "CRON_STATUS", "not configured");
  html = rp(html, "CRON_LAST", "pending setup");

  // Skool sync
  const skoolSync = loadJson(projectPath("data", "sync", "last-import.json"));
  html = rp(html, "SKOOL_LAST", skoolSync ? fmtDate(skoolSync.timestamp || skoolSync.last_sync) : "—");
  html = rp(html, "SKOOL_AGO", skoolSync ? timeAgo(skoolSync.timestamp || skoolSync.last_sync) : "check data/sync/last-import.json");

  // Pipeline stage timestamps
  html = rp(html, "PREFILTER_LAST", fmtDate(freshness.prefilter));
  html = rp(html, "HAIKU_LAST", fmtDate(freshness.haiku));
  html = rp(html, "SONNET_LAST", fmtDate(freshness.sonnet));
  html = rp(html, "PHONE_LAST", fmtDate(freshness.phone));
  html = rp(html, "EMAIL_LAST", fmtDate(freshness.email));
  html = rp(html, "UPLOAD_LAST", fmtDate(freshness.upload));
  html = rp(html, "VERIFY_QUEUE", `${fmtNum(emails.uploadedCount)} leads`);
  html = rp(html, "SKOOL_SYNC_LAST", skoolSync ? fmtDate(skoolSync.timestamp || skoolSync.last_sync) : "Mar 2026");

  // Queue visualization — update SmartLead upload bar
  const uploaded = emails.uploadedCount;
  const pending = emails.masterNetNew;
  const total = uploaded + pending;
  if (total > 0) {
    const uploadPct = ((uploaded / total) * 100).toFixed(1);
    const pendingPct = ((pending / total) * 100).toFixed(1);

    // Update upload bar
    html = html.replace(
      /SmartLead upload \([^)]+\)/,
      `SmartLead upload (${fmtNum(uploaded)} uploaded / ${fmtNum(pending)} pending)`
    );
    html = html.replace(
      /width: 25\.3%; background: #0F6E56;">28,335/,
      `width: ${uploadPct}%; background: #0F6E56;">${fmtNum(uploaded)}`
    );
    html = html.replace(
      /width: 74\.7%; background: #BA7517;">83,709/,
      `width: ${pendingPct}%; background: #BA7517;">${fmtNum(pending)}`
    );
  }

  // Update classification count in queue bar
  const totalClassified = pipeline.totalVenues + pipeline.totalNon;
  html = html.replace(
    /Classification \([^)]+\)/,
    `Classification (${fmtNum(totalClassified)} / ${fmtNum(totalClassified)})`
  );
  html = html.replace(
    /width: 100%; background: #0F6E56;">39,469/,
    `width: 100%; background: #0F6E56;">${fmtNum(totalClassified)}`
  );

  // Update processed counts in stage table
  html = html.replace(/>39,545<\/td>\s*<td/g, `>${fmtNum(pipeline.orig.prefilterPassed + pipeline.geo1.prefilterPassed + pipeline.geo2.raw)}</td>\n  <td`);

  writeHtml("pipeline-freshness-dashboard.html", html);
  return true;
}

function timeAgo(date) {
  if (!date) return "—";
  const d = new Date(date);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs > 1 ? "s" : ""} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Updating Dashboard Artifacts ===\n");

  // Gather data
  console.log("Gathering data...");
  const pipeline = gatherPipelineCounts();
  const emails = gatherEmailEnrichment();
  const costs = gatherCostData();
  const freshness = gatherFreshness();
  const mailbox = gatherMailboxStatus();

  let sl = null;
  if (!SKIP_API) {
    console.log("  Fetching SmartLead stats...");
    sl = await gatherSmartLeadStats();
  }

  console.log(`  Pipeline: ${fmtNum(pipeline.totalVenues)} venues, ${fmtNum(pipeline.totalNon)} non-venues`);
  console.log(`  Emails: ${fmtNum(emails.masterTotal)} total, ${fmtNum(emails.uploadedCount)} uploaded, ${fmtNum(emails.masterNetNew)} net-new`);
  console.log(`  Costs: $${costs.total.toFixed(2)} total spend`);
  console.log();

  // Update each dashboard
  const results = [];

  try {
    updatePipelineDashboard(pipeline, emails);
    results.push("cold_outreach_pipeline_final_v8.html — updated");
  } catch (err) {
    results.push(`cold_outreach_pipeline_final_v8.html — FAILED: ${err.message}`);
  }

  try {
    updateCostDashboard(costs, pipeline, emails);
    results.push("cost-report-dashboard.html — updated");
  } catch (err) {
    results.push(`cost-report-dashboard.html — FAILED: ${err.message}`);
  }

  try {
    updateCampaignDashboard(sl);
    results.push("campaign-performance-tracker.html — updated");
  } catch (err) {
    results.push(`campaign-performance-tracker.html — FAILED: ${err.message}`);
  }

  try {
    updateLeadSourceDashboard(pipeline);
    results.push("lead-source-quality.html — updated");
  } catch (err) {
    results.push(`lead-source-quality.html — FAILED: ${err.message}`);
  }

  try {
    updateFreshnessDashboard(freshness, pipeline, emails, sl);
    results.push("pipeline-freshness-dashboard.html — updated");
  } catch (err) {
    results.push(`pipeline-freshness-dashboard.html — FAILED: ${err.message}`);
  }

  console.log("--- Results ---");
  for (const r of results) {
    console.log(`  ${r}`);
  }
  console.log(`\nDashboards saved to ${ARTIFACTS_DIR}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
