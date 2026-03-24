# Dedup Audit — Multi-Layer Duplicate Detection & Merge

**Date:** 2026-03-24
**Status:** Approved
**Script:** `scripts/dedup_audit.js`

## Problem

The cold outreach engine has 112K+ emails across multiple sources (SmartLead exports, AnyMailFinder discovery, GeoLead searches, prospect find-emails). Current dedup is domain-level exact-match only (`shared/dedup.js`), which misses:

- Same venue under different domains (e.g., `grandballroom.com` vs `thegrandballroom.com`)
- Same company with name variations ("The Grand Ballroom" vs "Grand Ballroom LLC")
- Same person with different email addresses across sources
- Same phone number appearing on records with different domains

## Approach

Single-pass layered matching using a union-find data structure. Five matching layers build edges between records; connected components become duplicate clusters. Confidence scoring based on which layers matched. Conservative merge strategy (multi-signal required for auto-merge).

No new npm dependencies. Levenshtein distance and token overlap implemented from scratch.

## CLI Interface

```bash
# Audit only (default) — uses latest build-master output
node scripts/dedup_audit.js

# Audit with custom input
node scripts/dedup_audit.js --input data/upload/master_enriched_emails.csv

# Audit + merge high-confidence clusters
node scripts/dedup_audit.js --merge

# Dry run — writes reports but skips CSV rewrite
node scripts/dedup_audit.js --merge --dry-run
```

## Section 1: Data Loading & Normalization

Accepts `--input <csv>`, defaulting to `data/master/leads_master.csv` (the output of `scripts/build-master.js`, which has the richest schema with `score`, `phone_type`, `is_venue`, `pipeline_stage`, etc.).

Since the default input is already normalized by build-master, the script reads columns directly by their snake_case names (`email`, `first_name`, `last_name`, `company_name`, `phone`, `website`, `domain`, `city`, `state`, `source`, `pipeline_stage`, `score`, `in_smartlead`, etc.). For non-build-master inputs (via `--input`), uses `resolveField()` from `shared/fields.js` to map variant column names to canonical fields.

Each record gets an internal `_id` (row index) for union-find operations.

**Normalization functions:**
- **Domain:** `normalizeDomain()` from `shared/dedup.js` (strip protocol, www, paths, lowercase)
- **Phone:** Strip all non-digit characters, require minimum 7 digits to be considered valid
- **Company name:** New `normalizeCompanyName()` — lowercase, strip common suffixes (LLC, Inc, Corp, Ltd, Co, etc.), strip leading "The ", trim whitespace/punctuation

## Section 2: Union-Find Data Structure

~30 lines, implemented in-script:

- `find(x)` — with path compression
- `union(x, y, reason)` — merges two record IDs, stores match reason string (e.g., `"exact_email"`, `"phone_match"`, `"fuzzy_name+city"`)
- `components()` — extracts connected components as arrays of record IDs

Reason tracking feeds confidence scoring and the "why" column in recommendations. Multiple unions within the same cluster stack reasons.

## Section 3: Matching Layers

Five layers, executed in order. Each builds a hash index (blocking key -> record IDs), then unions matches within each block.

### Layer 1: Exact Email (Confidence: 100)
Hash on lowercase email. O(n).

### Layer 2: Normalized Domain (Confidence: 90)
Hash on `normalizeDomain(website)`. O(n). **Important:** This layer detects cross-source domain duplicates — records where the same entity appears with the same normalized domain but different emails. It does NOT collapse multiple contacts at the same company into one record (e.g., 5 AnyMailFinder contacts at `grandballroom.com` are different people, not duplicates). To achieve this, Layer 2 only unions records that share a domain AND have different email addresses AND come from different sources (or have no email on one side). Same-source, same-domain records with different emails are left as separate records.

### Layer 3: Phone Match (Confidence: 80)
Hash on digits-only phone (minimum 7 digits). O(n). Only matches if both records have a phone.

### Layer 4: Fuzzy Company Name within Geo Block (Confidence: 70)
Blocking key is `state` (or `city` if state missing). Within each block, pairwise compare normalized company names using:
- Levenshtein distance <= 3
- Token overlap > 70%

Only unions if fuzzy name match AND shared geographic block. Records with no state AND no city are skipped from Layer 4 entirely — fuzzy name matching without geography is unreliable.

This is the expensive layer — blocking by state keeps block sizes manageable (~2-5K records per state). The Levenshtein implementation uses a single reusable row (O(min(m,n)) space) and short-circuits when the length difference alone exceeds the threshold of 3.

