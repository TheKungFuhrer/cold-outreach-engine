#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { readCsv, writeCsv } = require("../shared/csv");
const { resolveField } = require("../shared/fields");
const { normalizeDomain } = require("../shared/dedup");
const { projectPath, ensureDir, timestamp } = require("../shared/utils");
const { UnionFind, levenshtein, tokenOverlap, normalizeCompanyName, normalizePhone } = require("../shared/dedup-helpers");

const STAGE_RANK = { raw: 0, filtered: 1, classified: 2, validated: 3, enriched: 4, uploaded: 5, in_campaign: 6 };
const SOURCE_RANK = { smartlead: 3, anymailfinder: 2, geolead: 1 };

function loadAndNormalize(inputPath) {
  const { records, columns } = readCsv(inputPath);
  if (records.length === 0) { console.error("No records found in", inputPath); process.exit(1); }
  const isBuildMaster = columns.includes("domain");
  return records.map((row, i) => {
    let email, firstName, lastName, companyName, phone, website, domain, city, state, source, pipelineStage, score;
    if (isBuildMaster) {
      email = (row.email || "").toLowerCase().trim();
      firstName = (row.first_name || "").trim();
      lastName = (row.last_name || "").trim();
      companyName = (row.company_name || "").trim();
      phone = row.phone || "";
      website = row.website || "";
      domain = row.domain || "";
      city = (row.city || "").trim();
      state = (row.state || "").trim().toUpperCase();
      source = (row.source || "").trim();
      pipelineStage = (row.pipeline_stage || "").trim();
      score = parseFloat(row.score) || 0;
    } else {
      email = resolveField(row, "email").toLowerCase().trim();
      firstName = resolveField(row, "firstName").trim();
      lastName = resolveField(row, "lastName").trim();
      companyName = resolveField(row, "companyName").trim();
      phone = resolveField(row, "phone");
      website = resolveField(row, "website");
      city = ""; state = "";
      const loc = resolveField(row, "location");
      if (loc) { const m = loc.match(/([^,]+),\s*([A-Z]{2})/i); if (m) { city = m[1].trim(); state = m[2].toUpperCase(); } }
      source = row.source || "";
      pipelineStage = row.pipeline_stage || "";
      score = parseFloat(row.score) || 0;
    }
    return {
      ...row,
      _id: i, _email: email, _domain: domain ? normalizeDomain(domain) : normalizeDomain(website),
      _phone: normalizePhone(phone), _companyNorm: normalizeCompanyName(companyName),
      _firstName: firstName, _lastName: lastName, _city: city, _state: state,
      _source: source.toLowerCase(), _pipelineStage: pipelineStage, _score: score,
    };
  });
}

