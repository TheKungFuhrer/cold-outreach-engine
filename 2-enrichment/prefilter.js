#!/usr/bin/env node
/**
 * Pre-filter leads based on keywords in business name and email domain.
 * Zero AI cost - pure string matching.
 *
 * Input:  Most recent CSV in data/raw/ (or specify --input <file>)
 * Output: data/filtered/leads.csv (passing leads)
 *         data/excluded/leads.csv (excluded leads with reasons)
 *         data/excluded/summary.json (removal summary)
 */

const fs = require("fs");
const path = require("path");
const { projectPath, ensureDir } = require("../shared/utils");
const { readCsv, writeCsv, findField } = require("../shared/csv");

const DATA_RAW = projectPath("data", "raw");
const DATA_FILTERED = projectPath("data", "filtered");
const DATA_EXCLUDED = projectPath("data", "excluded");

ensureDir(DATA_FILTERED);
ensureDir(DATA_EXCLUDED);

// --- Exclusion rules ---
const RULES = [
  {
    category: "Government",
    patterns: [
      /\.gov$/i,
      /\bcounty\b/i,
      /\bcity of\b/i,
      /\bdepartment\b/i,
      /\bmunicipal/i,
      /\bstate of\b/i,
      /\bgovernment\b/i,
      /\bborough\b/i,
      /\btownship\b/i,
    ],
  },
  {
    category: "Parks & Recreation",
    patterns: [
      /\bparks?\b/i,
      /\brecreation\b/i,
      /\bpark district\b/i,
      /\bopen space\b/i,
      /\btrailhead\b/i,
    ],
  },
  {
    category: "Schools & Education",
    patterns: [
      /\bschool district\b/i,
      /\buniversity\b/i,
      /\bcollege\b/i,
      /\bk-12\b/i,
      /\bacademy\b/i,
      /\bschool board\b/i,
      /\.edu$/i,
    ],
  },
  {
    category: "Libraries",
    patterns: [/\blibrary\b/i, /\blibraries\b/i],
  },
  {
    category: "Hospitals & Medical",
    patterns: [
      /\bhospital\b/i,
      /\bmedical center\b/i,
      /\bclinic\b/i,
      /\bhealth department\b/i,
      /\bdental\b/i,
      /\bortho/i,
      /\bpharmac/i,
    ],
  },
  {
    category: "Religious (non-venue)",
    patterns: [
      /\bchurch\b/i,
      /\btemple\b/i,
      /\bmosque\b/i,
      /\bsynagogue\b/i,
      /\bparish\b/i,
      /\bdiocese\b/i,
      /\bministr/i,
    ],
  },
  {
    category: "Non-Venue Business",
    patterns: [
      /\binsurance\b/i,
      /\blaw office\b/i,
      /\blaw firm\b/i,
      /\battorney/i,
      /\bplumbing\b/i,
      /\belectrical\b/i,
      /\broofing\b/i,
      /\bhvac\b/i,
      /\bauto body\b/i,
      /\bauto repair\b/i,
      /\baccounting\b/i,
      /\bcpa\b/i,
      /\btax service/i,
      /\breal estate\b/i,
      /\brealty\b/i,
      /\bmortgage\b/i,
      /\blandscap/i,
      /\bpest control/i,
      /\btowing\b/i,
      /\bmoving company/i,
      /\bstorage\b/i,
      /\bveterinar/i,
      /\bkennel\b/i,
      /\bday ?care\b/i,
      /\bpreschool\b/i,
    ],
  },
];

// Fields to check for pattern matching
const NAME_FIELDS = [
  "company_name", "company", "business_name", "first_name",
  "last_name", "name", "Company", "Company Name",
];
const EMAIL_FIELDS = ["email", "Email", "email_address", "one_email"];
const WEBSITE_FIELDS = ["website", "Website", "company_url", "url", "company_website"];
const CATEGORY_FIELDS = ["category", "lead_category", "Category"];

// Social media URLs — flagged but still passed through
const SOCIAL_MEDIA_PATTERNS = [
  /facebook\.com/i, /fb\.com/i, /yelp\.com/i,
  /google\.com\/maps/i, /maps\.google/i,
  /instagram\.com/i, /twitter\.com/i, /x\.com/i,
  /linkedin\.com/i, /tiktok\.com/i, /pinterest\.com/i,
  /tripadvisor\.com/i, /weddingwire\.com/i, /theknot\.com/i,
];

