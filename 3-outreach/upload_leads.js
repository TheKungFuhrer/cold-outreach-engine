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

const { readCsv, writeCsv } = require("../shared/csv");
const { resolveField, normalizeRow } = require("../shared/fields");
const { uploadLeads, chunkArray } = require("../shared/smartlead");
const { loadJsonl, appendJsonl } = require("../shared/progress");
const { projectPath, ensureDir, timestamp } = require("../shared/utils");

let identityAvailable = false;
try {
  var { openDb: openIdentityDb, closeDb: closeIdentityDb } = require("../shared/identity-db");
  var { checkOverlaps, markSuppressed } = require("../shared/identity");
  identityAvailable = true;
} catch {
  // Identity layer not installed — skip suppression
}

const CHECKPOINT_PATH = projectPath("data", "reports", ".upload_progress.jsonl");
const FAILURES_PATH = projectPath("data", "reports", "upload_failures.csv");

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
  const n = normalizeRow(row);
  if (!n.email) return null;

  const lead = {
    email: n.email,
    first_name: n.firstName,
    last_name: n.lastName,
    company_name: n.companyName,
    phone_number: n.phone,
    website: n.website,
    location: n.location,
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
  let unique = [];
  for (const lead of leads) {
    if (!seen.has(lead.email)) {
      seen.add(lead.email);
      unique.push(lead);
    }
  }
  console.log(`After email dedup: ${unique.length} unique leads`);

  // --- Identity layer: suppress Skool members ---
  if (identityAvailable) {
    try {
      openIdentityDb();
      const batchEmails = unique.map((l) => l.email);
      const suppressed = checkOverlaps(batchEmails);
      if (suppressed.length > 0) {
        const suppressedSet = new Set(suppressed);
        const beforeCount = unique.length;
        unique = unique.filter((l) => !suppressedSet.has(l.email.trim().toLowerCase()));
        markSuppressed(suppressed);
        console.log(`Identity layer: suppressed ${suppressed.length} Skool members (${beforeCount} → ${unique.length})`);
      }
      closeIdentityDb();
    } catch (err) {
      console.log(`Identity layer warning: ${err.message} — continuing without suppression`);
    }
  }

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
