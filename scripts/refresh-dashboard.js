/**
 * Refresh Dashboard Data
 *
 * Reads all pipeline source files and writes data/artifacts/dashboard-data.json.
 * Called by dashboard-server.js on page load and by daily-sync.js before email.
 *
 * Usage: node scripts/refresh-dashboard.js
 */

const fs = require("fs");
const path = require("path");
const { projectPath, ensureDir } = require("../shared/utils");
const { loadJson, saveJson } = require("../shared/progress");
const { readCsv } = require("../shared/csv");
const ARTIFACTS_DIR = projectPath("data", "artifacts");

/**
 * Find the latest file matching a glob-like pattern (simple timestamp sort).
 * Pattern: "prefix_*.ext" where * matches the timestamp portion.
 * @param {string} relPattern - Relative pattern like "data/reports/funnel_report_*.json"
 * @returns {string|null} Absolute path to latest file, or null
 */
function latestFile(relPattern) {
  const dir = projectPath(path.dirname(relPattern));
  const base = path.basename(relPattern);
  const [prefix, ext] = base.split("*");

  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith(ext))
    .sort()
    .reverse();

  return files.length > 0 ? path.join(dir, files[0]) : null;
}

// --- Funnel ---

const FUNNEL_STAGE_MAP = {
  "GeoLead net-new": "raw",
  "Post pre-filter": "filtered",
  "Classified venues": "classified",
  "Phone: mobile": "validated_mobile",
  "Phone: landline": "validated_landline",
  "Phone: invalid": "validated_invalid",
  "Phone: no phone": "validated_no_phone",
};

// Simplified funnel stages for the dashboard
const DASHBOARD_STAGES = ["raw", "filtered", "classified", "validated", "uploaded", "in_campaign"];

function buildFunnel(funnelReport, masterMap) {
  const stageCounts = {};

  // From funnel report
  if (funnelReport && funnelReport.stages) {
    for (const s of funnelReport.stages) {
      const mapped = FUNNEL_STAGE_MAP[s.name];
      if (mapped) {
        if (mapped.startsWith("validated_")) {
          stageCounts.validated = (stageCounts.validated || 0) + s.count;
        } else {
          stageCounts[mapped] = s.count;
        }
      }
    }
  }

  // From master map if available — uploaded and in_campaign
  if (masterMap) {
    let uploaded = 0, inCampaign = 0;
    for (const [, emails] of masterMap) {
      for (const [, record] of emails) {
        const stage = record.pipeline_stage;
        if (stage === "uploaded" || stage === "in_campaign") uploaded++;
        if (stage === "in_campaign") inCampaign++;
      }
    }
    stageCounts.uploaded = uploaded;
    stageCounts.in_campaign = inCampaign;
  }

  const stages = [];
  let prev = null;
  for (const name of DASHBOARD_STAGES) {
    const count = stageCounts[name] || 0;
    const conversionRate = prev !== null && prev > 0 ? +(count / prev).toFixed(3) : null;
    stages.push({ name, count, conversionRate });
    prev = count;
  }

  return { stages };
}

// --- Campaigns ---

function buildCampaigns(statsReport) {
  if (!statsReport || !statsReport.campaigns) return [];

  return statsReport.campaigns.map(c => {
    // SmartLead API returns string-typed count fields
    const sent = Number(c.sent_count) || 0;
    const opened = Number(c.open_count) || 0;
    const replied = Number(c.reply_count) || 0;
    const bounced = Number(c.bounce_count) || 0;

    return {
      name: c.name,
      id: Number(c.id),
      sent,
      opened,
      replied,
      bounced,
      openRate: sent > 0 ? +(opened / sent).toFixed(3) : 0,
      replyRate: sent > 0 ? +(replied / sent).toFixed(3) : 0,
      bounceRate: sent > 0 ? +(bounced / sent).toFixed(3) : 0,
    };
  });
}

// --- Score Distribution ---