function runLayers(records) {
  const uf = new UnionFind(records.length);
  let unions;

  // Layer 1: Exact email
  unions = 0;
  const emailIndex = new Map();
  for (const r of records) {
    if (!r._email) continue;
    if (emailIndex.has(r._email)) { uf.union(emailIndex.get(r._email), r._id, "exact_email"); unions++; }
    else { emailIndex.set(r._email, r._id); }
  }
  console.log(`  Layer 1 (exact_email): ${unions} unions`);

  // Layer 2: Normalized domain — cross-source only
  unions = 0;
  const domainIndex = new Map();
  for (const r of records) { if (!r._domain) continue; if (!domainIndex.has(r._domain)) domainIndex.set(r._domain, []); domainIndex.get(r._domain).push(r); }
  for (const [, group] of domainIndex) {
    if (group.length < 2) continue;
    for (let i = 1; i < group.length; i++) {
      const a = group[0], b = group[i];
      if (a._email === b._email) continue;
      if (a._source !== b._source) { uf.union(a._id, b._id, "domain_match"); unions++; }
    }
  }
  console.log(`  Layer 2 (domain_match): ${unions} unions`);

  // Layer 3: Phone match
  unions = 0;
  const phoneIndex = new Map();
  for (const r of records) {
    if (!r._phone) continue;
    if (phoneIndex.has(r._phone)) { uf.union(phoneIndex.get(r._phone), r._id, "phone_match"); unions++; }
    else { phoneIndex.set(r._phone, r._id); }
  }
  console.log(`  Layer 3 (phone_match): ${unions} unions`);

  // Layer 4: Fuzzy company name within geo block
  unions = 0;
  const geoIndex = new Map();
  for (const r of records) {
    if (!r._companyNorm) continue;
    const block = r._state || r._city;
    if (!block) continue;
    if (!geoIndex.has(block)) geoIndex.set(block, []);
    geoIndex.get(block).push(r);
  }
  for (const [, group] of geoIndex) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (a._companyNorm === b._companyNorm) continue;
        const lenDiff = Math.abs(a._companyNorm.length - b._companyNorm.length);
        if (lenDiff > 3) continue;
        const dist = levenshtein(a._companyNorm, b._companyNorm);
        if (dist <= 3) { uf.union(a._id, b._id, "fuzzy_name+geo"); unions++; }
        else if (tokenOverlap(a._companyNorm, b._companyNorm) > 0.7) { uf.union(a._id, b._id, "fuzzy_name+geo"); unions++; }
      }
    }
  }
  console.log(`  Layer 4 (fuzzy_name+geo): ${unions} unions`);

  // Layer 5: Cross-domain name detection
  unions = 0;
  const nameIndex = new Map();
  for (const r of records) { if (!r._companyNorm || !r._domain) continue; if (!nameIndex.has(r._companyNorm)) nameIndex.set(r._companyNorm, []); nameIndex.get(r._companyNorm).push(r); }
  for (const [, group] of nameIndex) {
    if (group.length < 2) continue;
    const first = group[0];
    for (let i = 1; i < group.length; i++) {
      if (group[i]._domain !== first._domain) { uf.union(first._id, group[i]._id, "cross_domain_name"); unions++; }
    }
  }
  console.log(`  Layer 5 (cross_domain_name): ${unions} unions`);

  return uf;
}

function scoreCluster(reasons) {
  const has = (r) => reasons.includes(r);
  if (has("exact_email")) return 100;
  if (has("domain_match") && reasons.length > 1) return 95;
  if (has("domain_match")) return 90;
  if (has("phone_match") && has("fuzzy_name+geo")) return 85;
  if (has("phone_match")) return 80;
  if (has("cross_domain_name")) return 80;
  if (has("fuzzy_name+geo")) return 70;
  return 50;
}

function selectKeepRecord(clusterRecords) {
  let best = clusterRecords[0];
  for (let i = 1; i < clusterRecords.length; i++) {
    const candidate = clusterRecords[i];
    // Primary: _score
    if (candidate._score !== best._score) {
      if (candidate._score > best._score) best = candidate;
      continue;
    }
    // Secondary: richness
    const richness = (r) => {
      let pts = 0;
      if (r._email) pts += 3;
      if (r._phone) pts += 2;
      if (r._firstName && r._lastName) pts += 2;
      if (r._companyNorm) pts += 1;
      if (r._city || r._state) pts += 1;
      if (r._pipelineStage && STAGE_RANK[r._pipelineStage] !== undefined) pts += 1;
      return pts;
    };
    const rc = richness(candidate), rb = richness(best);
    if (rc !== rb) {
      if (rc > rb) best = candidate;
      continue;
    }
    // Tertiary: pipeline stage rank
    const stageC = STAGE_RANK[candidate._pipelineStage] ?? -1;
    const stageB = STAGE_RANK[best._pipelineStage] ?? -1;
    if (stageC !== stageB) {
      if (stageC > stageB) best = candidate;
      continue;
    }
    // Quaternary: source rank
    const srcC = SOURCE_RANK[candidate._source] ?? 0;
    const srcB = SOURCE_RANK[best._source] ?? 0;
    if (srcC > srcB) best = candidate;
  }
  return best._id;
}

