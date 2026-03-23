#!/usr/bin/env node
/**
 * Check status of an AnyMailFinder bulk search.
 *
 * Usage:
 *   node 2-enrichment/anymailfinder_bulk_status.js
 *   node 2-enrichment/anymailfinder_bulk_status.js --id <search_id>
 */

const { requireEnv } = require("../shared/env");
const { loadJson } = require("../shared/progress");
const { projectPath } = require("../shared/utils");

const API_KEY = requireEnv("ANYMAILFINDER_API_KEY");
const SEARCH_STATE_PATH = projectPath("data", "anymailfinder", "geolead_bulk_search.json");

function parseArgs() {
  const args = process.argv.slice(2);
  const idx = (flag) => args.indexOf(flag);
  return {
    id: idx("--id") !== -1 ? args[idx("--id") + 1] : null,
  };
}

async function main() {
  const opts = parseArgs();

  let searchId = opts.id;
  if (!searchId) {
    const state = loadJson(SEARCH_STATE_PATH);
    if (!state || !state.search_id) {
      console.error("No search ID provided and no saved state found.");
      console.error("Usage: node 2-enrichment/anymailfinder_bulk_status.js --id <search_id>");
      process.exit(1);
    }
    searchId = state.search_id;
    console.log(`Using saved search ID: ${searchId}`);
  }

  const url = `https://api.anymailfinder.com/v5.1/bulk/${searchId}`;
  const res = await fetch(url, {
    headers: { Authorization: API_KEY },
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`API error ${res.status}: ${text}`);
    process.exit(1);
  }

  const result = JSON.parse(text);

  console.log("\n--- Bulk Search Status ---");
  console.log(`Search ID:     ${searchId}`);
  console.log(`Status:        ${result.status}`);

  if (result.counts) {
    const c = result.counts;
    console.log(`Total rows:    ${c.total || "—"}`);
    console.log(`Found valid:   ${c.found_valid || 0}`);
    console.log(`Found unknown: ${c.found_unknown || 0}`);
    console.log(`Not found:     ${c.not_found || 0}`);
    console.log(`Failed:        ${c.failed || 0}`);
  }

  if (result.credits_needed != null) {
    console.log(`Credits needed: ${result.credits_needed}`);
  }

  if (result.status === "completed") {
    console.log("\nSearch complete! Download with:");
    console.log(`  node 2-enrichment/anymailfinder_bulk_download.js --id ${searchId}`);
  } else {
    console.log("\nStill processing. Re-run this script to check again.");
  }

  // Print full response for debugging
  console.log(`\nFull response: ${JSON.stringify(result, null, 2)}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
