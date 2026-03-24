#!/usr/bin/env node
/**
 * Build a master lead CSV by consolidating all pipeline data sources.
 *
 * Usage:
 *   node scripts/build-master.js [options]
 *
 * Options:
 *   --export ghl      Also generate GHL-compatible CSVs
 *   --min-score N      GHL filter: minimum lead score (default: 0)
 *   --min-stage STAGE  GHL filter: minimum pipeline stage (default: raw)
 *   --dry-run          Report stats without writing files
 */

const fs = require("fs");
const path = require("path");
const csv = require("../shared/csv");
const { readCsv } = csv;
const { normalizeRow, resolveField, parseLocationFull, parseName } = require("../shared/fields");
const { normalizeDomain } = require("../shared/dedup");
const { projectPath } = require("../shared/utils");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MASTER_COLUMNS = [
  "domain", "email", "first_name", "last_name", "company_name",
  "phone", "phone_type", "phone_carrier", "website", "location_raw",
  "city", "state", "zip", "is_venue", "confidence",
  "classification_reasoning", "score", "source", "source_detail",
  "email_source", "pipeline_stage", "last_updated",
];

/** Company-level fields that get inherited when a new email is added to an existing domain. */
const COMPANY_FIELDS = [
  "company_name", "phone", "phone_type", "phone_carrier", "website",
  "location_raw", "city", "state", "zip", "is_venue", "confidence",
  "classification_reasoning", "source", "source_detail",
];

const STAGE_RANK = {
  raw: 0, filtered: 1, classified: 2, validated: 3,
  enriched: 4, uploaded: 5, in_campaign: 6,
};

// ---------------------------------------------------------------------------
// Merge map — Map<domain, Map<email, record>>
// ---------------------------------------------------------------------------

function createMergeMap() {
  return new Map();
}

/**
 * Merge a record into the map. Fills empty fields but never overwrites populated ones.
 * If the domain already exists but this email is new, inherits company-level fields.
 * Pass forceFields array to overwrite specific fields even if already set (used by
 * verified/escalated ingestor to upgrade classifications).
 */
function mergeIntoMap(map, record, forceFields = []) {
  const domain = record.domain;
  const email = record.email;
  if (!domain && !email) return;

  const key = domain || email;
  if (!map.has(key)) map.set(key, new Map());
  const domainMap = map.get(key);

  if (!domainMap.has(email)) {
    // New email for this domain — inherit company-level fields from first existing record
    const inherited = {};
    if (domainMap.size > 0) {
      const firstRecord = domainMap.values().next().value;
      for (const field of COMPANY_FIELDS) {
        if (firstRecord[field]) inherited[field] = firstRecord[field];
      }
    }
    domainMap.set(email, { ...inherited, ...stripEmpty(record) });
  } else {
    // Existing domain+email — fill blanks, and force-overwrite specified fields
    const existing = domainMap.get(email);
    for (const [k, v] of Object.entries(record)) {
      if (v && (!existing[k] || forceFields.includes(k))) existing[k] = v;
    }
  }
}

/** Remove empty-string and undefined values from an object. */
function stripEmpty(obj) {
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== "") result[k] = v;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Source ingestors — each reads one data source and feeds into the merge map
// ---------------------------------------------------------------------------

function safeReadCsv(filepath) {
  try {
    return readCsv(filepath);
  } catch {
    return { records: [], columns: [] };
  }
}

/** Ingest SmartLead raw exports: data/raw/campaign_*.csv */
function ingestSmartLead(map) {
  const dir = projectPath("data", "raw");
  if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir).filter(f => f.startsWith("campaign_") && f.endsWith(".csv"));
  let count = 0;

  for (const file of files) {
    const { records } = safeReadCsv(path.join(dir, file));
    // Extract campaign ID from filename: campaign_<id>_<timestamp>.csv
    const campaignId = file.match(/campaign_(\d+)/)?.[1] || "";

    for (const row of records) {
      const n = normalizeRow(row);
      const domain = normalizeDomain(n.website) || normalizeDomain(n.email.split("@")[1] || "");
      if (!domain && !n.email) continue;

      const hasEngagement = Number(row.open_count || 0) > 0 || Number(row.reply_count || 0) > 0 || Number(row.click_count || 0) > 0;

      mergeIntoMap(map, {
        domain,
        email: n.email,
        first_name: n.firstName,
        last_name: n.lastName,
        company_name: n.companyName,
        phone: n.phone,
        website: n.website,
        location_raw: n.location,
        source: "smartlead_original",
        source_detail: `campaign_${campaignId}`,
        email_source: "primary",
        _has_engagement: hasEngagement ? "yes" : "",
        _in_smartlead: "yes",
      });
      count++;
    }
  }
  return count;
}