const SKIP_CATEGORIES = [
  "unsubscribed", "do not contact", "opted out", "bounced", "not interested",
];

function getInputFile() {
  const inputArg = process.argv.indexOf("--input");
  if (inputArg !== -1 && process.argv[inputArg + 1]) {
    return process.argv[inputArg + 1];
  }
  const files = fs
    .readdirSync(DATA_RAW)
    .filter((f) => f.endsWith(".csv"))
    .sort()
    .reverse();
  if (files.length === 0) {
    console.error("No CSV files found in data/raw/. Run pull_leads.js first.");
    process.exit(1);
  }
  return path.join(DATA_RAW, files[0]);
}

function main() {
  const inputFile = getInputFile();
  console.log(`Reading: ${inputFile}`);

  const { records } = readCsv(inputFile);
  console.log(`Total leads: ${records.length}`);

  const filtered = [];
  const excluded = [];
  const summary = {
    total: records.length,
    excluded: 0,
    passed: 0,
    social_media_flagged: 0,
    by_category: {},
  };

  for (const row of records) {
    // Skip unsubscribed leads
    if (row.is_unsubscribed === "true" || row.is_unsubscribed === true) {
      excluded.push({ ...row, _exclusion_reason: "Unsubscribed" });
      summary.by_category["Unsubscribed"] =
        (summary.by_category["Unsubscribed"] || 0) + 1;
      continue;
    }

    // Skip already opted-out leads by category
    const category = findField(row, CATEGORY_FIELDS).toLowerCase();
    if (SKIP_CATEGORIES.some((sc) => category.includes(sc))) {
      excluded.push({ ...row, _exclusion_reason: "Already opted out: " + category });
      summary.by_category["Already Opted Out"] =
        (summary.by_category["Already Opted Out"] || 0) + 1;
      continue;
    }

    const name = findField(row, NAME_FIELDS);
    const email = findField(row, EMAIL_FIELDS);
    const textToCheck = `${name} ${email}`;

    let matched = false;
    for (const rule of RULES) {
      for (const pattern of rule.patterns) {
        if (pattern.test(textToCheck)) {
          excluded.push({ ...row, _exclusion_reason: `${rule.category}: matched ${pattern}` });
          summary.by_category[rule.category] =
            (summary.by_category[rule.category] || 0) + 1;
          matched = true;
          break;
        }
      }
      if (matched) break;
    }

    if (!matched) {
      const website = findField(row, WEBSITE_FIELDS).trim();
      if (!website) {
        excluded.push({ ...row, _exclusion_reason: "No Website" });
        summary.by_category["No Website"] =
          (summary.by_category["No Website"] || 0) + 1;
        continue;
      }

      const isSocialMedia = SOCIAL_MEDIA_PATTERNS.some((p) => p.test(website));
      if (isSocialMedia) {
        row._social_media_flag = website;
        summary.social_media_flagged++;
      }

      filtered.push(row);
    }
  }

  summary.excluded = excluded.length;
  summary.passed = filtered.length;

  // Write outputs
  if (filtered.length > 0) {
    const headers = [...Object.keys(records[0]), "_social_media_flag"];
    writeCsv(path.join(DATA_FILTERED, "leads.csv"), filtered, headers);
  }

  if (excluded.length > 0) {
    const headers = [...Object.keys(records[0]), "_exclusion_reason"];
    writeCsv(path.join(DATA_EXCLUDED, "leads.csv"), excluded, headers);
  }

  fs.writeFileSync(
    path.join(DATA_EXCLUDED, "summary.json"),
    JSON.stringify(summary, null, 2)
  );

  console.log("\n--- Pre-Filter Summary ---");
  console.log(`Total leads:    ${summary.total}`);
  console.log(`Excluded:       ${summary.excluded}`);
  console.log(`Passed:         ${summary.passed}`);
  console.log(`  (social media URL flagged: ${summary.social_media_flagged})`);
  console.log("\nExclusions by category:");
  for (const [cat, count] of Object.entries(summary.by_category).sort(
    (a, b) => b[1] - a[1]
  )) {
    console.log(`  ${cat}: ${count}`);
  }
}

// Export RULES for reuse by other scripts
module.exports = { RULES, NAME_FIELDS, EMAIL_FIELDS, WEBSITE_FIELDS };

main();
