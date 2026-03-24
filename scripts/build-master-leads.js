#!/usr/bin/env node
/**
 * Build consolidated master_leads.csv from all data sources.
 * One row per unique domain+email combination with a "source" column.
 */

const { readCsv, writeCsv } = require("../shared/csv");
const { resolveField, normalizeRow } = require("../shared/fields");
const { normalizeDomain } = require("../shared/dedup");

async function run() {
  const masterRows = [];
  const seenDomainEmail = new Set();

  function addRows(records, source) {
    let added = 0;
    for (const row of records) {
      const domain = normalizeDomain(resolveField(row, "website"));
      const email = resolveField(row, "email").toLowerCase();
      const key = domain + "|" + email;
      if (!domain && !email) continue;
      if (seenDomainEmail.has(key)) continue;
      seenDomainEmail.add(key);

      const n = normalizeRow(row);
      masterRows.push({
        company_name: n.companyName,
        domain,
        email,
        phone_number: n.phone,
        location: n.location,
        first_name: n.firstName,
        last_name: n.lastName,
        is_venue: row.is_venue || "",
        confidence: row.confidence || "",
        line_type: row.line_type || "",
        source,
      });
      added++;
    }
    return added;
  }

  async function load(path, source) {
    try {
      const { records } = await readCsv(path);
      const added = addRows(records, source);
      console.log(`${path}: ${records.length} rows -> ${added} added`);
    } catch (e) {
      console.log(`${path}: skip (${e.message.split("\n")[0]})`);
    }
  }

  // Load classified sources FIRST so is_venue/confidence fields are preserved
  // (raw export has same domain+email but no classification fields)

  // Sonnet escalation (highest confidence — load first)
  await load("data/verified_geolead/venues.csv", "geolead_sonnet_venue");
  await load("data/verified_geolead/non_venues.csv", "geolead_sonnet_nonvenue");

  // Classified (original SmartLead)
  await load("data/classified/venues.csv", "original_smartlead_venue");
  await load("data/classified/non_venues.csv", "original_smartlead_nonvenue");
  await load("data/classified/ambiguous.csv", "original_smartlead_ambiguous");

  // GeoLead batch 1
  await load("data/classified_geolead/venues.csv", "geolead_batch1_venue");
  await load("data/classified_geolead/non_venues.csv", "geolead_batch1_nonvenue");
  await load("data/classified_geolead/ambiguous.csv", "geolead_batch1_ambiguous");

  // GeoLead batch 2 (manual inbox)
  await load("data/classified_geolead_batch2/venues.csv", "geolead_batch2_venue");
  await load("data/classified_geolead_batch2/non_venues.csv", "geolead_batch2_nonvenue");

  // Non-venue sub-classification
  await load("data/classified_services/event_service_providers.csv", "nonvenue_event_service");
  await load("data/classified_services/venue_adjacent.csv", "nonvenue_venue_adjacent");
  await load("data/classified_services/irrelevant.csv", "nonvenue_irrelevant");

  // Phone validated (pick up line_type for records not yet seen)
  await load("data/phone_validated/mobile.csv", "phone_validated_original");
  await load("data/phone_validated/landline.csv", "phone_validated_original");
  await load("data/phone_validated/no_phone.csv", "phone_validated_original");
  await load("data/phone_validated_geolead/mobile.csv", "phone_validated_geolead");
  await load("data/phone_validated_geolead/landline.csv", "phone_validated_geolead");
  await load("data/phone_validated_geolead/no_phone.csv", "phone_validated_geolead");

  // Raw exports and unclassified LAST (fills in anything not yet seen)
  await load("data/raw/campaign_2434779_2026-03-22T08-15-39.csv", "original_smartlead");
  await load("data/enriched/geolead_net_new.csv", "geolead_unclassified");

  // Write master
  const columns = ["company_name", "domain", "email", "phone_number", "location", "first_name", "last_name", "is_venue", "confidence", "line_type", "source"];
  await writeCsv("data/master_leads.csv", masterRows, columns);

  // Stats (is_venue may be "True"/"False"/"true"/"false")
  const venues = masterRows.filter(r => String(r.is_venue).toLowerCase() === "true").length;
  const nonVenues = masterRows.filter(r => String(r.is_venue).toLowerCase() === "false").length;
  const unclassified = masterRows.filter(r => !r.is_venue).length;
  const uniqueDomains = new Set(masterRows.map(r => r.domain).filter(Boolean)).size;

  console.log("\n--- Master Leads CSV ---");
  console.log(`Total rows:     ${masterRows.length}`);
  console.log(`Venues:         ${venues}`);
  console.log(`Non-venues:     ${nonVenues}`);
  console.log(`Unclassified:   ${unclassified}`);
  console.log(`Unique domains: ${uniqueDomains}`);
  console.log(`Saved to:       data/master_leads.csv`);
}

run().catch((err) => { console.error("Fatal:", err); process.exit(1); });