/** Ingest GeoLead enriched data: data/enriched/geolead_net_new.csv */
function ingestGeoLead(map) {
  const { records } = safeReadCsv(projectPath("data", "enriched", "geolead_net_new.csv"));
  let count = 0;

  for (const row of records) {
    const n = normalizeRow(row);
    const domain = normalizeDomain(n.website) || normalizeDomain(row.company_domain || "");
    if (!domain && !n.email) continue;

    mergeIntoMap(map, {
      domain,
      email: n.email,
      first_name: n.firstName,
      last_name: n.lastName,
      company_name: n.companyName,
      phone: n.phone,
      website: n.website || row.company_website || "",
      location_raw: n.location,
      source: "geolead",
      source_detail: row._source_query || row._source_file || "",
      email_source: "primary",
      _is_filtered: "yes",
    });
    count++;
  }
  return count;
}

/** Ingest classified venues and non-venues from both original and GeoLead batches. */
function ingestClassified(map) {
  const dirs = [
    { dir: "classified", source: "smartlead_original" },
    { dir: "classified_geolead", source: "geolead" },
  ];
  let count = 0;

  for (const { dir, source } of dirs) {
    for (const file of ["venues.csv", "non_venues.csv", "ambiguous.csv"]) {
      const filepath = projectPath("data", dir, file);
      const { records } = safeReadCsv(filepath);

      for (const row of records) {
        const n = normalizeRow(row);
        const domain = normalizeDomain(n.website);
        if (!domain && !n.email) continue;

        mergeIntoMap(map, {
          domain,
          email: n.email,
          first_name: n.firstName,
          last_name: n.lastName,
          company_name: n.companyName,
          phone: n.phone,
          website: n.website,
          location_raw: n.location,
          is_venue: row.is_venue || "",
          confidence: row.confidence || "",
          classification_reasoning: row.reasoning || "",
          source: source,
          email_source: "primary",
        });
        count++;
      }
    }
  }
  return count;
}

/** Ingest phone-validated segments: data/phone_validated/*.csv and data/phone_validated_geolead/*.csv */
function ingestPhoneValidated(map) {
  const dirs = ["phone_validated", "phone_validated_geolead"];
  let count = 0;

  for (const dir of dirs) {
    const fullDir = projectPath("data", dir);
    if (!fs.existsSync(fullDir)) continue;
    const files = fs.readdirSync(fullDir).filter(f => f.endsWith(".csv"));

    for (const file of files) {
      const { records } = safeReadCsv(path.join(fullDir, file));
      // Derive phone_type from filename: mobile.csv -> mobile, landline.csv -> landline, etc.
      const phoneType = file.replace(".csv", "");
      const isPhoneFile = ["mobile", "landline", "voip", "invalid"].includes(phoneType);

      for (const row of records) {
        const n = normalizeRow(row);
        const domain = normalizeDomain(n.website);
        if (!domain && !n.email) continue;

        mergeIntoMap(map, {
          domain,
          email: n.email,
          first_name: n.firstName,
          last_name: n.lastName,
          company_name: n.companyName,
          phone: n.phone,
          website: n.website,
          location_raw: n.location,
          phone_type: isPhoneFile ? phoneType : "",
          phone_carrier: row.carrier || "",
          is_venue: row.is_venue || "",
          confidence: row.confidence || "",
          classification_reasoning: row.reasoning || "",
          email_source: "primary",
        });
        count++;
      }
    }
  }
  return count;
}

/** Ingest verified/escalated results: data/verified/*.csv and data/verified_geolead/*.csv
 *  These OVERWRITE classification fields (is_venue, confidence, classification_reasoning)
 *  because escalation upgrades a previous ambiguous classification. */
function ingestVerified(map) {
  const dirs = ["verified", "verified_geolead"];
  const CLASSIFICATION_FIELDS = ["is_venue", "confidence", "classification_reasoning"];
  let count = 0;

  for (const dir of dirs) {
    for (const file of ["venues.csv", "non_venues.csv"]) {
      const filepath = projectPath("data", dir, file);
      const { records } = safeReadCsv(filepath);

      for (const row of records) {
        const n = normalizeRow(row);
        const domain = normalizeDomain(n.website);
        if (!domain && !n.email) continue;

        mergeIntoMap(map, {
          domain,
          email: n.email,
          first_name: n.firstName,
          last_name: n.lastName,
          company_name: n.companyName,
          phone: n.phone,
          website: n.website,
          location_raw: n.location,
          is_venue: row.is_venue || "",
          confidence: row.confidence || "",
          classification_reasoning: row.reasoning || "",
          email_source: "primary",
        }, CLASSIFICATION_FIELDS);
        count++;
      }
    }
  }
  return count;
}

