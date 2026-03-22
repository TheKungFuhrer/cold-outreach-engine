#!/usr/bin/env node
/**
 * Dedup GeoLead results against all existing lead sources.
 * Produces net-new leads ready for pre-filtering and classification.
 *
 * Existing sources (dedup baseline):
 *   1. data/raw/*.csv (SmartLead exports) — domain from "website" or "email"
 *   2. data/classified/venues.csv — domain from "website"
 *   3. data/anymailfinder/original_csvs/*.csv — "company_domain" field
 *
 * New source:
 *   data/anymailfinder/geolead_results/*.csv — "company_domain" field
 *
 * Output:
 *   data/enriched/geolead_net_new.csv — net-new leads (AnyMail CSV format)
 *   data/enriched/dedup_report.json — dedup statistics
 */

const fs = require("fs");
const path = require("path");
const { projectPath, ensureDir } = require("../../shared/utils");
const { readCsv, writeCsv, streamCsvFiles, findField } = require("../../shared/csv");
const { normalizeDomain, extractDomainFromEmail, buildDomainSet } = require("../../shared/dedup");

const DATA_RAW = projectPath("data", "raw");
const DATA_CLASSIFIED = projectPath("data", "classified");
const DATA_ORIGINAL_CSVS = projectPath("data", "anymailfinder", "original_csvs");
const DATA_GEOLEAD = projectPath("data", "anymailfinder", "geolead_results");
const DATA_ENRICHED = projectPath("data", "enriched");

ensureDir(DATA_ENRICHED);

