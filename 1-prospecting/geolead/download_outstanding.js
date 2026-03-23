#!/usr/bin/env node
/**
 * Download outstanding GeoLead searches from AnyMailFinder.
 *
 * Finds searches in .geolead_progress.json that are created but not downloaded,
 * polls queued ones until complete, downloads results, and updates progress.
 *
 * Usage:
 *   node 1-prospecting/geolead/download_outstanding.js
 */

const fs = require("fs");
const path = require("path");
const { requireEnv } = require("../../shared/env");
const { loadJson, saveJson } = require("../../shared/progress");
const { projectPath, ensureDir } = require("../../shared/utils");

const API_KEY = requireEnv("ANYMAILFINDER_API_KEY");
const PROGRESS_PATH = projectPath("data", "anymailfinder", ".geolead_progress.json");
const RESULTS_DIR = projectPath("data", "anymailfinder", "geolead_results");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiGet(endpoint) {
  const url = `https://api.anymailfinder.com/v5.1${endpoint}`;
  const res = await fetch(url, {
    headers: { Authorization: API_KEY },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res;
}

async function checkStatus(searchId) {
  const res = await apiGet(`/geo-lead/${searchId}`);
  return res.json();
}

async function downloadResults(searchId) {
  const res = await apiGet(
    `/geo-lead/${searchId}/download?download_as=csv&format=default`
  );
  return res.text();
}

async function main() {
  const progress = loadJson(PROGRESS_PATH);
  if (!progress || !progress.created) {
    console.error("No progress file found at", PROGRESS_PATH);
    process.exit(1);
  }

  const created = progress.created;
  const downloaded = new Set(progress.downloaded || []);
  const failed = new Set(progress.failed || []);

  // Find outstanding searches
  const outstanding = [];
  for (const [key, info] of Object.entries(created)) {
    if (!downloaded.has(key) && !failed.has(key)) {
      outstanding.push({ key, ...info });
    }
  }

  if (outstanding.length === 0) {
    console.log("No outstanding searches to download.");
    return;
  }

  console.log(`Found ${outstanding.length} outstanding searches:\n`);
  for (const s of outstanding) {
    console.log(`  ${s.key}: id=${s.id}, status=${s.status}`);
  }
  console.log();

  ensureDir(RESULTS_DIR);
  let totalLeads = 0;
  let downloadedCount = 0;

  for (const search of outstanding) {
    console.log(`--- ${search.key} ---`);

    // Poll until completed if not already
    let status = search.status;
    if (status !== "completed") {
      console.log(`  Status: ${status} — polling...`);
      while (status !== "completed" && status !== "failed") {
        await sleep(15000);
        const result = await checkStatus(search.id);
        status = result.status;
        const counts = result.counts || {};
        process.stdout.write(
          `\r  Polling: ${status} (total: ${counts.total || "?"})`
        );

        // Update progress with latest status
        created[search.key].status = status;
        if (counts.total) created[search.key].total_results = counts.total;
        if (result.credits_needed != null)
          created[search.key].credits_needed = result.credits_needed;
      }
      console.log();

      if (status === "failed") {
        console.log(`  FAILED — skipping`);
        progress.failed = [...failed, search.key];
        failed.add(search.key);
        saveJson(PROGRESS_PATH, progress);
        continue;
      }
    }

    // Download results
    try {
      const csvText = await downloadResults(search.id);
      const outPath = path.join(RESULTS_DIR, `${search.key}.csv`);
      fs.writeFileSync(outPath, csvText, "utf-8");

      const lines = csvText.split("\n").filter((l) => l.trim()).length - 1; // minus header
      totalLeads += Math.max(0, lines);

      console.log(`  Downloaded: ${lines} leads -> ${search.key}.csv`);

      // Update progress
      progress.downloaded = [...downloaded, search.key];
      downloaded.add(search.key);
      saveJson(PROGRESS_PATH, progress);
      downloadedCount++;
    } catch (err) {
      console.error(`  Download error: ${err.message}`);
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Searches processed: ${downloadedCount}/${outstanding.length}`);
  console.log(`Total new leads: ${totalLeads}`);
  console.log(`Progress file updated: ${PROGRESS_PATH}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
