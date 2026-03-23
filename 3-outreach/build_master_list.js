#!/usr/bin/env node
/**
 * Build a master enriched email list from all sources.
 *
 * Merges:
 * 1. AnyMailFinder additional contacts (original 55K)
 * 2. AnyMailFinder GeoLead bulk results (40K)
 * 3. AnyMailFinder batch2 contacts (if exists)
 * 4. Primary venue/non-venue emails from upload CSVs
 *
 * Deduplicates by email, marks which are already in SmartLead.
 *
 * Usage:
 *   node 3-outreach/build_master_list.js
 */

const fs = require("fs");
const { readCsv, writeCsv, findField } = require("../shared/csv");
const { loadJsonl } = require("../shared/progress");
const { projectPath, ensureDir } = require("../shared/utils");

const OUTPUT_PATH = projectPath("data", "upload", "master_enriched_emails.csv");

const EMAIL_FIELDS = [
  "email", "Email", "email_address", "one_email", "decision_maker_email",
];
const NAME_FIELDS = [
  "company_name", "company", "business_name", "venue_name", "Company", "Company Name",
];
const DOMAIN_FIELDS = [
  "domain", "company_domain", "website", "Website", "company_url", "company_website",
];
const PHONE_FIELDS = ["phone_number", "Phone", "phone"];
const FIRST_NAME_FIELDS = ["first_name", "First Name", "decision_maker_name"];
const LAST_NAME_FIELDS = ["last_name", "Last Name"];

function safeReadCsv(filepath) {
  try {
    return readCsv(filepath);
  } catch {
    return { records: [], columns: [] };
  }
}

function loadSmartLeadEmails() {
  const emails = new Set();
  // From upload checkpoint
  const checkpointPath = projectPath("data", "reports", ".upload_progress.jsonl");
  try {
    const entries = loadJsonl(checkpointPath);
    for (const entry of entries) {
      for (const e of entry.emails || []) {
        emails.add(e.toLowerCase());
      }
    }
  } catch {}
  return emails;
}

function extractEmailsFromAmfRow(row) {
  // AnyMailFinder additional_contacts.csv has semicolon-separated emails
  const results = [];
  const emailsStr = row.valid_emails || row.emails_found || "";
  const emails = emailsStr.split(";").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const domain = (row.domain || "").trim();
  const companyName = (row.venue_name || row.company_name || "").trim();

  for (const email of emails) {
    results.push({
      email,
      company_name: companyName,
      domain,
      phone_number: "",
      first_name: "",
      last_name: "",
    });
  }
  return results;
}

function extractEmailFromStandardRow(row) {
  const email = findField(row, EMAIL_FIELDS);
  if (!email) return null;

  let firstName = findField(row, FIRST_NAME_FIELDS) || "";
  let lastName = findField(row, LAST_NAME_FIELDS) || "";
  if (firstName && !lastName && firstName.includes(" ")) {
    const parts = firstName.split(" ");
    firstName = parts[0];
    lastName = parts.slice(1).join(" ");
  }

  return {
    email: email.trim().toLowerCase(),
    company_name: findField(row, NAME_FIELDS) || "",
    domain: findField(row, DOMAIN_FIELDS) || "",
    phone_number: findField(row, PHONE_FIELDS) || "",
    first_name: firstName,
    last_name: lastName,
  };
}

function main() {
  console.log("=== Building Master Enriched Email List ===\n");

  const allEmails = new Map(); // email -> {record, source}
  const sourceCounts = {};

  function addEmails(records, source, extractor) {
    let count = 0;
    for (const row of records) {
      const extracted = extractor(row);
      const items = Array.isArray(extracted) ? extracted : extracted ? [extracted] : [];
      for (const item of items) {
        if (!item || !item.email) continue;
        if (!allEmails.has(item.email)) {
          allEmails.set(item.email, { ...item, source });
          count++;
        }
      }
    }
    sourceCounts[source] = count;
    console.log(`  ${source}: ${records.length} rows -> ${count} unique emails added`);
  }

  // Source 1: Original AnyMailFinder additional contacts (55K)
  const amf1 = safeReadCsv(
    projectPath("data", "anymailfinder", "additional_contacts.csv")
  );
  addEmails(amf1.records, "anymailfinder_original", extractEmailsFromAmfRow);

  // Source 2: GeoLead bulk search results (40K)
  const amf2 = safeReadCsv(
    projectPath("data", "anymailfinder", "geolead_additional_contacts.csv")
  );
  addEmails(amf2.records, "anymailfinder_geolead_bulk", extractEmailFromStandardRow);

  // Source 3: Batch2 contacts (if exists)
  const amf3 = safeReadCsv(
    projectPath("data", "anymailfinder", "additional_contacts_batch2.csv")
  );
  if (amf3.records.length > 0) {
    addEmails(amf3.records, "anymailfinder_batch2", extractEmailFromStandardRow);
  }

  // Source 4: Primary venue emails (all_venues.csv)
  const venues = safeReadCsv(projectPath("data", "upload", "all_venues.csv"));
  addEmails(venues.records, "primary_venue", extractEmailFromStandardRow);

  // Source 5: Primary non-venue emails (all_non_venues.csv)
  const nonVenues = safeReadCsv(
    projectPath("data", "upload", "all_non_venues.csv")
  );
  addEmails(nonVenues.records, "primary_non_venue", extractEmailFromStandardRow);

  console.log(`\nTotal unique emails: ${allEmails.size}`);

  // Mark which are already in SmartLead
  const smartleadEmails = loadSmartLeadEmails();
  console.log(`Already in SmartLead: ${smartleadEmails.size}`);

  let inSmartLead = 0;
  let netNew = 0;
  const outputRows = [];

  for (const [email, record] of allEmails) {
    const alreadyUploaded = smartleadEmails.has(email);
    if (alreadyUploaded) inSmartLead++;
    else netNew++;

    outputRows.push({
      email: record.email,
      first_name: record.first_name || "",
      last_name: record.last_name || "",
      company_name: record.company_name || "",
      phone_number: record.phone_number || "",
      website: record.domain || "",
      source: record.source,
      in_smartlead: alreadyUploaded ? "yes" : "no",
    });
  }

  // Write master list
  ensureDir(projectPath("data", "upload"));
  const columns = [
    "email", "first_name", "last_name", "company_name",
    "phone_number", "website", "source", "in_smartlead",
  ];
  writeCsv(OUTPUT_PATH, outputRows, columns);

  console.log(`\n--- Master List Summary ---`);
  console.log(`Total unique emails:     ${allEmails.size}`);
  console.log(`Already in SmartLead:    ${inSmartLead}`);
  console.log(`Net-new (not uploaded):  ${netNew}`);
  console.log(`\nBreakdown by source:`);
  for (const [source, count] of Object.entries(sourceCounts)) {
    console.log(`  ${source}: ${count}`);
  }
  console.log(`\nSaved to ${OUTPUT_PATH}`);
}

main();
