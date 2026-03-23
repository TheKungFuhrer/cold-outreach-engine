#!/usr/bin/env node
/**
 * SmartLead Prospect Find-Emails — discover contacts for venue domains.
 *
 * Uses SmartLead CLI `prospect find-emails` as a free alternative to AnyMailFinder.
 * Rate-limited to 5 req/s (SmartLead limit: 10 req/2s, leaving headroom).
 * Resumable via JSONL checkpoint.
 *
 * Usage:
 *   node 3-outreach/prospect_emails.js --input data/final/clean_venues.csv
 *   node 3-outreach/prospect_emails.js --input data/classified/venues.csv --limit 50
 *   node 3-outreach/prospect_emails.js --dry-run
 */

const { execSync } = require("child_process");
const { readCsv, writeCsv, findField } = require("../shared/csv");
const { loadJsonl, appendJsonl } = require("../shared/progress");
const { projectPath, ensureDir, timestamp } = require("../shared/utils");

const DOMAIN_FIELDS = [
  "website", "Website", "company_url", "url", "company_website", "company_domain",
];
const NAME_FIELDS = [
  "company_name", "company", "business_name", "Company", "Company Name",
];

const CHECKPOINT_PATH = projectPath("data", "enriched", ".prospect_progress.jsonl");
const OUTPUT_DIR = projectPath("data", "enriched");
const DELAY_MS = 200; // 5 req/s

function parseArgs() {
  const args = process.argv.slice(2);
  const idx = (flag) => args.indexOf(flag);
  return {
    input: idx("--input") !== -1 ? args[idx("--input") + 1] : null,
    limit: idx("--limit") !== -1 ? parseInt(args[idx("--limit") + 1], 10) : Infinity,
    dryRun: args.includes("--dry-run"),
  };
}

function extractDomain(raw) {
  if (!raw) return null;
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/^www\./, "");
  d = d.split("/")[0].split("?")[0];
  return d || null;
}

function findEmailsForDomain(domain, companyName) {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");

  // SmartLead CLI requires a JSON file: {"contacts": [{firstName, lastName, companyDomain}]}
  const tmpFile = path.join(os.tmpdir(), `prospect_${Date.now()}.json`);
  const payload = {
    contacts: [{ firstName: "", lastName: "", companyDomain: domain }],
  };

  try {
    fs.writeFileSync(tmpFile, JSON.stringify(payload));
    const output = execSync(
      `smartlead prospect find-emails --from-json "${tmpFile}"`,
      { timeout: 30000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    fs.unlinkSync(tmpFile);

    // Extract JSON from output (may have warnings before the JSON)
    const jsonStart = output.indexOf("{");
    if (jsonStart === -1) {
      return { emails: [], raw: output.trim(), error: "No JSON in output" };
    }
    const parsed = JSON.parse(output.slice(jsonStart));
    const data = parsed.data || [];
    const emails = data
      .filter((r) => r.email_id && r.status !== "Not Found")
      .map((r) => r.email_id);
    const statuses = data.map((r) => r.status);
    return { emails, statuses, raw: parsed, error: null };
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch {}
    return { emails: [], raw: null, error: err.message.split("\n")[0] };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const opts = parseArgs();

  if (!opts.input) {
    console.error("Usage: node 3-outreach/prospect_emails.js --input <csv> [--limit N] [--dry-run]");
    process.exit(1);
  }

  const { records, columns } = await readCsv(opts.input);
  console.log(`Loaded ${records.length} records from ${opts.input}`);

  // Build set of domains to process
  const domainMap = new Map(); // domain → record
  for (const row of records) {
    const rawDomain = findField(row, DOMAIN_FIELDS);
    const domain = extractDomain(rawDomain);
    if (domain && !domainMap.has(domain)) {
      domainMap.set(domain, row);
    }
  }
  console.log(`Unique domains: ${domainMap.size}`);

  // Load checkpoint — skip already-processed domains
  const checkpoint = loadJsonl(CHECKPOINT_PATH);
  const done = new Set(checkpoint.map((r) => r.domain));
  console.log(`Already processed: ${done.size}`);

  const pending = [...domainMap.keys()].filter((d) => !done.has(d));
  const toProcess = pending.slice(0, opts.limit);
  console.log(`To process: ${toProcess.length}${opts.limit < Infinity ? ` (limited to ${opts.limit})` : ""}`);

  if (opts.dryRun) {
    console.log("\n[DRY RUN] Would process these domains:");
    toProcess.slice(0, 20).forEach((d) => console.log(`  ${d}`));
    if (toProcess.length > 20) console.log(`  ... and ${toProcess.length - 20} more`);
    return;
  }

  ensureDir(OUTPUT_DIR);

  let found = 0;
  let errors = 0;
  let totalEmails = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const domain = toProcess[i];
    const companyName = findField(domainMap.get(domain), NAME_FIELDS) || "";
    const result = findEmailsForDomain(domain, companyName);

    const record = {
      domain,
      company_name: findField(domainMap.get(domain), NAME_FIELDS) || "",
      emails: result.emails,
      email_count: result.emails.length,
      error: result.error,
      timestamp: new Date().toISOString(),
    };

    appendJsonl(CHECKPOINT_PATH, record);

    if (result.error) {
      errors++;
    } else if (result.emails.length > 0) {
      found++;
      totalEmails += result.emails.length;
    }

    if ((i + 1) % 10 === 0 || i === toProcess.length - 1) {
      console.log(
        `  [${i + 1}/${toProcess.length}] found=${found} emails=${totalEmails} errors=${errors}`
      );
    }

    if (i < toProcess.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  // Write summary CSV of all results (checkpoint + new)
  const allResults = loadJsonl(CHECKPOINT_PATH);
  const csvRows = [];
  for (const r of allResults) {
    if (r.emails && r.emails.length > 0) {
      for (const email of r.emails) {
        csvRows.push({
          domain: r.domain,
          company_name: r.company_name || "",
          email,
          source: "smartlead_prospect",
        });
      }
    }
  }

  if (csvRows.length > 0) {
    const outPath = projectPath("data", "enriched", "prospect_emails.csv");
    await writeCsv(outPath, csvRows, ["domain", "company_name", "email", "source"]);
    console.log(`\nWrote ${csvRows.length} emails to ${outPath}`);
  }

  console.log(`\n--- Prospect Find-Emails Summary ---`);
  console.log(`Processed:    ${toProcess.length}`);
  console.log(`Domains hit:  ${found} (${((found / toProcess.length) * 100).toFixed(1)}%)`);
  console.log(`Total emails: ${totalEmails}`);
  console.log(`Errors:       ${errors}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
