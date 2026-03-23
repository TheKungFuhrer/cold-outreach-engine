#!/usr/bin/env node
/**
 * Download AnyMailFinder bulk search results, flatten, dedup, and merge.
 *
 * Credits are charged on download.
 *
 * Usage:
 *   node 2-enrichment/anymailfinder_bulk_download.js
 *   node 2-enrichment/anymailfinder_bulk_download.js --id <search_id>
 */

const fs = require("fs");
const { requireEnv } = require("../shared/env");
const { readCsv, writeCsv } = require("../shared/csv");
const { loadJson, saveJson } = require("../shared/progress");
const { projectPath, ensureDir } = require("../shared/utils");

const API_KEY = requireEnv("ANYMAILFINDER_API_KEY");
const SEARCH_STATE_PATH = projectPath("data", "anymailfinder", "geolead_bulk_search.json");
const RAW_RESULTS_PATH = projectPath("data", "anymailfinder", "geolead_bulk_results.csv");
const OUTPUT_PATH = projectPath("data", "anymailfinder", "geolead_additional_contacts.csv");

function parseArgs() {
  const args = process.argv.slice(2);
  const idx = (flag) => args.indexOf(flag);
  return {
    id: idx("--id") !== -1 ? args[idx("--id") + 1] : null,
  };
}

function loadExistingEmails() {
  const existing = new Set();

  // Existing AnyMailFinder additional contacts (55K emails)
  const amfPath = projectPath("data", "anymailfinder", "additional_contacts.csv");
  try {
    const { records } = readCsv(amfPath);
    for (const row of records) {
      const emailsStr = row.valid_emails || row.emails_found || "";
      for (const e of emailsStr.split(";")) {
        const trimmed = e.trim().toLowerCase();
        if (trimmed) existing.add(trimmed);
      }
    }
  } catch {}

  // Already-uploaded venue emails
  const uploadPath = projectPath("data", "upload", "all_venues.csv");
  try {
    const { records } = readCsv(uploadPath);
    for (const row of records) {
      for (const field of ["email", "one_email", "decision_maker_email", "Email"]) {
        const val = (row[field] || "").trim().toLowerCase();
        if (val) existing.add(val);
      }
    }
  } catch {}

  return existing;
}

async function main() {
  const opts = parseArgs();

  let searchId = opts.id;
  if (!searchId) {
    const state = loadJson(SEARCH_STATE_PATH);
    if (!state || !state.search_id) {
      console.error("No search ID provided and no saved state found.");
      process.exit(1);
    }
    searchId = state.search_id;
    console.log(`Using saved search ID: ${searchId}`);
  }

  // Download CSV results
  const url = `https://api.anymailfinder.com/v5.1/bulk/${searchId}/download?download_as=csv&format=company-one-email-per-line`;
  console.log("Downloading results (credits will be charged)...");

  const res = await fetch(url, {
    headers: { Authorization: API_KEY },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`API error ${res.status}: ${text}`);
    process.exit(1);
  }

  const csvText = await res.text();

  // Save raw results
  ensureDir(projectPath("data", "anymailfinder"));
  fs.writeFileSync(RAW_RESULTS_PATH, csvText, "utf-8");
  console.log(`Raw results saved to ${RAW_RESULTS_PATH}`);

  // Parse the downloaded CSV
  const { records, columns } = readCsv(RAW_RESULTS_PATH);
  console.log(`Downloaded: ${records.length} rows, columns: ${columns.join(", ")}`);

  // Load existing emails for dedup
  const existingEmails = loadExistingEmails();
  console.log(`Existing emails to dedup against: ${existingEmails.size}`);

  // Flatten into individual email rows and dedup
  const allEmails = [];
  const netNewEmails = [];
  const seenInThisBatch = new Set();

  for (const row of records) {
    // Flexible column matching (case-insensitive)
    const domain =
      row.domain || row.Domain || row.company_domain || "";
    const email =
      row.email || row.Email || row.email_address || "";
    const emailStatus =
      row.email_status || row.status || row.verification_status || "";
    const companyName =
      row.company_name || row.company || row.name || "";

    if (!email) continue;

    const emailLower = email.trim().toLowerCase();
    allEmails.push({ domain, company_name: companyName, email: emailLower, email_status: emailStatus });

    if (!seenInThisBatch.has(emailLower) && !existingEmails.has(emailLower)) {
      seenInThisBatch.add(emailLower);
      netNewEmails.push({
        domain: domain.trim(),
        company_name: companyName.trim(),
        email: emailLower,
        email_status: emailStatus,
        source: "anymailfinder_bulk_geolead",
      });
    }
  }

  // Write net-new emails
  if (netNewEmails.length > 0) {
    writeCsv(OUTPUT_PATH, netNewEmails, [
      "domain", "company_name", "email", "email_status", "source",
    ]);
  }

  console.log("\n--- Download & Merge Summary ---");
  console.log(`Total email rows downloaded: ${allEmails.length}`);
  console.log(`Unique emails in batch:      ${seenInThisBatch.size}`);
  console.log(`Already known (deduped):     ${allEmails.length - netNewEmails.length}`);
  console.log(`Net-new emails:              ${netNewEmails.length}`);

  if (netNewEmails.length > 0) {
    console.log(`\nSaved to ${OUTPUT_PATH}`);
    console.log("Ready for SmartLead upload:");
    console.log(`  node 3-outreach/upload_leads.js --input ${OUTPUT_PATH} --campaign-id 3071191`);
  } else {
    console.log("\nNo net-new emails found.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