/** Ingest AnyMailFinder additional contacts (original batch). */
function ingestAmfOriginal(map) {
  const { records } = safeReadCsv(projectPath("data", "anymailfinder", "additional_contacts.csv"));
  let count = 0;

  for (const row of records) {
    const domain = normalizeDomain(row.domain || "");
    if (!domain) continue;

    // This file has semicolon-separated emails in valid_emails or emails_found
    const emailsStr = row.valid_emails || row.emails_found || "";
    const emails = emailsStr.split(";").map(e => e.trim().toLowerCase()).filter(Boolean);

    for (const email of emails) {
      mergeIntoMap(map, {
        domain,
        email,
        company_name: row.venue_name || row.company_name || "",
        source: "anymailfinder",
        email_source: "anymailfinder_original",
      });
      count++;
    }
  }
  return count;
}

/** Ingest AnyMailFinder GeoLead bulk results. */
function ingestAmfGeoLead(map) {
  const { records } = safeReadCsv(projectPath("data", "anymailfinder", "geolead_additional_contacts.csv"));
  let count = 0;

  for (const row of records) {
    const domain = normalizeDomain(row.domain || row.company_domain || "");
    const email = (row.email || "").trim().toLowerCase();
    if (!domain || !email) continue;

    mergeIntoMap(map, {
      domain,
      email,
      company_name: row.company_name || "",
      source: "anymailfinder",
      email_source: "anymailfinder_geolead",
    });
    count++;
  }
  return count;
}

/** Ingest master email list for in_smartlead flags: data/upload/master_enriched_emails.csv */
function ingestSmartLeadFlags(map) {
  const { records } = safeReadCsv(projectPath("data", "upload", "master_enriched_emails.csv"));
  let count = 0;

  for (const row of records) {
    if (row.in_smartlead !== "yes") continue;
    const email = (row.email || "").trim().toLowerCase();
    if (!email) continue;
    const domain = normalizeDomain(row.website || "") || normalizeDomain(email.split("@")[1] || "");

    // Only set the flag — don't create new records from this source
    if (map.has(domain)) {
      const domainMap = map.get(domain);
      if (domainMap.has(email)) {
        domainMap.get(email)._in_smartlead = "yes";
        count++;
      }
    }
  }
  return count;
}

