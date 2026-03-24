#!/usr/bin/env node
/**
 * Merge all classification results into a final clean CSV.
 * Combines confirmed venues from Haiku classification + Sonnet escalation.
 *
 * Output: data/final/clean_venues_<timestamp>.csv
 */

const path = require("path");
const { projectPath } = require("../shared/utils");
const { readCsv, writeCsv } = require("../shared/csv");
const { timestamp } = require("../shared/utils");

const DATA_FINAL = projectPath("data", "final");

// All directories that may contain classified/verified venue CSVs
const VENUE_SOURCES = [
  { dir: projectPath("data", "classified"), label: "Classified" },
  { dir: projectPath("data", "verified"), label: "Sonnet verified" },
];

function safeReadCsv(filepath) {
  try {
    return readCsv(filepath);
  } catch {
    return { records: [], columns: [] };
  }
}

function main() {
  const allSources = [];
  for (const { dir, label } of VENUE_SOURCES) {
    const { records } = safeReadCsv(path.join(dir, "venues.csv"));
    if (records.length > 0) {
      console.log(`${label} venues: ${records.length}`);
      allSources.push(...records);
    }
  }

  const haikuVenues = allSources; // combined from all sources
  const sonnetVenues = []; // already included above

  // Merge, deduplicating by email
  const seen = new Set();
  const allVenues = [];

  for (const lead of [...haikuVenues, ...sonnetVenues]) {
    const email = (lead.email || lead.Email || "").toLowerCase();
    if (email && seen.has(email)) continue;
    if (email) seen.add(email);
    allVenues.push(lead);
  }

  if (allVenues.length === 0) {
    console.log("No confirmed venues found. Run classification steps first.");
    process.exit(0);
  }

  // Strip classification metadata from output
  const metaFields = new Set([
    "is_venue", "confidence", "reasoning",
    "sonnet_is_venue", "sonnet_confidence", "sonnet_reasoning",
    "_exclusion_reason",
  ]);
  const columns = Object.keys(allVenues[0]).filter((k) => !metaFields.has(k));

  const outFile = path.join(DATA_FINAL, `clean_venues_${timestamp()}.csv`);
  writeCsv(outFile, allVenues, columns);

  console.log(`\n--- Final Export ---`);
  console.log(`Total clean venues: ${allVenues.length}`);
  console.log(`Saved to: ${outFile}`);
}

main();
