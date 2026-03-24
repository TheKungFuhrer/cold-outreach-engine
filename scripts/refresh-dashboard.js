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

// Placeholder refresh — will be completed in Task 4
async function refresh() {
  ensureDir(ARTIFACTS_DIR);

  // Load funnel report
  const funnelPath = latestFile("data/reports/funnel_report_*.json");
  const funnelReport = funnelPath ? loadJson(funnelPath) : null;

  // Try to load master
  let masterMap = null;
  try {
    const { loadMaster } = require("../shared/master");
    masterMap = loadMaster();
  } catch (e) {
    console.warn("  [warn] Could not load master CSV:", e.message);
  }

  const funnel = buildFunnel(funnelReport, masterMap);

  const data = {
    generatedAt: new Date().toISOString(),
    funnel,
    campaigns: [],
    scoreDistribution: { buckets: [], mean: 0, median: 0 },
    hotLeads: [],
    deadLeads: { bounced: 0, unsubscribed: 0, total: 0 },
    costs: { perStage: [], totalSpend: 0 },
    freshness: { stages: [] },
    sourceQuality: { bySource: [], byDetail: [] },
  };

  const outPath = path.join(ARTIFACTS_DIR, "dashboard-data.json");
  saveJson(outPath, data);
  console.log(`  [ok] Dashboard data written to ${outPath}`);
  return data;
}

module.exports = { refresh, latestFile, buildFunnel };

// CLI entry point
if (require.main === module) {
  (async () => {
    const data = await refresh();
    console.log(`Dashboard data written: ${data.funnel?.stages?.length || 0} funnel stages`);
  })();
}