function buildScoreDistribution(scoredRows) {
  const buckets = Array.from({ length: 10 }, (_, i) => ({
    range: `${i * 10 + 1}-${(i + 1) * 10}`,
    count: 0,
  }));

  const scores = scoredRows
    .map(r => Number(r.score))
    .filter(s => s > 0 && s <= 100);

  for (const s of scores) {
    const idx = Math.min(Math.floor((s - 1) / 10), 9);
    buckets[idx].count++;
  }

  scores.sort((a, b) => a - b);
  const mean = scores.length > 0 ? +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : 0;
  const median = scores.length > 0
    ? scores.length % 2 === 0
      ? +((scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2).toFixed(1)
      : scores[Math.floor(scores.length / 2)]
    : 0;

  return { buckets, mean, median };
}

// --- Hot Leads ---

/**
 * @param {object} syncData - SmartLead sync JSON
 * @param {object[]} scoredRows - Scored venues CSV rows
 * @param {Map|null} masterMap - Master lead map
 * @param {string|null} lastSyncAt - ISO timestamp of the PREVIOUS sync run.
 *   When called from daily-sync.js, this comes from the sync report's generated_at.
 *   When called standalone (refresh only), falls back to 24 hours ago.
 */
function buildHotLeads(syncData, scoredRows, masterMap, lastSyncAt) {
  if (!syncData || !syncData.leads) return [];

  // Build score lookup by email
  const scoreByEmail = new Map();
  const scoreByDomain = new Map();
  for (const row of scoredRows) {
    const email = (row.email || "").toLowerCase().trim();
    const domain = (row.website || "").toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, "").replace(/\/.*/, "");
    if (email) scoreByEmail.set(email, Number(row.score) || 0);
    if (domain) scoreByDomain.set(domain, Number(row.score) || 0);
  }

  // Default to 24h ago if no lastSyncAt provided (standalone refresh)
  const cutoff = lastSyncAt ? new Date(lastSyncAt) : new Date(Date.now() - 24 * 60 * 60 * 1000);

  const hot = [];
  for (const [email, lead] of Object.entries(syncData.leads)) {
    if (!lead.last_replied_at) continue;
    const repliedAt = new Date(lead.last_replied_at);
    if (repliedAt <= cutoff) continue;

    // Look up company/phone from master
    let company = "", phone = "";
    if (masterMap) {
      const domain = email.split("@")[1] || "";
      const domainMap = masterMap.get(domain);
      if (domainMap) {
        const record = domainMap.get(email) || domainMap.values().next().value;
        company = record?.company_name || record?.company || "";
        phone = record?.phone || "";
      }
    }

    const score = scoreByEmail.get(email) || scoreByDomain.get(email.split("@")[1] || "") || 0;

    hot.push({
      company,
      phone,
      email,
      replyPreview: (lead.reply_text || "").slice(0, 120),
      repliedAt: lead.last_replied_at,
      score,
    });
  }

  return hot.sort((a, b) => b.score - a.score);
}

// --- Dead Leads ---

function buildDeadLeads(syncData) {
  if (!syncData || !syncData.leads) return { bounced: 0, unsubscribed: 0, total: 0 };

  let bounced = 0, unsubscribed = 0;
  for (const lead of Object.values(syncData.leads)) {
    if (lead.smartlead_status === "bounced") bounced++;
    if (lead.smartlead_status === "unsubscribed") unsubscribed++;
  }

  return { bounced, unsubscribed, total: bounced + unsubscribed };
}

// --- Costs ---

function buildCosts(costReport) {
  if (!costReport) return { perStage: [], totalSpend: 0 };

  const perStage = [];
  const stages = ["haiku", "sonnet", "numverify", "smartlead_verification"];

  for (const stage of stages) {
    const data = costReport[stage];
    if (!data) continue;
    const records = data.records || data.calls || 0;
    const cost = data.cost || 0;
    perStage.push({
      stage,
      costPerLead: records > 0 ? +(cost / records).toFixed(4) : 0,
      totalCost: +cost.toFixed(2),
    });
  }

  return {
    perStage,
    totalSpend: +(costReport.total_cost || 0).toFixed(2),
  };
}

// --- Freshness ---

function buildFreshness(funnel) {
  if (!funnel || !funnel.stages) return { stages: [] };

  const stages = [];
  for (let i = 0; i < funnel.stages.length - 1; i++) {
    const current = funnel.stages[i];
    const next = funnel.stages[i + 1];
    const unprocessed = Math.max(0, current.count - next.count);

    // Check oldest file modification time in the stage directory
    const stageDirs = {
      raw: "data/enriched",
      filtered: "data/filtered",
      classified: "data/classified",
      validated: "data/phone_validated",
      uploaded: "data/upload",
    };
    let oldestDays = 0;
    const dir = stageDirs[current.name];
    if (dir) {
      const fullDir = projectPath(dir);
      try {
        const files = fs.readdirSync(fullDir).filter(f => f.endsWith(".csv"));
        if (files.length > 0) {
          const oldest = files
            .map(f => fs.statSync(path.join(fullDir, f)).mtimeMs)
            .reduce((min, t) => Math.min(min, t), Infinity);
          oldestDays = Math.floor((Date.now() - oldest) / (1000 * 60 * 60 * 24));
        }
      } catch (e) { /* dir may not exist */ }
    }

    stages.push({
      name: current.name,
      unprocessedCount: unprocessed,
      oldestDays,
    });
  }

  return { stages };
}

// --- Source Quality ---

