#!/usr/bin/env node
/**
 * Daily SmartLead Prospecting — automated daily drip of new venue leads.
 *
 * Rotates through search terms and US regions, discovers emails, deduplicates
 * against existing SmartLead campaigns, prefilters, classifies via Haiku, and
 * uploads net-new venues/non-venues to their respective campaigns.
 *
 * Usage:
 *   node scripts/daily-prospect.js                    # full run
 *   node scripts/daily-prospect.js --dry-run          # preview only
 *   node scripts/daily-prospect.js --limit 10         # cap prospect results
 *   node scripts/daily-prospect.js --force            # ignore already-ran-today guard
 *   node scripts/daily-prospect.js --skip-classify    # stage only, no Haiku
 *   node scripts/daily-prospect.js --skip-upload      # classify but don't upload
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const { requireEnv } = require("../shared/env");
const { readCsv, writeCsv } = require("../shared/csv");
const { resolveField, normalizeRow, FIELDS } = require("../shared/fields");
const { projectPath, ensureDir, timestamp } = require("../shared/utils");
const { loadJson, saveJson } = require("../shared/progress");
const { normalizeDomain } = require("../shared/dedup");
const { uploadLeads, chunkArray } = require("../shared/smartlead");

// ---------------------------------------------------------------------------
// Config & paths
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.join(__dirname, "daily-prospect-config.json");
const DATA_DIR = projectPath("data", "daily-prospects");
const STATE_PATH = path.join(DATA_DIR, "rotation_state.json");
const STAGING_DIR = path.join(DATA_DIR, "staging");
const CLASSIFIED_DIR = path.join(DATA_DIR, "classified");

// Import prefilter rules from the canonical source (now safe — guarded by require.main)
const { RULES: PREFILTER_RULES } = require("../2-enrichment/prefilter");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const idx = (flag) => args.indexOf(flag);
  return {
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    skipClassify: args.includes("--skip-classify"),
    skipUpload: args.includes("--skip-upload"),
    limit: idx("--limit") !== -1 ? parseInt(args[idx("--limit") + 1], 10) : null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function today() {
  return new Date().toISOString().split("T")[0];
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

function loadState() {
  const s = loadJson(STATE_PATH);
  return s || { rotation_index: 0, last_run_date: null, pending_batch: null };
}

function saveState(state) {
  ensureDir(DATA_DIR);
  saveJson(STATE_PATH, state);
}

function extractDomain(raw) {
  if (!raw) return null;
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/^www\./, "");
  d = d.split("/")[0].split("?")[0];
  return d || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(step, msg) {
  console.log(`[${step}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Step 1: Resolve pending Haiku batch from a previous run
// ---------------------------------------------------------------------------

async function resolvePendingBatch(state, config, opts) {
  if (!state.pending_batch) return null;

  const { batch_id, input_csv, output_dir, date } = state.pending_batch;
  log("BATCH", `Checking pending batch ${batch_id} from ${date}...`);

  if (opts.dryRun) {
    log("BATCH", "[DRY RUN] Would check batch status");
    return "pending";
  }

  try {
    const statusOut = execSync(
      `python scripts/batch-helper.py status "${batch_id}"`,
      { cwd: projectPath(), encoding: "utf-8", timeout: 30000 }
    ).trim();
    const status = JSON.parse(statusOut);
    log("BATCH", `Status: ${status.status} (succeeded=${status.succeeded}, errored=${status.errored})`);

    if (status.status !== "ended") {
      log("BATCH", "Batch still processing — will check again next run.");
      return "pending";
    }

    // Stream results
    ensureDir(output_dir);
    const inputFlag = input_csv ? ` --input "${input_csv}"` : "";
    const resultsOut = execSync(
      `python scripts/batch-helper.py results "${batch_id}" --output-dir "${output_dir}"${inputFlag}`,
      { cwd: projectPath(), encoding: "utf-8", timeout: 120000 }
    ).trim();
    const counts = JSON.parse(resultsOut);
    log("BATCH", `Results: ${counts.venues} venues, ${counts.non_venues} non-venues, ${counts.ambiguous} ambiguous`);

    // Upload results
    if (!opts.skipUpload) {
      await uploadClassified(output_dir, config, opts, date);
    }

    state.pending_batch = null;
    saveState(state);
    return "resolved";
  } catch (err) {
    log("BATCH", `Error checking batch: ${err.message}`);
    return "error";
  }
}

// ---------------------------------------------------------------------------
// Step 2: Prospect search via SmartLead CLI
// ---------------------------------------------------------------------------

function getRotation(state, config) {
  // Build the full term pool from all banks
  const allTerms = [];
  const banks = config.search_term_banks || {};
  for (const bank of Object.values(banks)) {
    allTerms.push(...bank);
  }
  // Fallback for old config format
  if (allTerms.length === 0 && config.search_terms) {
    allTerms.push(...config.search_terms);
  }

  const termCount = allTerms.length;
  const regionCount = config.regions.length;
  const termsPerDay = config.terms_per_day || 3;
  const ri = state.rotation_index;

  const regionIdx = ri % regionCount;
  // Pick N search terms, cycling through the full pool
  const termStart = (ri * termsPerDay) % termCount;
  const terms = [];
  for (let i = 0; i < termsPerDay; i++) {
    terms.push(allTerms[(termStart + i) % termCount]);
  }

  return {
    region: config.regions[regionIdx],
    terms,
    cyclePosition: `rotation=${ri}, region=${config.regions[regionIdx].name}, terms=[${terms.join(", ")}]`,
  };
}

function prospectSearch(rotation, limit, opts) {
  const { region, terms } = rotation;
  const allLeads = [];
  const seenDomains = new Set();
  let searchesRun = 0;

  for (const term of terms) {
    for (const state of region.states) {
      if (limit !== null && allLeads.length >= limit) break;

      const query = `${term} ${state}`;
      searchesRun++;

      if (opts.dryRun) {
        log("SEARCH", `[DRY RUN] Would search: "${query}"`);
        continue;
      }

      try {
        log("SEARCH", `Searching: "${query}"`);
        const output = execSync(
          `smartlead prospect search --query "${query}"`,
          { encoding: "utf-8", timeout: 60000, stdio: ["pipe", "pipe", "pipe"] }
        );

        // Parse output — expect JSON array or JSON object with data field
        let results = [];
        const trimmed = output.trim();
        if (!trimmed) {
          log("SEARCH", `  0 results`);
          continue;
        }

        try {
          const jsonStart = trimmed.indexOf("[") !== -1 ? trimmed.indexOf("[") : trimmed.indexOf("{");
          if (jsonStart === -1) {
            log("SEARCH", `  No JSON in output, skipping`);
            continue;
          }
          const parsed = JSON.parse(trimmed.slice(jsonStart));
          results = Array.isArray(parsed) ? parsed : (parsed.data || parsed.results || []);
        } catch {
          // Try CSV-like output: split by lines
          log("SEARCH", `  Could not parse JSON output, treating as text (${trimmed.length} chars)`);
          continue;
        }

        // Deduplicate within this run by domain
        for (const r of results) {
          const domain = extractDomain(r.website || r.company_domain || r.url || "");
          if (domain && !seenDomains.has(domain)) {
            seenDomains.add(domain);
            allLeads.push({
              company_name: r.company_name || r.name || r.company || "",
              email: r.email || r.email_address || "",
              website: r.website || r.company_domain || r.url || "",
              phone_number: r.phone || r.phone_number || "",
              location: r.location || r.city || `${r.city || ""}, ${r.state || state}`.trim(),
              first_name: r.first_name || "",
              last_name: r.last_name || "",
              _search_term: term,
              _search_state: state,
              _search_region: rotation.region.name,
            });
          }
        }

        log("SEARCH", `  ${results.length} results (${allLeads.length} unique total)`);
      } catch (err) {
        log("SEARCH", `  Error for "${query}": ${err.message.split("\n")[0]}`);
      }
    }
    if (limit !== null && allLeads.length >= limit) break;
  }

  log("SEARCH", `Total: ${searchesRun} searches, ${allLeads.length} unique leads`);
  return allLeads;
}

// ---------------------------------------------------------------------------
// Step 3: Email discovery via SmartLead CLI
// ---------------------------------------------------------------------------

async function discoverEmails(leads, opts) {
  let discovered = 0;
  const needsEmail = leads.filter((l) => !l.email);
  if (needsEmail.length === 0) {
    log("EMAILS", "All leads already have emails, skipping discovery");
    return leads;
  }

  log("EMAILS", `Discovering emails for ${needsEmail.length} leads without email...`);

  if (opts.dryRun) {
    log("EMAILS", `[DRY RUN] Would call find-emails for ${needsEmail.length} domains`);
    return leads;
  }

  for (let i = 0; i < needsEmail.length; i++) {
    const lead = needsEmail[i];
    const domain = extractDomain(lead.website);
    if (!domain) continue;

    const tmpFile = path.join(os.tmpdir(), `prospect_daily_${Date.now()}.json`);
    const payload = {
      contacts: [{ firstName: lead.first_name || "", lastName: lead.last_name || "", companyDomain: domain }],
    };

    try {
      fs.writeFileSync(tmpFile, JSON.stringify(payload));
      const output = execSync(
        `smartlead prospect find-emails --from-json "${tmpFile}"`,
        { timeout: 30000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );
      try { fs.unlinkSync(tmpFile); } catch {}

      const jsonStart = output.indexOf("{");
      if (jsonStart !== -1) {
        const parsed = JSON.parse(output.slice(jsonStart));
        const data = parsed.data || [];
        const emails = data
          .filter((r) => r.email_id && r.status !== "Not Found")
          .map((r) => r.email_id);
        if (emails.length > 0) {
          lead.email = emails[0]; // use first found email
          discovered++;
        }
      }
    } catch (err) {
      try { fs.unlinkSync(tmpFile); } catch {}
      // Silently continue — email discovery is best-effort
    }

    if (i < needsEmail.length - 1) {
      await sleep(200); // 5 req/s rate limit
    }

    if ((i + 1) % 10 === 0) {
      log("EMAILS", `  [${i + 1}/${needsEmail.length}] discovered=${discovered}`);
    }
  }

  log("EMAILS", `Discovered ${discovered} emails from ${needsEmail.length} lookups`);
  return leads;
}

// ---------------------------------------------------------------------------
// Step 4: Dedup against existing SmartLead campaigns
// ---------------------------------------------------------------------------

async function dedupAgainstExisting(leads, config, opts) {
  log("DEDUP", "Building baseline domain/email set from existing campaigns...");

  const existingDomains = new Set();
  const existingEmails = new Set();
  const existingCompanyCities = new Set();

  if (opts.dryRun) {
    log("DEDUP", "[DRY RUN] Would pull existing leads from SmartLead campaigns for dedup");
    log("DEDUP", `[DRY RUN] ${leads.length} leads would be checked against baseline`);
    return leads;
  }

  // Pull leads from each campaign
  for (const campaignId of config.dedup_campaign_ids) {
    const tmpFile = path.join(os.tmpdir(), `campaign_export_${campaignId}_${Date.now()}.csv`);
    try {
      log("DEDUP", `  Exporting campaign ${campaignId}...`);
      execSync(
        `smartlead campaigns export --id ${campaignId} --out "${tmpFile}"`,
        { encoding: "utf-8", timeout: 120000, maxBuffer: 50 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }
      );

      const { records } = await readCsv(tmpFile);
      for (const row of records) {
        const domain = normalizeDomain(resolveField(row, "website"));
        if (domain) existingDomains.add(domain);

        const email = resolveField(row, "email").toLowerCase();
        if (email) existingEmails.add(email);

        const company = resolveField(row, "companyName").toLowerCase();
        const city = resolveField(row, "location").toLowerCase();
        if (company && city) existingCompanyCities.add(`${company}|${city}`);
      }
      log("DEDUP", `  Campaign ${campaignId}: ${records.length} leads loaded`);
    } catch (err) {
      log("DEDUP", `  Error exporting campaign ${campaignId}: ${err.message.split("\n")[0]}`);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }

  // Also load domains from previous daily prospect runs
  try {
    const stagingFiles = fs.readdirSync(STAGING_DIR)
      .filter((f) => f.endsWith("_deduped.csv"))
      .map((f) => path.join(STAGING_DIR, f));
    for (const file of stagingFiles) {
      const { records } = await readCsv(file);
      for (const row of records) {
        const domain = normalizeDomain(resolveField(row, "website"));
        if (domain) existingDomains.add(domain);
        const email = resolveField(row, "email").toLowerCase();
        if (email) existingEmails.add(email);
      }
    }
  } catch {}

  log("DEDUP", `Baseline: ${existingDomains.size} domains, ${existingEmails.size} emails, ${existingCompanyCities.size} company+city combos`);

  // Filter leads
  const netNew = [];
  let dupDomain = 0, dupEmail = 0, dupCompanyCity = 0;

  for (const lead of leads) {
    const email = (lead.email || "").trim().toLowerCase();
    if (email && existingEmails.has(email)) {
      dupEmail++;
      continue;
    }

    const domain = normalizeDomain(lead.website);
    if (domain && existingDomains.has(domain)) {
      dupDomain++;
      continue;
    }

    const company = (lead.company_name || "").trim().toLowerCase();
    const city = (lead.location || "").trim().toLowerCase().split(",")[0].trim();
    if (company && city && existingCompanyCities.has(`${company}|${city}`)) {
      dupCompanyCity++;
      continue;
    }

    netNew.push(lead);
  }

  log("DEDUP", `Duplicates removed: ${dupEmail} by email, ${dupDomain} by domain, ${dupCompanyCity} by company+city`);
  log("DEDUP", `Net-new: ${netNew.length} of ${leads.length}`);
  return netNew;
}

// ---------------------------------------------------------------------------
// Step 5: Prefilter (replicates 2-enrichment/prefilter.js logic)
// ---------------------------------------------------------------------------

function prefilterLeads(leads) {
  const passed = [];
  const excluded = {};
  let excludedCount = 0;

  for (const lead of leads) {
    const name = lead.company_name || "";
    const email = lead.email || "";
    const textToCheck = `${name} ${email}`;

    let matched = false;
    for (const rule of PREFILTER_RULES) {
      for (const pattern of rule.patterns) {
        if (pattern.test(textToCheck)) {
          excluded[rule.category] = (excluded[rule.category] || 0) + 1;
          excludedCount++;
          matched = true;
          break;
        }
      }
      if (matched) break;
    }

    if (!matched) {
      const website = (lead.website || "").trim();
      if (!website) {
        excluded["No Website"] = (excluded["No Website"] || 0) + 1;
        excludedCount++;
        continue;
      }
      passed.push(lead);
    }
  }

  log("PREFILTER", `Passed: ${passed.length}, excluded: ${excludedCount}`);
  for (const [cat, count] of Object.entries(excluded).sort((a, b) => b[1] - a[1])) {
    log("PREFILTER", `  ${cat}: ${count}`);
  }

  return { passed, excludedCount, excludedByCategory: excluded };
}

// ---------------------------------------------------------------------------
// Step 6: Haiku batch classification
// ---------------------------------------------------------------------------

async function classifyLeads(filteredCsvPath, dateStr, state, config, opts) {
  const { records } = await readCsv(filteredCsvPath);
  if (records.length === 0) {
    log("CLASSIFY", "No leads to classify");
    return { venues: 0, nonVenues: 0, ambiguous: 0, outputDir: null };
  }

  const outputDir = path.join(CLASSIFIED_DIR, dateStr);
  ensureDir(outputDir);

  if (opts.dryRun) {
    log("CLASSIFY", `[DRY RUN] Would classify ${records.length} leads`);
    return { venues: 0, nonVenues: 0, ambiguous: 0, outputDir };
  }

  if (records.length < config.sync_classify_threshold) {
    // Small batch: run synchronously via classify_batch.py
    log("CLASSIFY", `Classifying ${records.length} leads synchronously (< ${config.sync_classify_threshold} threshold)...`);
    try {
      execSync(
        `python 2-enrichment/classify_batch.py --input "${filteredCsvPath}" --output-dir "${outputDir}"`,
        { cwd: projectPath(), stdio: "inherit", timeout: 600000 }
      );

      const venueCount = fs.existsSync(path.join(outputDir, "venues.csv"))
        ? (await readCsv(path.join(outputDir, "venues.csv"))).records.length : 0;
      const nonVenueCount = fs.existsSync(path.join(outputDir, "non_venues.csv"))
        ? (await readCsv(path.join(outputDir, "non_venues.csv"))).records.length : 0;
      const ambiguousCount = fs.existsSync(path.join(outputDir, "ambiguous.csv"))
        ? (await readCsv(path.join(outputDir, "ambiguous.csv"))).records.length : 0;

      log("CLASSIFY", `Done: ${venueCount} venues, ${nonVenueCount} non-venues, ${ambiguousCount} ambiguous`);
      return { venues: venueCount, nonVenues: nonVenueCount, ambiguous: ambiguousCount, outputDir };
    } catch (err) {
      log("CLASSIFY", `Error: ${err.message.split("\n")[0]}`);
      return { venues: 0, nonVenues: 0, ambiguous: 0, outputDir: null };
    }
  } else {
    // Large batch: submit async via batch-helper.py
    log("CLASSIFY", `Submitting ${records.length} leads for async classification...`);
    try {
      const submitOut = execSync(
        `python scripts/batch-helper.py submit --input "${filteredCsvPath}"`,
        { cwd: projectPath(), encoding: "utf-8", timeout: 60000 }
      ).trim();
      const result = JSON.parse(submitOut);

      if (result.batch_id) {
        state.pending_batch = {
          batch_id: result.batch_id,
          input_csv: filteredCsvPath,
          output_dir: outputDir,
          date: dateStr,
          lead_count: result.count,
          submitted_at: new Date().toISOString(),
        };
        saveState(state);
        log("CLASSIFY", `Batch submitted: ${result.batch_id} (${result.count} leads). Will check next run.`);
      }
      return { venues: 0, nonVenues: 0, ambiguous: 0, outputDir: null, async: true };
    } catch (err) {
      log("CLASSIFY", `Error submitting batch: ${err.message.split("\n")[0]}`);
      return { venues: 0, nonVenues: 0, ambiguous: 0, outputDir: null };
    }
  }
}

// ---------------------------------------------------------------------------
// Step 7: Upload classified leads to SmartLead
// ---------------------------------------------------------------------------

async function uploadClassified(classifiedDir, config, opts, dateStr) {
  const venuesPath = path.join(classifiedDir, "venues.csv");
  const nonVenuesPath = path.join(classifiedDir, "non_venues.csv");

  let venuesUploaded = 0;
  let nonVenuesUploaded = 0;

  // Upload venues
  if (fs.existsSync(venuesPath)) {
    const { records } = await readCsv(venuesPath);
    if (records.length > 0) {
      const mapped = records.map((row) => {
        const n = normalizeRow(row);
        return {
          email: n.email,
          first_name: n.firstName,
          last_name: n.lastName,
          company_name: n.companyName,
          phone_number: n.phone,
          website: n.website,
          location: n.location,
          custom_fields: {
            source: "smartlead-prospect",
            upload_batch: dateStr,
            confidence: row.confidence || "",
          },
        };
      }).filter((l) => l.email);

      if (opts.dryRun || opts.skipUpload) {
        log("UPLOAD", `[DRY RUN] Would upload ${mapped.length} venues to campaign ${config.campaign_ids.venues}`);
      } else {
        log("UPLOAD", `Uploading ${mapped.length} venues to campaign ${config.campaign_ids.venues}...`);
        const batches = chunkArray(mapped, 400);
        for (let i = 0; i < batches.length; i++) {
          try {
            await uploadLeads(config.campaign_ids.venues, batches[i]);
            venuesUploaded += batches[i].length;
            log("UPLOAD", `  Batch ${i + 1}/${batches.length}: ${batches[i].length} venues uploaded`);
          } catch (err) {
            log("UPLOAD", `  Batch ${i + 1} FAILED: ${err.message.split("\n")[0]}`);
          }
        }
      }
    }
  }

  // Upload non-venues
  if (fs.existsSync(nonVenuesPath)) {
    const { records } = await readCsv(nonVenuesPath);
    if (records.length > 0) {
      const mapped = records.map((row) => {
        const n = normalizeRow(row);
        return {
          email: n.email,
          first_name: n.firstName,
          last_name: n.lastName,
          company_name: n.companyName,
          phone_number: n.phone,
          website: n.website,
          location: n.location,
          custom_fields: {
            source: "smartlead-prospect",
            upload_batch: dateStr,
          },
        };
      }).filter((l) => l.email);

      if (opts.dryRun || opts.skipUpload) {
        log("UPLOAD", `[DRY RUN] Would upload ${mapped.length} non-venues to campaign ${config.campaign_ids.non_venues}`);
      } else {
        log("UPLOAD", `Uploading ${mapped.length} non-venues to campaign ${config.campaign_ids.non_venues}...`);
        const batches = chunkArray(mapped, 400);
        for (let i = 0; i < batches.length; i++) {
          try {
            await uploadLeads(config.campaign_ids.non_venues, batches[i]);
            nonVenuesUploaded += batches[i].length;
            log("UPLOAD", `  Batch ${i + 1}/${batches.length}: ${batches[i].length} non-venues uploaded`);
          } catch (err) {
            log("UPLOAD", `  Batch ${i + 1} FAILED: ${err.message.split("\n")[0]}`);
          }
        }
      }
    }
  }

  log("UPLOAD", `Uploaded: ${venuesUploaded} venues, ${nonVenuesUploaded} non-venues`);
  return { venuesUploaded, nonVenuesUploaded };
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();
  const opts = parseArgs();
  const config = loadConfig();
  const dateStr = today();

  ensureDir(DATA_DIR);
  ensureDir(STAGING_DIR);
  ensureDir(CLASSIFIED_DIR);

  log("INIT", `Daily Prospect — ${dateStr}${opts.dryRun ? " [DRY RUN]" : ""}`);

  // Load rotation state
  const state = loadState();
  log("INIT", `Rotation index: ${state.rotation_index}, last run: ${state.last_run_date || "never"}`);

  // Idempotency: already ran today?
  if (state.last_run_date === dateStr && !opts.force) {
    // Still check pending batch
    if (state.pending_batch) {
      const batchResult = await resolvePendingBatch(state, config, opts);
      if (batchResult === "resolved") {
        log("INIT", "Pending batch resolved. Done.");
      } else {
        log("INIT", "Pending batch still processing.");
      }
    } else {
      log("INIT", "Already ran today. Use --force to re-run.");
    }
    return;
  }

  // Step 1: Resolve any pending batch from a previous run
  if (state.pending_batch) {
    const batchResult = await resolvePendingBatch(state, config, opts);
    if (batchResult === "pending") {
      log("INIT", "Previous batch still processing — skipping new search until it completes.");
      return;
    }
  }

  // Step 2: Prospect search
  const rotation = getRotation(state, config);
  log("SEARCH", `Rotation: ${rotation.cyclePosition}`);

  const limit = opts.limit !== null ? opts.limit : (config.daily_lead_target || config.daily_search_limit);
  const rawLeads = prospectSearch(rotation, limit, opts);

  if (rawLeads.length > 0 && !opts.dryRun) {
    const rawCsvPath = path.join(STAGING_DIR, `${dateStr}_raw.csv`);
    const columns = [
      "company_name", "email", "website", "phone_number", "location",
      "first_name", "last_name", "_search_term", "_search_state", "_search_region",
    ];
    await writeCsv(rawCsvPath, rawLeads, columns);
    log("SEARCH", `Saved ${rawLeads.length} raw leads to ${rawCsvPath}`);
  }

  if (rawLeads.length === 0) {
    log("SEARCH", "No leads found. Updating rotation and exiting.");
    if (!opts.dryRun) {
      state.rotation_index++;
      state.last_run_date = dateStr;
      saveState(state);
      writeDailyLog(dateStr, rotation, {}, startTime);
    }
    return;
  }

  // Step 3: Email discovery
  const leadsWithEmails = await discoverEmails(rawLeads, opts);
  const emailCount = leadsWithEmails.filter((l) => l.email).length;
  log("EMAILS", `${emailCount} of ${leadsWithEmails.length} leads have emails`);

  if (!opts.dryRun && leadsWithEmails.length > 0) {
    const emailCsvPath = path.join(STAGING_DIR, `${dateStr}_with_emails.csv`);
    await writeCsv(emailCsvPath, leadsWithEmails);
    log("EMAILS", `Saved to ${emailCsvPath}`);
  }

  // Only proceed with leads that have emails
  const leadsWithValidEmails = leadsWithEmails.filter((l) => l.email);
  if (leadsWithValidEmails.length === 0) {
    log("EMAILS", "No leads with emails after discovery. Updating rotation and exiting.");
    if (!opts.dryRun) {
      state.rotation_index++;
      state.last_run_date = dateStr;
      saveState(state);
      writeDailyLog(dateStr, rotation, { raw: rawLeads.length, emails: 0 }, startTime);
    }
    return;
  }

  // Step 4: Dedup
  const netNew = await dedupAgainstExisting(leadsWithValidEmails, config, opts);

  if (!opts.dryRun && netNew.length > 0) {
    const dedupCsvPath = path.join(STAGING_DIR, `${dateStr}_deduped.csv`);
    await writeCsv(dedupCsvPath, netNew);
  }

  if (netNew.length === 0) {
    log("DEDUP", "All leads are duplicates. Updating rotation and exiting.");
    if (!opts.dryRun) {
      state.rotation_index++;
      state.last_run_date = dateStr;
      saveState(state);
      writeDailyLog(dateStr, rotation, {
        raw: rawLeads.length, emails: emailCount,
        duplicates: leadsWithValidEmails.length, netNew: 0,
      }, startTime);
    }
    return;
  }

  // Step 5: Prefilter
  const { passed, excludedCount, excludedByCategory } = prefilterLeads(netNew);

  let filteredCsvPath = null;
  if (!opts.dryRun && passed.length > 0) {
    filteredCsvPath = path.join(STAGING_DIR, `${dateStr}_filtered.csv`);
    await writeCsv(filteredCsvPath, passed);
    log("PREFILTER", `Saved ${passed.length} filtered leads to ${filteredCsvPath}`);

    // Also append to cumulative pending file
    const pendingPath = path.join(DATA_DIR, "pending_classification.csv");
    if (fs.existsSync(pendingPath)) {
      const existing = await readCsv(pendingPath);
      const combined = [...existing.records, ...passed];
      await writeCsv(pendingPath, combined);
    } else {
      await writeCsv(pendingPath, passed);
    }
  }

  // Step 6: Classify
  let classifyResult = { venues: 0, nonVenues: 0, ambiguous: 0 };
  if (passed.length > 0 && filteredCsvPath && !opts.skipClassify) {
    classifyResult = await classifyLeads(filteredCsvPath, dateStr, state, config, opts);

    // Step 7: Upload (if classification completed synchronously)
    if (classifyResult.outputDir && !classifyResult.async && !opts.skipUpload && !opts.dryRun) {
      await uploadClassified(classifyResult.outputDir, config, opts, dateStr);

      // Clear pending file after successful upload
      const pendingPath = path.join(DATA_DIR, "pending_classification.csv");
      try { fs.unlinkSync(pendingPath); } catch {}
    }
  }

  // Update state
  if (!opts.dryRun) {
    state.rotation_index++;
    state.last_run_date = dateStr;
    saveState(state);
  }

  // Write daily log
  const summary = {
    raw: rawLeads.length,
    emails: emailCount,
    duplicates: leadsWithValidEmails.length - netNew.length,
    netNew: netNew.length,
    prefilterExcluded: excludedCount,
    prefilterExcludedByCategory: excludedByCategory,
    passedToClassify: passed.length,
    venues: classifyResult.venues,
    nonVenues: classifyResult.nonVenues,
    ambiguous: classifyResult.ambiguous,
    asyncBatch: !!classifyResult.async,
  };

  if (!opts.dryRun) {
    writeDailyLog(dateStr, rotation, summary, startTime);
  }

  // Print summary
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("\n--- Daily Prospect Summary ---");
  console.log(`Date:                ${dateStr}`);
  console.log(`Region:              ${rotation.region.name} (${rotation.terms.join(", ")})`);
  console.log(`Searches run:        ${rotation.terms.length * rotation.region.states.length}`);
  console.log(`Raw leads found:     ${rawLeads.length}`);
  console.log(`Emails discovered:   ${emailCount}`);
  console.log(`Duplicates removed:  ${summary.duplicates || 0}`);
  console.log(`Net-new leads:       ${netNew.length}`);
  console.log(`Prefilter excluded:  ${excludedCount}`);
  console.log(`Sent to classify:    ${passed.length}`);
  console.log(`Venues classified:   ${classifyResult.venues}`);
  console.log(`Non-venues:          ${classifyResult.nonVenues}`);
  console.log(`Ambiguous:           ${classifyResult.ambiguous}`);
  if (classifyResult.async) console.log(`Batch status:        async (pending)`);
  console.log(`Duration:            ${duration}s`);
  console.log(`Next rotation:       ${state.rotation_index}`);
}

function writeDailyLog(dateStr, rotation, summary, startTime) {
  const logData = {
    date: dateStr,
    search_terms_used: rotation.terms,
    region: rotation.region.name,
    states_searched: rotation.region.states,
    raw_leads_found: summary.raw || 0,
    emails_discovered: summary.emails || 0,
    duplicates_removed: summary.duplicates || 0,
    net_new_after_dedup: summary.netNew || 0,
    prefilter_excluded: summary.prefilterExcluded || 0,
    submitted_for_classification: summary.passedToClassify || 0,
    venues_classified: summary.venues || 0,
    non_venues_classified: summary.nonVenues || 0,
    ambiguous: summary.ambiguous || 0,
    async_batch: summary.asyncBatch || false,
    rotation_index: getRotation(loadState(), loadConfig()).cyclePosition,
    duration_seconds: ((Date.now() - startTime) / 1000).toFixed(1),
  };

  const logPath = path.join(DATA_DIR, `daily_log_${dateStr}.json`);
  fs.writeFileSync(logPath, JSON.stringify(logData, null, 2));
  log("LOG", `Daily log saved to ${logPath}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
