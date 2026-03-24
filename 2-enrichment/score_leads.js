#!/usr/bin/env node
/**
 * Lead Scoring Module
 *
 * Reads venue leads, joins data from phone validation, email enrichment,
 * and engagement sources, applies weighted scoring, and outputs a ranked CSV.
 *
 * Usage:
 *   node 2-enrichment/score_leads.js [--input <csv>] [--output-dir <dir>]
 */

const fs = require("fs");
const path = require("path");
const { readCsv, writeCsv } = require("../shared/csv");
const { parseLocation, resolveField } = require("../shared/fields");
const { normalizeDomain } = require("../shared/dedup");
const { projectPath, timestamp } = require("../shared/utils");
const { WEIGHTS, isChain, getMetroTier, matchCategory } = require("./scoring-config");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}
const inputArg = getArg("--input");
const outputDir = getArg("--output-dir") || projectPath("data", "scored");

// ---------------------------------------------------------------------------
// findLatestCleanVenues — most recent clean_venues_*.csv in data/final/
// ---------------------------------------------------------------------------

function findLatestCleanVenues() {
  const dir = projectPath("data", "final");
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith("clean_venues_") && f.endsWith(".csv"))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(dir, files[0]) : null;
}

// ---------------------------------------------------------------------------
// buildPhoneTypeLookup — email → phone type from 5 segment files
// ---------------------------------------------------------------------------

function buildPhoneTypeLookup() {
  const lookup = {};
  const segments = [
    { file: "no_phone.csv", type: "none" },
    { file: "invalid.csv", type: "invalid" },
    { file: "landline.csv", type: "landline" },
    { file: "voip.csv", type: "voip" },
    { file: "mobile.csv", type: "mobile" },
  ];

  for (const seg of segments) {
    const fp = projectPath("data", "phone_validated", seg.file);
    const { records } = readCsv(fp);
    for (const row of records) {
      const email = resolveField(row, "email").toLowerCase();
      if (email) lookup[email] = seg.type;
    }
  }

  return lookup;
}

// ---------------------------------------------------------------------------
// buildEmailCountLookup — domain → unique email count from master list
// ---------------------------------------------------------------------------

function buildEmailCountLookup() {
  const fp = projectPath("data", "upload", "master_enriched_emails.csv");
  if (!fs.existsSync(fp)) {
    console.warn("WARNING: master_enriched_emails.csv not found — email depth scoring disabled");
    return {};
  }

  const { records } = readCsv(fp);
  const domainEmails = {}; // domain → Set of emails

  for (const row of records) {
    const website = resolveField(row, "website");
    const domain = normalizeDomain(website);
    const email = resolveField(row, "email").toLowerCase();
    if (!domain || !email) continue;
    if (!domainEmails[domain]) domainEmails[domain] = new Set();
    domainEmails[domain].add(email);
  }

  const lookup = {};
  for (const [domain, emails] of Object.entries(domainEmails)) {
    lookup[domain] = emails.size;
  }
  return lookup;
}

// ---------------------------------------------------------------------------
// buildEngagementLookup — email → { openCount, clickCount, replyCount }
// ---------------------------------------------------------------------------

function buildEngagementLookup() {
  const dir = projectPath("data", "raw");
  if (!fs.existsSync(dir)) return {};

  const csvFiles = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".csv"))
    .sort()
    .reverse();

  const lookup = {};

  for (const file of csvFiles) {
    const fp = path.join(dir, file);
    const { records } = readCsv(fp);

    for (const row of records) {
      const email = resolveField(row, "email").toLowerCase();
      if (!email || lookup[email]) continue;

      const openCount = parseInt(row.openCount || row.open_count || "0", 10) || 0;
      const clickCount = parseInt(row.clickCount || row.click_count || "0", 10) || 0;
      const replyCount = parseInt(row.replyCount || row.reply_count || "0", 10) || 0;

      if (openCount > 0 || clickCount > 0 || replyCount > 0) {
        lookup[email] = { openCount, clickCount, replyCount };
      }
    }
  }

  return lookup;
}

// ---------------------------------------------------------------------------
// scoreLead — compute weighted score for a single lead
// ---------------------------------------------------------------------------

