#!/usr/bin/env node
/**
 * Pipeline funnel report — row counts and conversion rates at each stage.
 *
 * Usage:
 *   node 4-analytics/funnel_report.js
 *   node 4-analytics/funnel_report.js --json
 */

const fs = require("fs");
const path = require("path");
const { readCsv } = require("../shared/csv");
const { saveJson } = require("../shared/progress");
const { projectPath, ensureDir, timestamp } = require("../shared/utils");

const STAGES = [
  { name: "GeoLead net-new", path: "data/enriched/geolead_net_new.csv" },
  { name: "Post pre-filter", path: "data/filtered/leads.csv" },
  { name: "Classified venues (orig)", path: "data/classified/venues.csv" },
  { name: "Classified non-venues (orig)", path: "data/classified/non_venues.csv" },
  { name: "Classified ambiguous (orig)", path: "data/classified/ambiguous.csv" },
  { name: "Classified venues (geolead)", path: "data/classified_geolead/venues.csv" },
  { name: "Classified non-venues (geolead)", path: "data/classified_geolead/non_venues.csv" },
  { name: "Classified ambiguous (geolead)", path: "data/classified_geolead/ambiguous.csv" },
  { name: "Sonnet → venues (orig)", path: "data/verified/venues.csv" },
  { name: "Sonnet → venues (geolead)", path: "data/verified_geolead/venues.csv" },
  { name: "Phone: mobile (orig)", path: "data/phone_validated/mobile.csv" },
  { name: "Phone: landline (orig)", path: "data/phone_validated/landline.csv" },
  { name: "Phone: invalid (orig)", path: "data/phone_validated/invalid.csv" },
  { name: "Phone: no phone (orig)", path: "data/phone_validated/no_phone.csv" },
  { name: "Phone: mobile (geolead)", path: "data/phone_validated_geolead/mobile.csv" },
  { name: "Phone: landline (geolead)", path: "data/phone_validated_geolead/landline.csv" },
  { name: "Phone: invalid (geolead)", path: "data/phone_validated_geolead/invalid.csv" },
  { name: "Phone: no phone (geolead)", path: "data/phone_validated_geolead/no_phone.csv" },
];

async function countRecords(filePath) {
  const full = projectPath(filePath);
  try {
    const stat = fs.statSync(full);
    if (stat.size === 0) return 0;
    const { records } = await readCsv(full);
    return records.length;
  } catch {
    return null;
  }
}

function findLatestCleanExport() {
  const dir = projectPath("data", "final");
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".csv"))
      .sort()
      .reverse();
    return files.length > 0 ? path.join("data", "final", files[0]) : null;
  } catch {
    return null;
  }
}

async function main() {
  const jsonMode = process.argv.includes("--json");

  console.log("=== Pipeline Funnel Report ===\n");

  const results = [];

  for (const stage of STAGES) {
    const count = await countRecords(stage.path);
    results.push({ name: stage.name, path: stage.path, count });
  }

  // Clean export
  const exportPath = findLatestCleanExport();
  if (exportPath) {
    const count = await countRecords(exportPath);
    results.push({ name: "Clean export", path: exportPath, count });
  }

  // Print table
  const maxName = Math.max(...results.map((r) => r.name.length));
  const first = results.find((r) => r.count !== null && r.count > 0);

  for (const r of results) {
    const countStr =
      r.count === null ? "—" : r.count.toLocaleString().padStart(8);
    const pct =
      first && r.count !== null && first.count > 0
        ? ((r.count / first.count) * 100).toFixed(1).padStart(6) + "%"
        : "       ";
    console.log(`  ${r.name.padEnd(maxName)}  ${countStr}  ${pct}`);
  }

  // Save JSON report
  ensureDir(projectPath("data", "reports"));
  const report = {
    generated_at: new Date().toISOString(),
    stages: results,
  };

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  }

  const outPath = projectPath("data", "reports", `funnel_report_${timestamp()}.json`);
  saveJson(outPath, report);
  console.log(`\nSaved to ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