function buildSourceQuality(masterMap, scoreByEmail) {
  if (!masterMap) return { bySource: [], byDetail: [] };

  const srcGroups = new Map();
  const detailGroups = new Map();

  for (const [, emails] of masterMap) {
    for (const [email, record] of emails) {
      const source = record.source || "unknown";
      const detail = record.source_detail || "unknown";
      const score = scoreByEmail?.get(email) || 0;
      const inCampaign = record.pipeline_stage === "in_campaign" ? 1 : 0;

      if (!srcGroups.has(source)) srcGroups.set(source, { count: 0, scoreSum: 0, converted: 0 });
      const sg = srcGroups.get(source);
      sg.count++;
      sg.scoreSum += score;
      sg.converted += inCampaign;

      if (detail !== "unknown") {
        if (!detailGroups.has(detail)) detailGroups.set(detail, { count: 0, scoreSum: 0, converted: 0 });
        const dg = detailGroups.get(detail);
        dg.count++;
        dg.scoreSum += score;
        dg.converted += inCampaign;
      }
    }
  }

  const bySource = [...srcGroups.entries()].map(([source, g]) => ({
    source,
    count: g.count,
    avgScore: g.count > 0 ? +(g.scoreSum / g.count).toFixed(1) : 0,
    conversionRate: g.count > 0 ? +(g.converted / g.count).toFixed(3) : 0,
  }));

  const byDetail = [...detailGroups.entries()]
    .map(([searchTerm, g]) => ({
      searchTerm,
      count: g.count,
      avgScore: g.count > 0 ? +(g.scoreSum / g.count).toFixed(1) : 0,
      conversionRate: g.count > 0 ? +(g.converted / g.count).toFixed(3) : 0,
    }))
    .sort((a, b) => b.avgScore - a.avgScore);

  return { bySource, byDetail };
}

// --- Full Refresh ---

/**
 * @param {object} [options]
 * @param {string} [options.lastSyncAt] - ISO timestamp of previous sync. Passed from daily-sync.js
 *   to ensure hot leads are calculated relative to the correct baseline (before checkpoint update).
 *   When omitted (standalone refresh), defaults to 24h ago inside buildHotLeads.
 */
async function refresh({ lastSyncAt } = {}) {
  ensureDir(ARTIFACTS_DIR);
  console.log("Refreshing dashboard data...");

  // Load all source files
  const funnelPath = latestFile("data/reports/funnel_report_*.json");
  const funnelReport = funnelPath ? loadJson(funnelPath) : null;

  const statsPath = latestFile("data/reports/campaign_stats_*.json");
  const statsReport = statsPath ? loadJson(statsPath) : null;

  const costPath = latestFile("data/reports/cost_report_*.json");
  const costReport = costPath ? loadJson(costPath) : null;

  const syncPath = latestFile("data/lifecycle/smartlead_sync_*.json");
  const syncData = syncPath ? loadJson(syncPath) : null;

  const scoredPath = latestFile("data/scored/scored_venues_*.csv");
  const scoredRows = scoredPath ? readCsv(scoredPath).records : [];

  // Try master
  let masterMap = null;
  try {
    const { loadMaster } = require("../shared/master");
    masterMap = loadMaster();
  } catch (e) {
    console.warn("  [warn] Could not load master CSV:", e.message);
  }

  // Build score lookup
  const scoreByEmail = new Map();
  for (const row of scoredRows) {
    const email = (row.email || "").toLowerCase().trim();
    if (email) scoreByEmail.set(email, Number(row.score) || 0);
  }

  // Build all sections
  const funnel = buildFunnel(funnelReport, masterMap);
  const campaigns = buildCampaigns(statsReport);
  const scoreDistribution = buildScoreDistribution(scoredRows);
  const hotLeads = buildHotLeads(syncData, scoredRows, masterMap, lastSyncAt);
  const deadLeads = buildDeadLeads(syncData);
  const costs = buildCosts(costReport);
  const freshness = buildFreshness(funnel);
  const sourceQuality = buildSourceQuality(masterMap, scoreByEmail);

  const data = {
    generatedAt: new Date().toISOString(),
    funnel,
    campaigns,
    scoreDistribution,
    hotLeads,
    deadLeads,
    costs,
    freshness,
    sourceQuality,
  };

  const outPath = path.join(ARTIFACTS_DIR, "dashboard-data.json");
  saveJson(outPath, data);
  console.log(`  [ok] Dashboard data written to ${outPath}`);
  return data;
}

module.exports = {
  refresh,
  latestFile,
  buildFunnel,
  buildCampaigns,
  buildScoreDistribution,
  buildHotLeads,
  buildDeadLeads,
  buildCosts,
  buildFreshness,
  buildSourceQuality,
};

// CLI entry point
if (require.main === module) {
  (async () => {
    const data = await refresh();
    console.log(`Dashboard data written: ${data.funnel?.stages?.length || 0} funnel stages`);
  })();
}