/** Ingest scored venues: most recent data/scored/scored_venues_*.csv */
function ingestScores(map) {
  const dir = projectPath("data", "scored");
  if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir).filter(f => f.startsWith("scored_venues_") && f.endsWith(".csv")).sort();
  if (files.length === 0) return 0;

  const latest = files[files.length - 1];
  const { records } = safeReadCsv(path.join(dir, latest));
  let count = 0;

  for (const row of records) {
    const email = (row.email || "").trim().toLowerCase();
    if (!email || !row.score) continue;
    const domain = normalizeDomain(row.website || "") || normalizeDomain(email.split("@")[1] || "");

    if (map.has(domain)) {
      const domainMap = map.get(domain);
      if (domainMap.has(email)) {
        domainMap.get(email).score = row.score;
        count++;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Phase 2: Enrich & Derive
// ---------------------------------------------------------------------------

function computePipelineStage(record) {
  if (record._has_engagement === "yes") return "in_campaign";
  if (record._in_smartlead === "yes") return "uploaded";
  if (record.email_source && record.email_source.startsWith("anymailfinder")) return "enriched";
  if (record.phone_type) return "validated";
  if (record.is_venue) return "classified";
  if (record._is_filtered === "yes") return "filtered";
  return "raw";
}

function enrichRecords(map) {
  const now = new Date().toISOString();
  const flat = [];

  for (const [domain, emailMap] of map) {
    for (const [email, record] of emailMap) {
      // Parse location for city/state/zip if not already set
      if (record.location_raw && (!record.city || !record.state)) {
        const loc = parseLocationFull(record.location_raw);
        if (!record.city && loc.city) record.city = loc.city;
        if (!record.state && loc.state) record.state = loc.state;
        if (!record.zip && loc.zip) record.zip = loc.zip;
      }

      // Compute pipeline stage
      record.pipeline_stage = computePipelineStage(record);
      record.last_updated = now;

      // Ensure all columns exist
      record.domain = domain;
      record.email = email;

      flat.push(record);
    }
  }

  // Sort by domain, then email
  flat.sort((a, b) => (a.domain || "").localeCompare(b.domain || "") || (a.email || "").localeCompare(b.email || ""));
  return flat;
}

// ---------------------------------------------------------------------------
// Phase 3: Export
// ---------------------------------------------------------------------------

function writeMasterCsv(records) {
  const outputPath = projectPath("data", "master", "leads_master.csv");
  const rows = records.map(r => {
    const out = {};
    for (const col of MASTER_COLUMNS) {
      out[col] = r[col] || "";
    }
    return out;
  });
  csv.writeCsv(outputPath, rows, MASTER_COLUMNS);
  return outputPath;
}

// ---------------------------------------------------------------------------
// GHL Exports
// ---------------------------------------------------------------------------

function confidenceTier(confidence) {
  const c = parseFloat(confidence);
  if (isNaN(c)) return "";
  if (c >= 0.85) return "high";
  if (c >= 0.7) return "medium";
  return "low";
}

function buildTags(record) {
  const tags = [];
  if (record.phone_type) tags.push(record.phone_type);
  if (record.source) tags.push(record.source);
  const tier = confidenceTier(record.confidence);
  if (tier) tags.push(`confidence_${tier}`);
  return tags.join(",");
}

function filterRecords(records, minScore, minStage) {
  const minStageRank = STAGE_RANK[minStage] || 0;
  return records.filter(r => {
    const score = parseFloat(r.score) || 0;
    const stageRank = STAGE_RANK[r.pipeline_stage] || 0;
    return score >= minScore && stageRank >= minStageRank;
  });
}

function buildDomainEmailsLookup(records) {
  const lookup = new Map(); // domain -> Set<email>
  for (const r of records) {
    if (!r.domain) continue;
    if (!lookup.has(r.domain)) lookup.set(r.domain, new Set());
    if (r.email) lookup.get(r.domain).add(r.email);
  }
  return lookup;
}

function exportGhlContacts(records, domainEmails) {
  const columns = [
    "Phone", "Email", "First Name", "Last Name", "Business Name",
    "Source", "Additional Emails", "Additional Phones", "Notes", "Tags",
  ];
  const rows = records.map(r => {
    const otherEmails = domainEmails.has(r.domain)
      ? [...domainEmails.get(r.domain)].filter(e => e !== r.email).join(";")
      : "";
    return {
      "Phone": r.phone || "",
      "Email": r.email || "",
      "First Name": r.first_name || "",
      "Last Name": r.last_name || "",
      "Business Name": r.company_name || "",
      "Source": r.source || "",
      "Additional Emails": otherEmails,
      "Additional Phones": "",
      "Notes": (r.classification_reasoning || "").slice(0, 500),
      "Tags": buildTags(r),
    };
  });
  const outputPath = projectPath("data", "master", "ghl_contacts.csv");
  csv.writeCsv(outputPath, rows, columns);
  return outputPath;
}

function exportGhlCompanies(records) {
  const columns = [
    "Company Name", "Phone", "Email", "Website", "Address",
    "City", "State", "Postal Code", "Country", "Description",
  ];
  // One row per domain — use the first record for each domain
  const seen = new Set();
  const rows = [];
  for (const r of records) {
    if (!r.domain || seen.has(r.domain)) continue;
    seen.add(r.domain);
    rows.push({
      "Company Name": r.company_name || "",
      "Phone": r.phone || "",
      "Email": r.email || "",
      "Website": r.website || "",
      "Address": r.location_raw || "",
      "City": r.city || "",
      "State": r.state || "",
      "Postal Code": r.zip || "",
      "Country": "US",
      "Description": "",
    });
  }
  const outputPath = projectPath("data", "master", "ghl_companies.csv");
  csv.writeCsv(outputPath, rows, columns);
  return outputPath;
}

function exportGhlOpportunities(records) {
  const columns = [
    "Opportunity Name", "Phone", "Email", "Pipeline ID", "Stage ID",
    "Lead Value", "Source", "Notes", "Tags", "Status",
  ];
  const rows = records.map(r => ({
    "Opportunity Name": r.company_name || "",
    "Phone": r.phone || "",
    "Email": r.email || "",
    "Pipeline ID": "",
    "Stage ID": "",
    "Lead Value": "75",
    "Source": r.source || "",
    "Notes": `score: ${r.score || "N/A"}, stage: ${r.pipeline_stage || "N/A"}, confidence: ${r.confidence || "N/A"}`,
    "Tags": buildTags(r),
    "Status": "open",
  }));
  const outputPath = projectPath("data", "master", "ghl_opportunities.csv");
  csv.writeCsv(outputPath, rows, columns);
  return outputPath;
}

// ---------------------------------------------------------------------------
// CLI & main
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { exportGhl: false, minScore: 0, minStage: "raw", dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--export" && args[i + 1] === "ghl") { opts.exportGhl = true; i++; }
    if (args[i] === "--min-score") { opts.minScore = parseInt(args[++i], 10) || 0; }
    if (args[i] === "--min-stage") { opts.minStage = args[++i] || "raw"; }
    if (args[i] === "--dry-run") { opts.dryRun = true; }
  }
  return opts;
}

function printSummary(records) {
  const domains = new Set(records.map(r => r.domain).filter(Boolean));
  const bySrc = {};
  const byStage = {};
  for (const r of records) {
    bySrc[r.source || "unknown"] = (bySrc[r.source || "unknown"] || 0) + 1;
    byStage[r.pipeline_stage || "raw"] = (byStage[r.pipeline_stage || "raw"] || 0) + 1;
  }

  console.log(`\n=== Master Build Summary ===`);
  console.log(`Total domains:  ${domains.size}`);
  console.log(`Total contacts: ${records.length}`);
  console.log(`\nBy source:`);
  for (const [src, count] of Object.entries(bySrc).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${src}: ${count}`);
  }
  console.log(`\nBy pipeline stage:`);
  for (const [stage, count] of Object.entries(byStage).sort((a, b) => (STAGE_RANK[b[0]] || 0) - (STAGE_RANK[a[0]] || 0))) {
    console.log(`  ${stage}: ${count}`);
  }
}

function main() {
  const opts = parseArgs();
  console.log("=== Building Master Lead CSV ===\n");

  // Phase 1: Ingest & Merge
  const map = createMergeMap();
  const counts = {};
  counts.smartlead = ingestSmartLead(map);
  console.log(`  SmartLead raw:           ${counts.smartlead} rows`);
  counts.geolead = ingestGeoLead(map);
  console.log(`  GeoLead enriched:        ${counts.geolead} rows`);
  counts.classified = ingestClassified(map);
  console.log(`  Classified:              ${counts.classified} rows`);
  counts.phoneValidated = ingestPhoneValidated(map);
  console.log(`  Phone validated:         ${counts.phoneValidated} rows`);
  counts.verified = ingestVerified(map);
  console.log(`  Verified/escalated:      ${counts.verified} rows`);
  counts.amfOriginal = ingestAmfOriginal(map);
  console.log(`  AnyMailFinder original:  ${counts.amfOriginal} rows`);
  counts.amfGeolead = ingestAmfGeoLead(map);
  console.log(`  AnyMailFinder GeoLead:   ${counts.amfGeolead} rows`);
  counts.smartleadFlags = ingestSmartLeadFlags(map);
  console.log(`  SmartLead flags applied: ${counts.smartleadFlags}`);
  counts.scores = ingestScores(map);
  console.log(`  Scores applied:          ${counts.scores}`);

  // Phase 2: Enrich & Derive
  const records = enrichRecords(map);
  printSummary(records);

  if (opts.dryRun) {
    console.log("\n[DRY RUN] No files written.");
    return;
  }

  // Phase 3: Export
  const masterPath = writeMasterCsv(records);
  console.log(`\nMaster CSV: ${masterPath}`);

  if (opts.exportGhl) {
    const filtered = filterRecords(records, opts.minScore, opts.minStage);
    console.log(`\nGHL export: ${filtered.length} records (min-score=${opts.minScore}, min-stage=${opts.minStage})`);
    const domainEmails = buildDomainEmailsLookup(filtered);
    const contactsPath = exportGhlContacts(filtered, domainEmails);
    const companiesPath = exportGhlCompanies(filtered);
    const oppsPath = exportGhlOpportunities(filtered);
    console.log(`  Contacts:      ${contactsPath}`);
    console.log(`  Companies:     ${companiesPath}`);
    console.log(`  Opportunities: ${oppsPath}`);
  }

  console.log("\nDone.");
}

// Export internals for testing
module.exports = {
  createMergeMap,
  mergeIntoMap,
  enrichRecords,
  computePipelineStage,
  filterRecords,
  buildTags,
  confidenceTier,
  buildDomainEmailsLookup,
  exportGhlContacts,
  exportGhlCompanies,
  exportGhlOpportunities,
  writeMasterCsv,
  MASTER_COLUMNS,
  STAGE_RANK,
};

// Run main only when executed directly
if (require.main === module) {
  main();
}
