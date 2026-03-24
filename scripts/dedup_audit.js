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

module.exports = { loadAndNormalize, runLayers, scoreCluster, STAGE_RANK, SOURCE_RANK };