### Layer 5: Cross-Domain Name Detection (Confidence: 80)
Blocking key is exact normalized company name (after suffix stripping). Unions records with same company name but different domains. O(n). Confidence is 80 (not 75) because an exact normalized company name match across different domains is a strong signal — stronger than phone-only matching.

## Section 4: Confidence Scoring & Cluster Output

After all layers run, extract connected components. For each cluster with 2+ records:

**Scoring rules** (take the max when multiple reasons present):
| Signals | Confidence |
|---------|-----------|
| Any `exact_email` link | 100 |
| `domain` + one other signal | 95 |
| `domain` alone | 90 |
| `phone` + `fuzzy_name` | 85 |
| `phone` alone | 80 |
| `cross_domain_name` | 80 |
| `fuzzy_name+geo` alone | 70 |

### Output: `data/reports/duplicate_clusters.json`

```json
{
  "generated": "2026-03-24T...",
  "input": "path/to/input.csv",
  "totalRecords": 112045,
  "totalClusters": 1234,
  "clusters": [
    {
      "clusterId": 1,
      "confidence": 95,
      "reasons": ["domain_match", "phone_match"],
      "records": [
        { "email": "...", "companyName": "...", "domain": "...", "phone": "...", "source": "...", "_id": 0 },
        { "email": "...", "companyName": "...", "domain": "...", "phone": "...", "source": "...", "_id": 42 }
      ]
    }
  ],
  "summary": {
    "byConfidence": { "100": 50, "95": 120, "90": 400 },
    "byReason": { "exact_email": 50, "domain_match": 500 },
    "estimatedDuplicateRecords": 2500
  }
}
```

Singleton clusters (no matches) are excluded.

## Section 5: Merge Recommendations & Record Selection

### Output: `data/reports/dedup_recommendations.csv`

One row per record in every cluster. Columns: `cluster_id, confidence, action, email, company_name, domain, phone, source, reason`

`action` is `keep` or `discard`.

**Richest record selection** — primary tiebreaker is `score` (the 1-100 lead score from the scoring module, if present). When scores are equal or absent, fall back to richness points:

| Field present | Points |
|--------------|--------|
| email | +3 |
| phone | +2 |
| first_name AND last_name | +2 |
| company_name | +1 |
| city or state | +1 |
| higher pipeline_stage | +1 |

Remaining ties broken by pipeline_stage rank, then source preference (SmartLead > AnyMailFinder > GeoLead — SmartLead records may have engagement data).

### Output: `data/reports/smartlead_cleanup.csv`

Lists every `discard` record that has `in_smartlead === true` or `pipeline_stage` of `uploaded`/`in_campaign`. Columns: `email, company_name, domain, campaign_id, cluster_id, reason`. For manual SmartLead cleanup.

## Section 6: The `--merge` Flag

**Merge threshold: confidence >= 80.** Fuzzy-name-only clusters (70) are never auto-merged, only reported.

For each mergeable cluster:
1. Select `keep` record via richness scoring
2. Collect unique emails from `discard` records
3. Append to `keep` record's `additional_emails` field (semicolon-separated, deduped — consistent with master CSV and GHL export format)
4. Add `merged_from` field listing discarded record sources/emails for traceability

**Backup:** Creates `.bak.<timestamp>` copy of original input before writing merged output.

**`--dry-run`:** Writes all reports but skips the actual CSV rewrite.

**Does NOT touch SmartLead.** Campaign cleanup is manual via `smartlead_cleanup.csv`.

### Merge summary output:
- Clusters merged
- Records removed
- Unique emails preserved in additional_emails
- Backup file path

## Dependencies

**Existing (reused):**
- `shared/csv.js` — readCsv, writeCsv
- `shared/fields.js` — normalizeRow, resolveField
- `shared/dedup.js` — normalizeDomain
- `shared/utils.js` — projectPath, ensureDir, timestamp

**New (implemented in-script):**
- UnionFind class (~30 lines)
- `levenshtein(a, b)` — standard dynamic programming implementation
- `tokenOverlap(a, b)` — Jaccard similarity (intersection/union) of word token sets
- `normalizeCompanyName(name)` — suffix stripping, lowercasing
- `normalizePhone(phone)` — digits-only extraction

**No new npm packages.**

## Progress Logging

Each layer logs a summary line to console on completion:
```
Layer 1 (exact_email): 450 unions across 225 clusters
Layer 2 (domain_match): 1,200 unions across 800 clusters
...
```
Final summary prints total clusters, breakdown by confidence tier, and estimated duplicate count.
