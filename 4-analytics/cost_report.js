#!/usr/bin/env node
/**
 * API cost report — estimates spend across classification, validation, and verification.
 *
 * Pricing (as of 2026-03):
 *   Haiku batch:  $0.80/MTok input, $4.00/MTok output (50% batch discount applied)
 *   Sonnet batch: $1.50/MTok input, $7.50/MTok output (50% batch discount applied)
 *   Numverify:    Free tier 10,000/month
 *   SmartLead:    Included in subscription (80,000 email verifications)
 *
 * Usage:
 *   node 4-analytics/cost_report.js
 */

const fs = require("fs");
const { readCsv } = require("../shared/csv");
const { loadJsonl, saveJson } = require("../shared/progress");
const { projectPath, ensureDir, timestamp } = require("../shared/utils");

// Estimated tokens per lead (prompt + response)
const HAIKU_INPUT_PER_LEAD = 250; // ~250 input tokens per classification request
const HAIKU_OUTPUT_PER_LEAD = 60; // ~60 output tokens per classification response
const SONNET_INPUT_PER_LEAD = 300;
const SONNET_OUTPUT_PER_LEAD = 80;

// Batch pricing per million tokens (50% discount already applied)
const HAIKU_INPUT_COST = 0.80;
const HAIKU_OUTPUT_COST = 4.00;
const SONNET_INPUT_COST = 1.50;
const SONNET_OUTPUT_COST = 7.50;

async function safeCount(filePath) {
  try {
    const { records } = await readCsv(projectPath(filePath));
    return records.length;
  } catch {
    return 0;
  }
}

function safeJsonlCount(filePath) {
  try {
    return loadJsonl(projectPath(filePath)).length;
  } catch {
    return 0;
  }
}

async function main() {
  console.log("=== API Cost Report ===\n");

  // Count records at each stage
  const haikuVenues = await safeCount("data/classified/venues.csv");
  const haikuNon = await safeCount("data/classified/non_venues.csv");
  const haikuAmb = await safeCount("data/classified/ambiguous.csv");
  const haikuTotal = haikuVenues + haikuNon + haikuAmb;

  const sonnetVenues = await safeCount("data/verified/venues.csv");
  const sonnetNon = await safeCount("data/verified/non_venues.csv");
  const sonnetTotal = sonnetVenues + sonnetNon;

  const phoneValidated = safeJsonlCount("data/phone_validated/results.jsonl");

  // Calculate costs
  const haikuInputCost = (haikuTotal * HAIKU_INPUT_PER_LEAD / 1_000_000) * HAIKU_INPUT_COST;
  const haikuOutputCost = (haikuTotal * HAIKU_OUTPUT_PER_LEAD / 1_000_000) * HAIKU_OUTPUT_COST;
  const haikuCost = haikuInputCost + haikuOutputCost;

  const sonnetInputCost = (sonnetTotal * SONNET_INPUT_PER_LEAD / 1_000_000) * SONNET_INPUT_COST;
  const sonnetOutputCost = (sonnetTotal * SONNET_OUTPUT_PER_LEAD / 1_000_000) * SONNET_OUTPUT_COST;
  const sonnetCost = sonnetInputCost + sonnetOutputCost;

  const totalCost = haikuCost + sonnetCost;

  // Print report
  console.log("Haiku Classification (Batch API, 50% discount):");
  console.log(`  Records:      ${haikuTotal.toLocaleString()}`);
  console.log(`  Input cost:   $${haikuInputCost.toFixed(2)}`);
  console.log(`  Output cost:  $${haikuOutputCost.toFixed(2)}`);
  console.log(`  Subtotal:     $${haikuCost.toFixed(2)}`);
  console.log();

  console.log("Sonnet Escalation (Batch API, 50% discount):");
  console.log(`  Records:      ${sonnetTotal.toLocaleString()}`);
  console.log(`  Input cost:   $${sonnetInputCost.toFixed(2)}`);
  console.log(`  Output cost:  $${sonnetOutputCost.toFixed(2)}`);
  console.log(`  Subtotal:     $${sonnetCost.toFixed(2)}`);
  console.log();

  console.log("Numverify Phone Validation:");
  console.log(`  API calls:    ${phoneValidated.toLocaleString()}`);
  console.log(`  Cost:         $0.00 (free tier)`);
  console.log();

  console.log("SmartLead Email Verification:");
  console.log(`  Cost:         $0.00 (included in subscription)`);
  console.log();

  console.log(`--- Total Estimated Spend: $${totalCost.toFixed(2)} ---`);

  // Save report
  ensureDir(projectPath("data", "reports"));
  const report = {
    generated_at: new Date().toISOString(),
    haiku: { records: haikuTotal, cost: haikuCost },
    sonnet: { records: sonnetTotal, cost: sonnetCost },
    numverify: { calls: phoneValidated, cost: 0 },
    smartlead_verification: { cost: 0 },
    total_cost: totalCost,
  };
  const outPath = projectPath("data", "reports", `cost_report_${timestamp()}.json`);
  saveJson(outPath, report);
  console.log(`\nSaved to ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