function scoreLead(lead, phoneTypeLookup, emailCountLookup, engagementLookup) {
  let score = 0;

  const email = resolveField(lead, "email").toLowerCase();
  const companyName = resolveField(lead, "companyName");
  const website = resolveField(lead, "website");
  const rawLocation = resolveField(lead, "location");
  const sourceQuery = lead._source_query || "";
  const socialMediaFlag = lead._social_media_flag || "";

  // 1. Engagement
  const engagement = engagementLookup[email];
  if (engagement) {
    if (engagement.replyCount > 0) score += WEIGHTS.engagement.reply;
    if (engagement.clickCount > 0) score += WEIGHTS.engagement.click;
    if (engagement.openCount >= WEIGHTS.engagement.openThreshold) score += WEIGHTS.engagement.repeatedOpens;
  }

  // 2. Phone type
  const phoneType = phoneTypeLookup[email] || "none";
  score += WEIGHTS.phone[phoneType] || 0;

  // 3. Website (mutually exclusive)
  if (socialMediaFlag) {
    score += WEIGHTS.website.socialOnly;
  } else if (website) {
    score += WEIGHTS.website.hasWebsite;
  }

  // 4. Category
  const category = matchCategory(sourceQuery, companyName);
  score += WEIGHTS.category[category] || 0;

  // 5. Metro tier
  const { city, state } = parseLocation(rawLocation);
  const tier = getMetroTier(city, state);
  const tierKey = `tier${tier}`;
  score += WEIGHTS.metro[tierKey] || 0;

  // 6. Email depth
  const domain = normalizeDomain(website);
  const emailCount = emailCountLookup[domain] || 0;
  if (emailCount >= WEIGHTS.emailDepth.thresholdHigh) {
    score += WEIGHTS.emailDepth.threeOrMore;
  } else if (emailCount >= 1) {
    score += WEIGHTS.emailDepth.oneOrTwo;
  }

  // 7. Chain detection
  if (isChain(companyName)) {
    score += WEIGHTS.chain.chain;
  } else {
    score += WEIGHTS.chain.independent;
  }

  // Clamp to 1-100
  return Math.max(1, Math.min(100, score));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  // 1. Resolve input file
  const inputFile = inputArg || findLatestCleanVenues();
  if (!inputFile) {
    console.error("ERROR: No input file. Use --input <csv> or ensure data/final/clean_venues_*.csv exists.");
    process.exit(1);
  }
  if (!fs.existsSync(inputFile)) {
    console.error(`ERROR: Input file not found: ${inputFile}`);
    process.exit(1);
  }
  console.log(`Input: ${inputFile}`);

  // 2. Read input CSV
  const { records, columns } = readCsv(inputFile);
  console.log(`Loaded ${records.length} leads`);

  // 3. Build lookup maps
  const phoneTypeLookup = buildPhoneTypeLookup();
  console.log(`Phone type lookup: ${Object.keys(phoneTypeLookup).length} entries`);

  const emailCountLookup = buildEmailCountLookup();
  console.log(`Email count lookup: ${Object.keys(emailCountLookup).length} domains`);

  const engagementLookup = buildEngagementLookup();
  console.log(`Engagement lookup: ${Object.keys(engagementLookup).length} entries`);

  // 4. Score every lead
  for (const lead of records) {
    lead.score = scoreLead(lead, phoneTypeLookup, emailCountLookup, engagementLookup);
  }

  // 5. Sort by score descending
  records.sort((a, b) => b.score - a.score);

  // 6. Write output
  const outColumns = [...columns, "score"];
  const outFile = path.join(outputDir, `scored_venues_${timestamp()}.csv`);
  writeCsv(outFile, records, outColumns);
  console.log(`\nOutput: ${outFile}`);
  console.log(`Total scored: ${records.length}`);

  // 7. Distribution summary
  const buckets = { "90-100": 0, "70-89": 0, "50-69": 0, "30-49": 0, "1-29": 0 };
  for (const r of records) {
    const s = r.score;
    if (s >= 90) buckets["90-100"]++;
    else if (s >= 70) buckets["70-89"]++;
    else if (s >= 50) buckets["50-69"]++;
    else if (s >= 30) buckets["30-49"]++;
    else buckets["1-29"]++;
  }
  console.log("\nScore Distribution:");
  for (const [range, count] of Object.entries(buckets)) {
    const pct = records.length > 0 ? ((count / records.length) * 100).toFixed(1) : "0.0";
    console.log(`  ${range}: ${count} (${pct}%)`);
  }

  // 8. Top 10
  console.log("\nTop 10 Leads:");
  const top10 = records.slice(0, 10);
  for (let i = 0; i < top10.length; i++) {
    const r = top10[i];
    const name = resolveField(r, "companyName");
    const loc = parseLocation(resolveField(r, "location"));
    const locStr = [loc.city, loc.state].filter(Boolean).join(", ");
    console.log(`  ${i + 1}. ${name} (${locStr || "Unknown"}) — ${r.score}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