function main() {
  console.log("=== GeoLead Dedup Engine ===\n");

  // --- Step 1: Build baseline domain set from existing sources ---
  const baselineDomains = new Set();
  let baselineStats = { raw: 0, classified: 0, original_csvs: 0 };

  // 1a. SmartLead raw exports
  console.log("Loading baseline: data/raw/*.csv ...");
  const rawFiles = fs.readdirSync(DATA_RAW).filter((f) => f.endsWith(".csv")).map((f) => path.join(DATA_RAW, f));
  for (const fp of rawFiles) {
    const { records } = readCsv(fp);
    for (const row of records) {
      const website = row.website || row.Website || "";
      const email = row.email || row.Email || "";
      let domain = normalizeDomain(website);
      if (!domain) domain = extractDomainFromEmail(email);
      if (domain) {
        baselineDomains.add(domain);
        baselineStats.raw++;
      }
    }
  }
  console.log(`  raw: ${baselineStats.raw} domains from ${rawFiles.length} file(s)`);

  // 1b. Classified venues
  console.log("Loading baseline: data/classified/venues.csv ...");
  const venuesFile = path.join(DATA_CLASSIFIED, "venues.csv");
  if (fs.existsSync(venuesFile)) {
    const { records } = readCsv(venuesFile);
    for (const row of records) {
      const domain = normalizeDomain(row.website || row.Website || "");
      if (domain) {
        baselineDomains.add(domain);
        baselineStats.classified++;
      }
    }
  }
  console.log(`  classified: ${baselineStats.classified} domains`);

  // 1c. Original AnyMail CSVs (Event_Venue_*.csv)
  console.log("Loading baseline: data/anymailfinder/original_csvs/*.csv ...");
  const originalFiles = fs.readdirSync(DATA_ORIGINAL_CSVS)
    .filter((f) => f.endsWith(".csv"))
    .map((f) => path.join(DATA_ORIGINAL_CSVS, f));
  streamCsvFiles(originalFiles, (row) => {
    const domain = normalizeDomain(row.company_domain || "");
    if (domain) {
      baselineDomains.add(domain);
      baselineStats.original_csvs++;
    }
  });
  console.log(`  original_csvs: ${baselineStats.original_csvs} domain entries from ${originalFiles.length} files`);

  const baselineSize = baselineDomains.size;
  console.log(`\nBaseline total: ${baselineSize} unique domains\n`);

  // --- Step 2: Stream GeoLead results, dedup against baseline + cross-search ---
  console.log("Processing GeoLead results...");
  const geoLeadFiles = fs.readdirSync(DATA_GEOLEAD)
    .filter((f) => f.endsWith(".csv"))
    .sort()
    .map((f) => path.join(DATA_GEOLEAD, f));

  console.log(`  ${geoLeadFiles.length} GeoLead CSV files to process`);

  const seenInRun = new Set(); // cross-search-term dedup
  const netNewRecords = [];
  let totalRaw = 0;
  let dupesExisting = 0;
  let dupesCross = 0;
  let noDomain = 0;
  const bySearchTerm = {}; // search_term -> { total, dupes_existing, dupes_cross, net_new }

  streamCsvFiles(geoLeadFiles, (row, filePath) => {
    totalRaw++;
    const domain = normalizeDomain(row.company_domain || "");

    // Extract search term from filename (e.g., banquet_hall_Akron_OH_25km.csv)
    const fname = path.basename(filePath, ".csv");
    // Pattern: query_City_State_radius — extract query part
    const match = fname.match(/^(.+?)_[A-Z][a-z]+.*_\d+km$/);
    const searchTerm = match ? match[1].replace(/_/g, " ") : "unknown";

    if (!bySearchTerm[searchTerm]) {
      bySearchTerm[searchTerm] = { total: 0, dupes_existing: 0, dupes_cross: 0, net_new: 0, no_domain: 0 };
    }
    bySearchTerm[searchTerm].total++;

    if (!domain) {
      noDomain++;
      bySearchTerm[searchTerm].no_domain++;
      return;
    }

    if (baselineDomains.has(domain)) {
      dupesExisting++;
      bySearchTerm[searchTerm].dupes_existing++;
      return;
    }

    if (seenInRun.has(domain)) {
      dupesCross++;
      bySearchTerm[searchTerm].dupes_cross++;
      return;
    }

    seenInRun.add(domain);
    bySearchTerm[searchTerm].net_new++;

    // Keep the record with source metadata
    row._source_file = path.basename(filePath);
    row._source_query = searchTerm;
    netNewRecords.push(row);
  });

  // --- Step 3: Write outputs ---
  const netNew = netNewRecords.length;
  console.log(`\n--- Dedup Summary ---`);
  console.log(`Total raw GeoLead records: ${totalRaw}`);
  console.log(`No domain:                 ${noDomain}`);
  console.log(`Dupes (existing baseline): ${dupesExisting}`);
  console.log(`Dupes (cross-search-term): ${dupesCross}`);
  console.log(`Net-new leads:             ${netNew}`);

  console.log(`\nBy search term:`);
  for (const [term, stats] of Object.entries(bySearchTerm).sort((a, b) => b[1].net_new - a[1].net_new)) {
    console.log(`  ${term}: ${stats.total} total, ${stats.net_new} net-new, ${stats.dupes_existing} existing-dupes, ${stats.dupes_cross} cross-dupes`);
  }

  // Write net-new CSV
  if (netNewRecords.length > 0) {
    const outFile = path.join(DATA_ENRICHED, "geolead_net_new.csv");
    writeCsv(outFile, netNewRecords);
    console.log(`\nSaved ${netNew} net-new leads to: ${outFile}`);
  }

  // Write dedup report
  const report = {
    timestamp: new Date().toISOString(),
    baseline_domains: baselineSize,
    baseline_sources: baselineStats,
    geolead_files: geoLeadFiles.length,
    total_raw: totalRaw,
    no_domain: noDomain,
    dupes_existing: dupesExisting,
    dupes_cross: dupesCross,
    net_new: netNew,
    by_search_term: bySearchTerm,
  };
  const reportFile = path.join(DATA_ENRICHED, "dedup_report.json");
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(`Dedup report saved to: ${reportFile}`);
}

main();
