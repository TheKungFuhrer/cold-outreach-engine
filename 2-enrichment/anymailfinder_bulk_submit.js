#!/usr/bin/env node
/**
 * Submit a bulk company email search to AnyMailFinder.
 *
 * Uploads a CSV of domains + company names to the Bulk API (multipart).
 * Credits are charged on download, not on submission.
 *
 * Usage:
 *   node 2-enrichment/anymailfinder_bulk_submit.js
 *   node 2-enrichment/anymailfinder_bulk_submit.js --input data/anymailfinder/geolead_venues_for_bulk.csv
 */

const fs = require("fs");
const path = require("path");
const { requireEnv } = require("../shared/env");
const { saveJson } = require("../shared/progress");
const { projectPath } = require("../shared/utils");

const API_KEY = requireEnv("ANYMAILFINDER_API_KEY");
const API_URL = "https://api.anymailfinder.com/v5.1/bulk/multipart";
const DEFAULT_INPUT = projectPath("data", "anymailfinder", "geolead_venues_for_bulk.csv");
const SEARCH_STATE_PATH = projectPath("data", "anymailfinder", "geolead_bulk_search.json");

function parseArgs() {
  const args = process.argv.slice(2);
  const idx = (flag) => args.indexOf(flag);
  return {
    input: idx("--input") !== -1 ? args[idx("--input") + 1] : DEFAULT_INPUT,
  };
}

async function main() {
  const opts = parseArgs();

  if (!fs.existsSync(opts.input)) {
    console.error(`Input file not found: ${opts.input}`);
    console.error("Run Step 1 first to prepare the CSV.");
    process.exit(1);
  }

  const fileSize = fs.statSync(opts.input).size;
  const lineCount = fs.readFileSync(opts.input, "utf-8").split("\n").filter(Boolean).length - 1;
  console.log(`Input: ${opts.input} (${lineCount} rows, ${(fileSize / 1024).toFixed(1)} KB)`);

  // Build multipart form data manually
  const boundary = "----AnyMailBulk" + Date.now();
  const fileContent = fs.readFileSync(opts.input);
  const fileName = path.basename(opts.input);

  const parts = [];

  // File field
  parts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: text/csv\r\n\r\n`
  );
  parts.push(fileContent);
  parts.push("\r\n");

  // domain_field_index
  parts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="domain_field_index"\r\n\r\n` +
    `0\r\n`
  );

  // company_name_field_index
  parts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="company_name_field_index"\r\n\r\n` +
    `1\r\n`
  );

  // file_name
  parts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file_name"\r\n\r\n` +
    `geolead_venues_company_search_mar26\r\n`
  );

  parts.push(`--${boundary}--\r\n`);

  // Combine into a single buffer
  const body = Buffer.concat(
    parts.map((p) => (typeof p === "string" ? Buffer.from(p) : p))
  );

  console.log("Submitting bulk search to AnyMailFinder...");

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: API_KEY,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  const text = await res.text();

  if (!res.ok) {
    console.error(`API error ${res.status}: ${text}`);
    process.exit(1);
  }

  let result;
  try {
    result = JSON.parse(text);
  } catch {
    console.error("Failed to parse response:", text);
    process.exit(1);
  }

  console.log("\n--- Bulk Search Submitted ---");
  console.log(`Search ID: ${result.id || result.search_id || JSON.stringify(result)}`);
  console.log(`Status: ${result.status || "submitted"}`);
  console.log(`Response: ${JSON.stringify(result, null, 2)}`);

  // Save state for status/download scripts
  saveJson(SEARCH_STATE_PATH, {
    search_id: result.id || result.search_id,
    status: result.status || "submitted",
    submitted_at: new Date().toISOString(),
    input_file: opts.input,
    row_count: lineCount,
    raw_response: result,
  });

  console.log(`\nSaved to ${SEARCH_STATE_PATH}`);
  console.log("Check status with: node 2-enrichment/anymailfinder_bulk_status.js");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
