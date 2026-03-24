/**
 * Master lead map — shared constants and functions for the pipeline orchestrator.
 *
 * Extracted from scripts/build-master.js with additional query/promote functions
 * for tracking per-lead pipeline state.
 */

const { readCsv, writeCsv } = require("./csv");
const { projectPath } = require("./utils");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MASTER_COLUMNS = [
  "domain", "email", "first_name", "last_name", "company_name",
  "phone", "phone_type", "phone_carrier", "website", "location_raw",
  "city", "state", "zip", "is_venue", "confidence",
  "classification_reasoning", "score", "source", "source_detail",
  "email_source", "pipeline_stage", "last_updated",
];

/** Company-level fields that get inherited when a new email is added to an existing domain. */
const COMPANY_FIELDS = [
  "company_name", "phone", "phone_type", "phone_carrier", "website",
  "location_raw", "city", "state", "zip", "is_venue", "confidence",
  "classification_reasoning", "source", "source_detail",
];

const STAGE_RANK = {
  raw: 0, filtered: 1, classified: 2, validated: 3,
  exported: 4, uploaded: 5, in_campaign: 6,
};

const MASTER_CSV_PATH = projectPath("data", "master", "leads_master.csv");

// ---------------------------------------------------------------------------
// Merge map — Map<domain, Map<email, record>>
// ---------------------------------------------------------------------------

function createMergeMap() {
  return new Map();
}

/** Remove empty-string and undefined values from an object. */
function stripEmpty(obj) {
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== "") result[k] = v;
  }
  return result;
}

/**
 * Merge a record into the map. Fills empty fields but never overwrites populated ones.
 * If the domain already exists but this email is new, inherits company-level fields.
 * Pass forceFields array to overwrite specific fields even if already set.
 */
function mergeIntoMap(map, record, forceFields = []) {
  const domain = record.domain;
  const email = record.email;
  if (!domain && !email) return;

  const key = domain || email;
  if (!map.has(key)) map.set(key, new Map());
  const domainMap = map.get(key);

  if (!domainMap.has(email)) {
    // New email for this domain — inherit company-level fields from first existing record
    const inherited = {};
    if (domainMap.size > 0) {
      const firstRecord = domainMap.values().next().value;
      for (const field of COMPANY_FIELDS) {
        if (firstRecord[field]) inherited[field] = firstRecord[field];
      }
    }
    domainMap.set(email, { ...inherited, ...stripEmpty(record) });
  } else {
    // Existing domain+email — fill blanks, and force-overwrite specified fields
    const existing = domainMap.get(email);
    for (const [k, v] of Object.entries(record)) {
      if (v && (!existing[k] || forceFields.includes(k))) existing[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/**
 * Load the master CSV into a Map<domain, Map<email, record>>.
 * @returns {Map}
 */
function loadMaster() {
  const map = createMergeMap();
  const { records } = readCsv(MASTER_CSV_PATH);
  for (const record of records) {
    mergeIntoMap(map, record);
  }
  return map;
}

/**
 * Flatten the merge map to an array, sort by domain+email, and write to the master CSV.
 * @param {Map} map
 * @returns {string} path written
 */
function saveMaster(map) {
  const flat = [];
  for (const [domain, emailMap] of map) {
    for (const [email, record] of emailMap) {
      record.domain = domain;
      record.email = email;
      const out = {};
      for (const col of MASTER_COLUMNS) {
        out[col] = record[col] || "";
      }
      flat.push(out);
    }
  }
  flat.sort((a, b) =>
    (a.domain || "").localeCompare(b.domain || "") ||
    (a.email || "").localeCompare(b.email || "")
  );
  writeCsv(MASTER_CSV_PATH, flat, MASTER_COLUMNS);
  return MASTER_CSV_PATH;
}

// ---------------------------------------------------------------------------
// Query / Promote
// ---------------------------------------------------------------------------

/**
 * Return all records whose pipeline_stage equals the given stage.
 * @param {Map} map
 * @param {string} stage
 * @returns {object[]}
 */
function queryByStage(map, stage) {
  const results = [];
  for (const [, emailMap] of map) {
    for (const [, record] of emailMap) {
      if (record.pipeline_stage === stage) {
        results.push(record);
      }
    }
  }
  return results;
}

/**
 * Promote matched leads to newStage if it is higher than their current stage.
 * Updates pipeline_stage and last_updated. Never demotes.
 * @param {Map} map
 * @param {Array<{domain: string, email: string}>} leads
 * @param {string} newStage
 * @returns {number} count of promoted leads
 */
function promoteLeads(map, leads, newStage) {
  const newRank = STAGE_RANK[newStage];
  if (newRank === undefined) return 0;
  const now = new Date().toISOString();
  let count = 0;

  for (const lead of leads) {
    const key = lead.domain || lead.email;
    if (!key || !map.has(key)) continue;
    const domainMap = map.get(key);
    const email = lead.email;
    if (!domainMap.has(email)) continue;

    const record = domainMap.get(email);
    const currentRank = STAGE_RANK[record.pipeline_stage] || 0;
    if (newRank > currentRank) {
      record.pipeline_stage = newStage;
      record.last_updated = now;
      count++;
    }
  }
  return count;
}

module.exports = {
  MASTER_COLUMNS,
  COMPANY_FIELDS,
  STAGE_RANK,
  MASTER_CSV_PATH,
  createMergeMap,
  stripEmpty,
  mergeIntoMap,
  loadMaster,
  saveMaster,
  queryByStage,
  promoteLeads,
};
