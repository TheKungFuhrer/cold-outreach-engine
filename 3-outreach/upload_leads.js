#!/usr/bin/env node
/**
 * Upload verified venue leads to SmartLead via REST API.
 *
 * Reads a clean CSV, maps fields to SmartLead format, adds custom field tags,
 * and uploads in batches of 400 (SmartLead limit). Resumable via JSONL checkpoint.
 *
 * Usage:
 *   node 3-outreach/upload_leads.js --input data/final/clean_venues.csv --campaign-id 12345
 *   node 3-outreach/upload_leads.js --input data/final/clean_venues.csv --campaign-id 12345 --dry-run
 */

const { readCsv, writeCsv, findField } = require("../shared/csv");
const { uploadLeads, chunkArray } = require("../shared/smartlead");
const { loadJsonl, appendJsonl } = require("../shared/progress");
const { projectPath, ensureDir, timestamp } = require("../shared/utils");

const CHECKPOINT_PATH = projectPath("data", "reports", ".upload_progress.jsonl");
const FAILURES_PATH = projectPath("data", "reports", "upload_failures.csv");

const EMAIL_FIELDS = ["email", "Email", "email_address", "one_email", "decision_maker_email"];
const FIRST_NAME_FIELDS = ["first_name", "First Name", "decision_maker_name"];
const LAST_NAME_FIELDS = ["last_name", "Last Name"];
const COMPANY_FIELDS = ["company_name", "company", "business_name", "Company", "Company Name"];
const PHONE_FIELDS = ["phone_number", "Phone", "phone"];
const WEBSITE_FIELDS = ["website", "Website", "company_url", "url", "company_website", "company_domain"];
const LOCATION_FIELDS = ["location", "company_location", "Location", "city", "state"];

function parseArgs() {
  const args = process.argv.slice(2);
  const idx = (flag) => args.indexOf(flag);
  return {
    input: idx("--input") !== -1 ? args[idx("--input") + 1] : null,
    campaignId: idx("--campaign-id") !== -1 ? args[idx("--campaign-id") + 1] : null,
    batchSize: idx("--batch-size") !== -1 ? parseInt(args[idx("--batch-size") + 1], 10) : 400,
    dryRun: args.includes("--dry-run"),
  };
}

function mapLeadToSmartLead(row) {
  const email = findField(row, EMAIL_FIELDS);
  if (!email) return null;

  // Split decision_maker_name into first/last if dedicated fields are empty
  let firstName = findField(row, FIRST_NAME_FIELDS) || "";
  let lastName = findField(row, LAST_NAME_FIELDS) || "";
  if (firstName && !lastName && firstName.includes(" ")) {
    const parts = firstName.split(" ");
    firstName = parts[0];
    lastName = parts.slice(1).join(" ");
  }

  const lead = {
    email: email.trim().toLowerCase(),
    first_name: firstName,
    last_name: lastName,
    company_name: findField(row, COMPANY_FIELDS) || "",
    phone_number: findField(row, PHONE_FIELDS) || "",
    website: findField(row, WEBSITE_FIELDS) || "",
    location: findField(row, LOCATION_FIELDS) || "",
  };

  // Custom fields for segmentation
  const customFields = {};
  if (row.confidence) customFields.confidence = row.confidence;
  if (row.line_type) customFields.phone_type = row.line_type;
  if (row._source_query) customFields.source_query = row._source_query;
  if (row._source_file) customFields.source = "geolead";

  if (Object.keys(customFields).length > 0) {
    customFields.upload_batch = new Date().toISOString().split("T")[0];
    lead.custom_fields = customFields;
  }

  return lead;
}

async function main() {
  const opts = parseArgs();

  if (!opts.input || !opts.campaignId) {
    console.error(
      "Usage: node 3-outreach/upload_leads.js --input <csv> --campaign-id <id> [--batch-size 400] [--dry-run]"
    );
    process.exit(1);
  }

  const { records } = await readCsv(opts.input);
  console.log(`Loaded ${records.length} records from ${opts.input}`);

  // Map to SmartLead format, skip records without email
  const leads = [];
  const skipped = [];
  for (const row of records) {
    const mapped = mapLeadToSmartLead(row);
    if (mapped) {
      leads.push(mapped);
    } else {
      skipped.push(row);
    }
  }
  console.log(`Mapped: ${leads.length} leads (skipped ${skipped.length} without email)`);

  // Deduplicate by email
  const seen = new Set();
  const unique = [];
  for (const lead of leads) {
    if (!seen.has(lead.email)) {
      seen.add(lead.email);
      unique.push(lead);
    }
  }
  console.log(`After email dedup: ${unique.length} unique leads`);

  // Load checkpoint — skip already-uploaded emails
  ensureDir(projectPath("data", "reports"));
  const checkpoint = loadJsonl(CHECKPOINT_PATH);
  const uploaded = new Set(checkpoint.flatMap((r) => r.emails || []));
  const pending = unique.filter((l) => !uploaded.has(l.email));
  console.log(`Already uploaded: ${uploaded.size}, pending: ${pending.length}`);

  if (opts.dryRun) {
    console.log(`\n[DRY RUN] Would upload ${pending.length} leads to campaign ${opts.campaignId}`);
    console.log(`  Batches: ${Math.ceil(pending.length / opts.batchSize)} × ${opts.batchSize}`);
    console.log(`  Sample lead:`, JSON.stringify(pending[0], null, 2));
    return;
  }

  if (pending.length === 0) {
    console.log("Nothing to upload.");
    return;
  }

  const batches = chunkArray(pending, opts.batchSize);
  console.log(`Uploading ${pending.length} leads in ${batches.length} batches...`);

  let totalUploaded = 0;
  let totalDupes = 0;
  const failures = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      const result = await uploadLeads(opts.campaignId, batch);

      const batchEmails = batch.map((l) => l.email);
      appendJsonl(CHECKPOINT_PATH, {
        batch: i + 1,
        count: batch.length,
        emails: batchEmails,
        result,
        timestamp: new Date().toISOString(),
      });

      totalUploaded += batch.length;
      if (result && result.duplicate_count) {
        totalDupes += result.duplicate_count;
      }

      console.log(
        `  Batch ${i + 1}/${batches.length}: ${batch.length} leads uploaded` +
          (result && result.duplicate_count ? ` (${result.duplicate_count} dupes)` : "")
      );
    } catch (err) {
      console.error(`  Batch ${i + 1}/${batches.length} FAILED: ${err.message}`);
      for (const lead of batch) {
        failures.push({ ...lead, _error: err.message });
      }
    }
  }

  // Save failures
  if (failures.length > 0) {
    await writeCsv(FAILURES_PATH, failures);
    console.log(`\nFailed records saved to ${FAILURES_PATH}`);
  }

  console.log(`\n--- Upload Summary ---`);
  console.log(`Campaign:    ${opts.campaignId}`);
  console.log(`Uploaded:    ${totalUploaded}`);
  console.log(`Duplicates:  ${totalDupes}`);
  console.log(`Failures:    ${failures.length}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
