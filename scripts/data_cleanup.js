#!/usr/bin/env node
/**
 * Data directory cleanup and consolidation.
 *
 * Merges parallel classification/phone paths into consolidated files with
 * canonical schema, archives intermediate/redundant files to data/_archive/.
 *
 * Usage:
 *   node scripts/data_cleanup.js              # dry-run (default)
 *   node scripts/data_cleanup.js --execute    # actually archive + consolidate
 *   node scripts/data_cleanup.js --restore    # reverse from latest manifest
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { readCsv, writeCsv } = require("../shared/csv");
const { resolveField, normalizeRow } = require("../shared/fields");
const { loadJsonl } = require("../shared/progress");
const { projectPath, ensureDir } = require("../shared/utils");

const DRY_RUN = !process.argv.includes("--execute");
const RESTORE = process.argv.includes("--restore");
const ARCHIVE_BASE = projectPath("data", "_archive");

// Canonical columns for consolidated CSVs
const CLASSIFIED_COLS = [
  "email", "first_name", "last_name", "company_name",
  "phone_number", "website", "location",
  "is_venue", "confidence", "reasoning", "source",
];

const PHONE_COLS = [
  ...CLASSIFIED_COLS, "phone_valid", "line_type", "carrier",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(filepath) {
  const data = fs.readFileSync(filepath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

function fileInfo(filepath) {
  try {
    const stat = fs.statSync(filepath);
    const lines = fs.readFileSync(filepath, "utf-8").split("\n").filter(Boolean).length;
    return { size: stat.size, lines, mtime: stat.mtime.toISOString() };
  } catch {
    return { size: 0, lines: 0, mtime: null };
  }
}

function safeReadCsv(filepath) {
  try {
    return readCsv(filepath);
  } catch {
    return { records: [], columns: [] };
  }
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Consolidation: normalize rows to canonical schema
// ---------------------------------------------------------------------------

function normalizeClassifiedRow(row, source) {
  const n = normalizeRow(row);
  return {
    email: n.email,
    first_name: n.firstName,
    last_name: n.lastName,
    company_name: n.companyName,
    phone_number: n.phone,
    website: n.website,
    location: n.location,
    is_venue: row.is_venue || "",
    confidence: row.confidence || "",
    reasoning: row.reasoning || "",
    source,
  };
}

function normalizePhoneRow(row, source) {
  const base = normalizeClassifiedRow(row, source);
  return {
    ...base,
    phone_valid: row.phone_valid || "",
    line_type: row.line_type || "",
    carrier: row.carrier || "",
  };
}

function consolidateClassified(type) {
  // type = "venues", "non_venues", or "ambiguous"
  const sources = [
    { dir: "data/classified", source: "smartlead" },
    { dir: "data/classified_geolead", source: "geolead" },
    { dir: "data/classified_geolead_batch2", source: "geolead_batch2" },
  ];

  const all = [];
  for (const { dir, source } of sources) {
    const filepath = projectPath(dir, `${type}.csv`);
    const { records } = safeReadCsv(filepath);
    for (const row of records) {
      all.push(normalizeClassifiedRow(row, source));
    }
  }
  return all;
}

function consolidateVerified(type) {
  // Sonnet results — only geolead has them
  const sources = [
    { dir: "data/verified", source: "smartlead" },
    { dir: "data/verified_geolead", source: "geolead" },
  ];

  const all = [];
  for (const { dir, source } of sources) {
    const filepath = projectPath(dir, `${type}.csv`);
    const { records } = safeReadCsv(filepath);
    for (const row of records) {
      all.push(normalizeClassifiedRow(row, source));
    }
  }
  return all;
}

function consolidatePhone(type) {
  // type = "mobile", "landline", "invalid", "no_phone", "voip"
  const sources = [
    { dir: "data/phone_validated", source: "smartlead" },
    { dir: "data/phone_validated_geolead", source: "geolead" },
  ];

  const all = [];
  for (const { dir, source } of sources) {
    const filepath = projectPath(dir, `${type}.csv`);
    const { records } = safeReadCsv(filepath);
    for (const row of records) {
      all.push(normalizePhoneRow(row, source));
    }
  }
  return all;
}

function mergePhoneCheckpoints() {
  const files = [
    "data/phone_validated/results.jsonl",
    "data/phone_validated_geolead/results.jsonl",
  ];
  const all = [];
  for (const f of files) {
    try {
      const entries = loadJsonl(projectPath(f));
      all.push(...entries);
    } catch {}
  }
  return all;
}

// ---------------------------------------------------------------------------
// Archive logic
// ---------------------------------------------------------------------------

function buildArchivePlan() {
  const plan = [];

  // --- Redundant results/merge files ---
  const redundantFiles = [
    { path: "data/classified/results.csv", reason: "Redundant: venues + non_venues + ambiguous combined" },
    { path: "data/classified_geolead/results.csv", reason: "Redundant: venues + non_venues + ambiguous combined" },
    { path: "data/classified_geolead/all_venues.csv", reason: "Redundant: venues + sonnet venues merge" },
    { path: "data/classified_geolead_batch2/results.csv", reason: "Redundant: venues + non_venues + ambiguous combined" },
    { path: "data/verified_geolead/results.csv", reason: "Redundant: venues + non_venues combined" },
  ];

  for (const { path: p, reason } of redundantFiles) {
    const full = projectPath(p);
    if (fs.existsSync(full)) {
      plan.push({ path: p, reason, ...fileInfo(full) });
    }
  }

  // --- Parallel paths (replaced by consolidated) ---
  const parallelDirs = [
    { dir: "data/classified_geolead", reason: "Parallel path: merged into consolidated classified/" },
    { dir: "data/classified_geolead_batch2", reason: "Parallel path: merged into consolidated classified/" },
    { dir: "data/classified_services", reason: "Sub-classification: separate concern, archived" },
    { dir: "data/verified_geolead", reason: "Parallel path: merged into consolidated verified/" },
    { dir: "data/phone_validated_geolead", reason: "Parallel path: merged into consolidated phone_validated/" },
  ];

  for (const { dir, reason } of parallelDirs) {
    const full = projectPath(dir);
    if (!fs.existsSync(full)) continue;
    const files = fs.readdirSync(full).filter((f) => !f.startsWith("."));
    for (const f of files) {
      const relPath = path.join(dir, f);
      const fullPath = projectPath(relPath);
      // Skip if already added as redundant
      if (plan.some((p) => p.path === relPath)) continue;
      plan.push({ path: relPath, reason, ...fileInfo(fullPath) });
    }
  }

  // --- Intermediate upload files ---
  const uploadIntermediates = [
    { path: "data/upload/all_venues.csv", reason: "Intermediate: stepping stone to master list" },
    { path: "data/upload/all_non_venues.csv", reason: "Intermediate: stepping stone to master list" },
    { path: "data/upload/net_new_for_smartlead.csv", reason: "Intermediate: one-time upload completed" },
  ];

  for (const { path: p, reason } of uploadIntermediates) {
    const full = projectPath(p);
    if (fs.existsSync(full)) {
      plan.push({ path: p, reason, ...fileInfo(full) });
    }
  }

  // --- Test data ---
  const testDir = projectPath("data", "test_100");
  if (fs.existsSync(testDir)) {
    for (const f of fs.readdirSync(testDir)) {
      plan.push({
        path: path.join("data/test_100", f),
        reason: "Test data: pipeline validation, no longer needed",
        ...fileInfo(path.join(testDir, f)),
      });
    }
  }

  // --- One-off files ---
  const oneOffs = [
    { path: "data/master_leads.csv", reason: "One-off: unclear provenance, not used by pipeline scripts" },
    { path: "data/enriched/geolead_outstanding_net_new.csv", reason: "Intermediate: batch2 processing input" },
  ];

  for (const { path: p, reason } of oneOffs) {
    const full = projectPath(p);
    if (fs.existsSync(full)) {
      plan.push({ path: p, reason, ...fileInfo(full) });
    }
  }

  // --- AnyMailFinder individual CSVs ---
  const amfDirs = [
    { dir: "data/anymailfinder/original_csvs", reason: "AnyMailFinder: ingested into additional_contacts.csv" },
    { dir: "data/anymailfinder/geolead_results", reason: "AnyMailFinder: ingested into geolead_net_new.csv" },
  ];

  for (const { dir, reason } of amfDirs) {
    const full = projectPath(dir);
    if (!fs.existsSync(full)) continue;
    const files = fs.readdirSync(full);
    // Archive the whole directory as one entry
    let totalSize = 0;
    let totalFiles = 0;
    for (const f of files) {
      totalSize += fs.statSync(path.join(full, f)).size;
      totalFiles++;
    }
    plan.push({
      path: dir,
      reason,
      size: totalSize,
      lines: null,
      mtime: null,
      isDirectory: true,
      fileCount: totalFiles,
    });
  }

  return plan;
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

async function executeConsolidation() {
  console.log("--- Consolidating parallel paths ---\n");

  // Classified
  for (const type of ["venues", "non_venues", "ambiguous"]) {
    const rows = consolidateClassified(type);
    const outPath = projectPath("data", "classified", `${type}.csv`);
    if (DRY_RUN) {
      console.log(`  [DRY RUN] classified/${type}.csv: ${rows.length} rows (canonical schema)`);
    } else {
      writeCsv(outPath, rows, CLASSIFIED_COLS);
      console.log(`  classified/${type}.csv: ${rows.length} rows written`);
    }
  }

  // Verified
  for (const type of ["venues", "non_venues"]) {
    const rows = consolidateVerified(type);
    if (rows.length === 0) continue;
    const outPath = projectPath("data", "verified", `${type}.csv`);
    if (DRY_RUN) {
      console.log(`  [DRY RUN] verified/${type}.csv: ${rows.length} rows (canonical schema)`);
    } else {
      ensureDir(projectPath("data", "verified"));
      writeCsv(outPath, rows, CLASSIFIED_COLS);
      console.log(`  verified/${type}.csv: ${rows.length} rows written`);
    }
  }

  // Phone validated
  for (const type of ["mobile", "landline", "invalid", "no_phone", "voip"]) {
    const rows = consolidatePhone(type);
    const outPath = projectPath("data", "phone_validated", `${type}.csv`);
    if (DRY_RUN) {
      console.log(`  [DRY RUN] phone_validated/${type}.csv: ${rows.length} rows (canonical schema)`);
    } else {
      writeCsv(outPath, rows, PHONE_COLS);
      console.log(`  phone_validated/${type}.csv: ${rows.length} rows written`);
    }
  }

  // Merge phone checkpoints
  const checkpoints = mergePhoneCheckpoints();
  if (checkpoints.length > 0) {
    const outPath = projectPath("data", "phone_validated", "results.jsonl");
    if (DRY_RUN) {
      console.log(`  [DRY RUN] phone_validated/results.jsonl: ${checkpoints.length} entries merged`);
    } else {
      const content = checkpoints.map((e) => JSON.stringify(e)).join("\n") + "\n";
      fs.writeFileSync(outPath, content, "utf-8");
      console.log(`  phone_validated/results.jsonl: ${checkpoints.length} entries merged`);
    }
  }

  console.log();
}

function executeArchive(plan) {
  const dateStr = new Date().toISOString().split("T")[0];
  const archiveDir = path.join(ARCHIVE_BASE, dateStr);

  console.log("--- Archiving files ---\n");
  console.log(`  Archive target: data/_archive/${dateStr}/`);

  const manifest = {
    created_at: new Date().toISOString(),
    archive_dir: `data/_archive/${dateStr}`,
    entries: [],
  };

  let totalSize = 0;
  let totalFiles = 0;

  for (const entry of plan) {
    const srcFull = projectPath(entry.path);

    if (entry.isDirectory) {
      // Archive entire directory
      const destDir = path.join(archiveDir, entry.path);
      if (DRY_RUN) {
        console.log(`  [DRY RUN] ${entry.path}/ (${entry.fileCount} files, ${fmtSize(entry.size)}) → ${entry.reason}`);
      } else {
        ensureDir(destDir);
        const files = fs.readdirSync(srcFull);
        for (const f of files) {
          const src = path.join(srcFull, f);
          const dest = path.join(destDir, f);
          fs.renameSync(src, dest);
        }
        // Remove now-empty directory
        try { fs.rmdirSync(srcFull); } catch {}
        console.log(`  ${entry.path}/ (${entry.fileCount} files) → archived`);
      }

      manifest.entries.push({
        path: entry.path,
        isDirectory: true,
        fileCount: entry.fileCount,
        size: entry.size,
        reason: entry.reason,
      });
      totalSize += entry.size;
      totalFiles += entry.fileCount;
      continue;
    }

    if (!fs.existsSync(srcFull)) continue;

    // Skip directories that weren't caught by isDirectory flag
    if (fs.statSync(srcFull).isDirectory()) {
      if (!DRY_RUN) {
        const destDir = path.join(archiveDir, entry.path);
        ensureDir(destDir);
        for (const f of fs.readdirSync(srcFull)) {
          fs.renameSync(path.join(srcFull, f), path.join(destDir, f));
        }
        try { fs.rmdirSync(srcFull); } catch {}
      }
      console.log(`  ${entry.path}/ → archived`);
      manifest.entries.push({ path: entry.path, isDirectory: true, reason: entry.reason });
      totalFiles++;
      continue;
    }

    const destFull = path.join(archiveDir, entry.path);
    const hash = sha256(srcFull);

    if (DRY_RUN) {
      console.log(`  [DRY RUN] ${entry.path} (${fmtSize(entry.size)}) → ${entry.reason}`);
    } else {
      ensureDir(path.dirname(destFull));
      fs.renameSync(srcFull, destFull);
      console.log(`  ${entry.path} → archived`);
    }

    manifest.entries.push({
      path: entry.path,
      size: entry.size,
      lines: entry.lines,
      sha256: hash,
      reason: entry.reason,
    });
    totalSize += entry.size;
    totalFiles++;
  }

  // Clean up empty directories
  if (!DRY_RUN) {
    const emptyDirs = [
      "data/classified_geolead",
      "data/classified_geolead_batch2",
      "data/classified_services",
      "data/verified_geolead",
      "data/phone_validated_geolead",
      "data/test_100",
    ];
    for (const d of emptyDirs) {
      try { fs.rmdirSync(projectPath(d)); } catch {}
    }
  }

  // Write manifest
  if (!DRY_RUN) {
    ensureDir(archiveDir);
    const manifestPath = path.join(archiveDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
    console.log(`\n  Manifest: data/_archive/${dateStr}/manifest.json`);
  }

  console.log(`\n  Total: ${totalFiles} files, ${fmtSize(totalSize)} archived`);
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

function executeRestore() {
  // Find latest archive
  if (!fs.existsSync(ARCHIVE_BASE)) {
    console.error("No archives found at data/_archive/");
    process.exit(1);
  }

  const dates = fs.readdirSync(ARCHIVE_BASE).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  if (dates.length === 0) {
    console.error("No dated archives found in data/_archive/");
    process.exit(1);
  }

  const latestDir = path.join(ARCHIVE_BASE, dates[0]);
  const manifestPath = path.join(latestDir, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    console.error(`No manifest found in ${latestDir}`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  console.log(`Restoring from: data/_archive/${dates[0]}/`);
  console.log(`Archived at: ${manifest.created_at}`);
  console.log(`Entries: ${manifest.entries.length}\n`);

  let restored = 0;

  for (const entry of manifest.entries) {
    const archiveSrc = path.join(latestDir, entry.path);
    const destFull = projectPath(entry.path);

    if (entry.isDirectory) {
      if (!fs.existsSync(archiveSrc)) {
        console.log(`  SKIP (not found): ${entry.path}/`);
        continue;
      }
      ensureDir(destFull);
      const files = fs.readdirSync(archiveSrc);
      for (const f of files) {
        fs.renameSync(path.join(archiveSrc, f), path.join(destFull, f));
      }
      try { fs.rmdirSync(archiveSrc); } catch {}
      console.log(`  ${entry.path}/ (${entry.fileCount} files) → restored`);
      restored += entry.fileCount;
      continue;
    }

    if (!fs.existsSync(archiveSrc)) {
      console.log(`  SKIP (not found): ${entry.path}`);
      continue;
    }

    // Verify hash if available
    if (entry.sha256) {
      const hash = sha256(archiveSrc);
      if (hash !== entry.sha256) {
        console.log(`  WARNING: hash mismatch for ${entry.path} — restoring anyway`);
      }
    }

    ensureDir(path.dirname(destFull));
    fs.renameSync(archiveSrc, destFull);
    console.log(`  ${entry.path} → restored`);
    restored++;
  }

  // Clean up empty archive dir
  try {
    fs.unlinkSync(manifestPath);
    fs.rmdirSync(latestDir);
  } catch {}

  console.log(`\nRestored ${restored} files/directories.`);
  console.log("NOTE: Consolidated files in classified/, verified/, phone_validated/ still exist.");
  console.log("You may want to revert them to the original schema if needed.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (RESTORE) {
    executeRestore();
    return;
  }

  console.log(`=== Data Directory Cleanup ${DRY_RUN ? "(DRY RUN)" : "(EXECUTING)"} ===\n`);

  // Step 1: Pre-consolidation counts
  console.log("--- Pre-cleanup counts ---\n");
  const preVenues = ["data/classified/venues.csv", "data/classified_geolead/venues.csv", "data/classified_geolead_batch2/venues.csv"];
  const preNonVenues = ["data/classified/non_venues.csv", "data/classified_geolead/non_venues.csv", "data/classified_geolead_batch2/non_venues.csv"];
  let totalVenuesPre = 0, totalNonPre = 0;
  for (const f of preVenues) totalVenuesPre += safeReadCsv(projectPath(f)).records.length;
  for (const f of preNonVenues) totalNonPre += safeReadCsv(projectPath(f)).records.length;

  const preMobile = safeReadCsv(projectPath("data/phone_validated/mobile.csv")).records.length +
    safeReadCsv(projectPath("data/phone_validated_geolead/mobile.csv")).records.length;
  const preLandline = safeReadCsv(projectPath("data/phone_validated/landline.csv")).records.length +
    safeReadCsv(projectPath("data/phone_validated_geolead/landline.csv")).records.length;

  console.log(`  Venues (across 3 dirs):     ${totalVenuesPre.toLocaleString()}`);
  console.log(`  Non-venues (across 3 dirs): ${totalNonPre.toLocaleString()}`);
  console.log(`  Mobile (across 2 dirs):     ${preMobile.toLocaleString()}`);
  console.log(`  Landline (across 2 dirs):   ${preLandline.toLocaleString()}`);
  console.log();

  // Step 2: Consolidate
  await executeConsolidation();

  // Step 3: Archive
  const plan = buildArchivePlan();
  executeArchive(plan);

  // Step 4: Post-cleanup verification
  if (!DRY_RUN) {
    console.log("\n--- Post-cleanup verification ---\n");
    const postVenues = safeReadCsv(projectPath("data/classified/venues.csv")).records.length;
    const postNon = safeReadCsv(projectPath("data/classified/non_venues.csv")).records.length;
    const postMobile = safeReadCsv(projectPath("data/phone_validated/mobile.csv")).records.length;
    const postLandline = safeReadCsv(projectPath("data/phone_validated/landline.csv")).records.length;

    console.log(`  Venues:     ${postVenues.toLocaleString()} (was ${totalVenuesPre.toLocaleString()}) ${postVenues === totalVenuesPre ? "OK" : "MISMATCH!"}`);
    console.log(`  Non-venues: ${postNon.toLocaleString()} (was ${totalNonPre.toLocaleString()}) ${postNon === totalNonPre ? "OK" : "MISMATCH!"}`);
    console.log(`  Mobile:     ${postMobile.toLocaleString()} (was ${preMobile.toLocaleString()}) ${postMobile === preMobile ? "OK" : "MISMATCH!"}`);
    console.log(`  Landline:   ${postLandline.toLocaleString()} (was ${preLandline.toLocaleString()}) ${postLandline === preLandline ? "OK" : "MISMATCH!"}`);
  }

  if (DRY_RUN) {
    console.log("\nThis was a dry run. Use --execute to apply changes.");
  } else {
    console.log("\nCleanup complete. Use --restore to reverse.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