function buildClusterOutput(uf, records) {
  const components = uf.components();
  const clusters = components.map((comp) => {
    const clusterRecords = comp.ids.map((id) => records[id]);
    const reasons = comp.reasons;
    const confidence = scoreCluster(reasons);
    const keepId = selectKeepRecord(clusterRecords);
    return {
      ids: comp.ids,
      keepId,
      confidence,
      reasons,
      records: clusterRecords,
    };
  });

  const byConfidence = {};
  const byReason = {};
  let estimatedDuplicateRecords = 0;
  for (const c of clusters) {
    const band = c.confidence >= 95 ? "high" : c.confidence >= 80 ? "medium" : "low";
    byConfidence[band] = (byConfidence[band] || 0) + 1;
    for (const r of c.reasons) {
      byReason[r] = (byReason[r] || 0) + 1;
    }
    estimatedDuplicateRecords += c.ids.length - 1;
  }

  return {
    clusters,
    summary: {
      totalClusters: clusters.length,
      byConfidence,
      byReason,
      estimatedDuplicateRecords,
    },
  };
}

const MERGE_THRESHOLD = 80;

function performMerge(records, clusters) {
  const discardSet = new Set();
  // Build a lookup from _id → record index
  const byId = new Map(records.map((r, i) => [r._id, i]));

  for (const cluster of clusters) {
    if (cluster.confidence < MERGE_THRESHOLD) continue;
    if (cluster.records.length < 2) continue;

    const keepId = cluster.keepId;
    const keepIdx = byId.get(keepId);
    if (keepIdx === undefined) continue;

    const keepRecord = records[keepIdx];

    // Collect additional emails from discarded records
    const existingExtras = keepRecord.additional_emails
      ? keepRecord.additional_emails.split(";").map(e => e.trim()).filter(Boolean)
      : [];
    const extraSet = new Set(existingExtras);

    const mergedFrom = [];
    for (const ref of cluster.records) {
      if (ref._id === keepId) continue;
      discardSet.add(ref._id);
      mergedFrom.push(ref._id);
      const discardEmail = ref.email || ref._email || "";
      if (discardEmail && discardEmail !== keepRecord._email) {
        extraSet.add(discardEmail);
      }
      // Also pick up any additional_emails from discarded record
      const discardIdx = byId.get(ref._id);
      if (discardIdx !== undefined) {
        const discardRecord = records[discardIdx];
        if (discardRecord.additional_emails) {
          for (const e of discardRecord.additional_emails.split(";").map(e => e.trim()).filter(Boolean)) {
            if (e !== keepRecord._email) extraSet.add(e);
          }
        }
      }
    }

    // Update keep record in-place
    keepRecord.additional_emails = Array.from(extraSet).join(";");
    keepRecord.merged_from = mergedFrom.join(";");
  }

  const merged = records.filter(r => !discardSet.has(r._id));
  const discarded = records.filter(r => discardSet.has(r._id));
  return { merged, discarded };
}

function writeReports(clusterOutput, records, inputPath) {
  const reportsDir = projectPath("data", "reports");
  ensureDir(reportsDir);

  // 1. duplicate_clusters.json
  const clustersJson = path.join(reportsDir, "duplicate_clusters.json");
  fs.writeFileSync(clustersJson, JSON.stringify(clusterOutput, null, 2));
  console.log(`  Wrote ${clustersJson}`);

  // 2. dedup_recommendations.csv
  const recRows = [];
  for (const cluster of clusterOutput.clusters) {
    for (const rec of cluster.records) {
      const action = rec._id === cluster.keepId ? "keep" : "discard";
      recRows.push({
        cluster_id: cluster.clusterId ?? "",
        confidence: cluster.confidence,
        action,
        email: rec._email || rec.email || "",
        company_name: rec._companyNorm || "",
        domain: rec._domain || "",
        phone: rec._phone || "",
        source: rec._source || "",
        reason: cluster.reasons.join(","),
      });
    }
  }
  const recCsv = path.join(reportsDir, "dedup_recommendations.csv");
  writeCsv(recCsv, recRows, ["cluster_id", "confidence", "action", "email", "company_name", "domain", "phone", "source", "reason"]);
  console.log(`  Wrote ${recCsv}`);

  // 3. smartlead_cleanup.csv
  const cleanupRows = [];
  for (const cluster of clusterOutput.clusters) {
    for (const rec of cluster.records) {
      if (rec._id === cluster.keepId) continue;
      const inSmartlead = rec.in_smartlead === "true" ||
        rec._pipelineStage === "uploaded" ||
        rec._pipelineStage === "in_campaign";
      if (!inSmartlead) continue;
      cleanupRows.push({
        cluster_id: cluster.clusterId ?? "",
        confidence: cluster.confidence,
        action: "discard",
        email: rec._email || rec.email || "",
        company_name: rec._companyNorm || "",
        domain: rec._domain || "",
        phone: rec._phone || "",
        source: rec._source || "",
        pipeline_stage: rec._pipelineStage || "",
        campaign_id: rec.campaign_id || "",
        reason: cluster.reasons.join(","),
      });
    }
  }
  const cleanupCsv = path.join(reportsDir, "smartlead_cleanup.csv");
  writeCsv(cleanupCsv, cleanupRows, ["cluster_id", "confidence", "action", "email", "company_name", "domain", "phone", "source", "pipeline_stage", "campaign_id", "reason"]);
  console.log(`  Wrote ${cleanupCsv}`);
}

function parseArgs(argv) {
  const args = { input: projectPath("data", "master", "leads_master.csv"), merge: false, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--input" && argv[i + 1]) { args.input = argv[++i]; }
    else if (argv[i] === "--merge") { args.merge = true; }
    else if (argv[i] === "--dry-run") { args.dryRun = true; }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`Input: ${args.input}`);
  console.log("Loading and normalizing records...");
  const records = loadAndNormalize(args.input);
  console.log(`  Loaded ${records.length} records`);

  console.log("Running dedup layers...");
  const uf = runLayers(records);

  console.log("Building cluster output...");
  const clusterOutput = buildClusterOutput(uf, records);
  const { summary } = clusterOutput;
  console.log(`  Total clusters: ${summary.totalClusters}`);
  console.log(`  By confidence: ${JSON.stringify(summary.byConfidence)}`);
  console.log(`  Estimated duplicate records: ${summary.estimatedDuplicateRecords}`);

  // Assign stable clusterId for reporting
  clusterOutput.clusters.forEach((c, i) => { c.clusterId = i + 1; });

  console.log("Writing reports...");
  writeReports(clusterOutput, records, args.input);

  if (args.merge) {
    const { merged, discarded } = performMerge(records, clusterOutput.clusters);
    console.log(`Merge: ${merged.length} kept, ${discarded.length} discarded`);

    if (!args.dryRun) {
      // Backup original
      const ts = timestamp();
      const backupPath = `${args.input}.bak.${ts}`;
      fs.copyFileSync(args.input, backupPath);
      console.log(`  Backup written to ${backupPath}`);

      // Strip internal _ fields before writing
      const cleanRecords = merged.map(r => {
        const out = {};
        for (const [k, v] of Object.entries(r)) {
          if (!k.startsWith("_")) out[k] = v;
        }
        return out;
      });
      writeCsv(args.input, cleanRecords);
      console.log(`  Merged CSV written to ${args.input}`);
    } else {
      console.log("  Dry-run: no files written");
    }
  }
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });

module.exports = { loadAndNormalize, runLayers, scoreCluster, selectKeepRecord, buildClusterOutput, performMerge, STAGE_RANK, SOURCE_RANK };
