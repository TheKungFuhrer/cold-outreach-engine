# Master Lead Consolidation & GHL Export

**Date:** 2026-03-24
**Status:** Approved

## Problem

The cold outreach pipeline processes leads through multiple stages (scrape, classify, phone validate, email enrich) but there is no single master record for each lead. The same venue can appear in `data/classified/venues.csv`, `data/phone_validated/mobile.csv`, `data/anymailfinder/additional_contacts.csv`, and `data/final/clean_venues_*.csv` with different subsets of data in each file. This makes it impossible to get a complete picture of a lead without manually cross-referencing files.

## Solution

A single Node.js script (`scripts/build-master.js`) that reads all source CSVs, merges them by normalized domain + email composite key, and outputs a flat master CSV plus GHL-compatible exports on demand.

## Approach

In-memory merge using existing shared modules (`shared/csv.js`, `shared/fields.js`, `shared/dedup.js`). All data (~112K records) fits comfortably in memory. Full rebuild each run (~10-15 seconds). Incremental by nature — re-reads all sources, dedup key prevents duplicates.

**Relationship to existing scripts:** `3-outreach/build_master_list.js` does email-level dedup and produces `data/upload/master_enriched_emails.csv`. This new script supersedes that — it consumes the same sources but produces a richer, domain-keyed master with all pipeline metadata. The old script remains functional but `build-master.js` is the canonical source of truth going forward.

## Data Model

### Master Record Schema

One row per contact (email). A venue with 3 emails = 3 rows, all sharing company-level fields.

| Column | Source | Notes |
|--------|--------|-------|
| `domain` | All (dedup key) | Normalized via `dedup.normalizeDomain()` |
| `email` | All | Lowercased, trimmed |
| `first_name` | SmartLead, GeoLead (parsed) | From `decision_maker_name` split |
| `last_name` | SmartLead, GeoLead (parsed) | Same |
| `company_name` | All | Best non-empty value |
| `phone` | SmartLead, GeoLead, classified | Best non-empty |
| `phone_type` | Phone-validated | `mobile`, `landline`, `voip`, `invalid`, or empty |
| `phone_carrier` | Phone-validated | Carrier name or empty |
| `website` | All | Original URL (not normalized) |
| `location_raw` | SmartLead, GeoLead | Original string |
| `city` | Parsed from location | Best-effort |
| `state` | Parsed from location | Two-letter abbreviation |
| `zip` | Parsed from location | 5-digit if found |
| `is_venue` | Classified/verified | `true`/`false` |
| `confidence` | Classified/verified | 0.0–1.0 |
| `classification_reasoning` | Classified/verified | AI explanation |
| `score` | Scored venues | 0–100, joined by email from most recent `data/scored/scored_venues_*.csv`. Leads not yet scored get null. Re-running the scorer and then re-running this builder picks up updated scores. |
| `source` | Derived | `smartlead_original`, `geolead`, `anymailfinder` |
| `source_detail` | GeoLead `_source_query`, SmartLead campaign ID | Granular provenance |
| `email_source` | Derived | Where this specific email came from: `primary`, `anymailfinder_original`, `anymailfinder_geolead` |
| `pipeline_stage` | Derived | Waterfall (see below) |
| `last_updated` | Generated | ISO timestamp of when this row was last written |

### Pipeline Stage Waterfall

Highest applicable stage wins:

1. `in_campaign` — Lead exists in SmartLead campaign data with engagement metrics
2. `uploaded` — Lead was uploaded to SmartLead (`in_smartlead=yes` in master email list)
3. `enriched` — Lead has AnyMailFinder-discovered emails
4. `validated` — Lead has phone validation results (line_type set)
5. `classified` — Lead has `is_venue`/`confidence` from Haiku/Sonnet
6. `filtered` — Lead passed prefilter
7. `raw` — Otherwise

### Merge Priority

Later sources fill empty fields but never overwrite populated ones:

1. SmartLead raw export (base records)
2. GeoLead enriched data (adds decision maker, source query)
3. Classified results (adds venue flag, confidence)
4. Phone-validated results (adds phone type, carrier)
5. Verified/escalated results (upgrades ambiguous classifications)
6. AnyMailFinder contacts (adds new email rows to existing domains)
7. Scored venues (adds score)

### Dedup Logic

- Primary key: `domain + email` composite
- When same domain+email seen from multiple sources, merge fields (fill blanks, don't overwrite)
- When AnyMailFinder adds new emails for a known domain, those become new rows inheriting company-level fields (company_name, phone, website, location, classification, etc.)

## Script Structure

### Entry Point

`scripts/build-master.js`

```
Usage:
  node scripts/build-master.js [options]

Options:
  --export ghl          After building master, also generate GHL CSVs
  --min-score N         GHL export filter: minimum lead score (default: 0)
  --min-stage STAGE     GHL export filter: minimum pipeline stage (default: raw)
  --dry-run             Report what would be built without writing files
```

### Phase 1: Ingest & Merge

1. Read all source CSVs using `shared/csv.js`
2. Normalize common fields via `shared/fields.js:normalizeRow()` → canonical names for email, firstName, lastName, companyName, phone, website, city, state, location, source. **Note:** `normalizeRow()` only returns these common fields — pipeline-specific fields (`is_venue`, `confidence`, `reasoning`, `phone_valid`, `line_type`, `carrier`, `score`) must be read directly from the raw CSV row and carried alongside the normalized fields.
3. For each row, compute `normalizeDomain(website)` → domain key
4. Insert into `Map<domain, Map<email, record>>`, merging fields per priority rules
5. AnyMailFinder rows: look up existing domain entry, create new email rows inheriting company-level fields

### Phase 2: Enrich & Derive

Walk every record and compute:
- `pipeline_stage` via waterfall logic
- `city`, `state`, `zip` via location parser
- `first_name`, `last_name` via name parser (splitting `decision_maker_name`)
- `score` by joining from most recent `data/scored/scored_venues_*.csv`
- `last_updated` = current ISO timestamp

Flatten the nested maps into a sorted array (by domain, then email).

### Phase 3: Export

- Write `data/master/leads_master.csv` (always)
- If `--export ghl`:
  - Build a domain→emails lookup for `Additional Emails` aggregation (group all emails by domain, then for each contact row, semicolon-join the other emails for that domain)
  - Apply `--min-score` and `--min-stage` filters using a stage-to-rank mapping: `raw=0, filtered=1, classified=2, validated=3, enriched=4, uploaded=5, in_campaign=6`
  - Generate the three GHL CSVs

### Console Output

Summary printed after each run:
- Total domains, total contacts, breakdown by source, by pipeline stage
- New records since last run (if previous master exists — diff by row count per domain)

## GHL Export Formats

### Contacts (`data/master/ghl_contacts.csv`)

| GHL Field | Source |
|-----------|--------|
| `Phone` | `phone` |
| `Email` | `email` |
| `First Name` | `first_name` |
| `Last Name` | `last_name` |
| `Business Name` | `company_name` |
| `Source` | `source` |
| `Additional Emails` | Semicolon-joined other emails for same domain (excluding this row's email) |
| `Additional Phones` | Empty (only one phone per domain currently) |
| `Notes` | `classification_reasoning` (truncated to 500 chars) |
| `Tags` | Comma-separated: phone type, source, confidence tier (`high` ≥0.85, `medium` ≥0.7, `low` below) |

One row per contact.

### Companies (`data/master/ghl_companies.csv`)

| GHL Field | Source |
|-----------|--------|
| `Company Name` | `company_name` |
| `Phone` | `phone` (first available for domain) |
| `Email` | Primary email (first email seen for domain) |
| `Website` | `website` |
| `Address` | `location_raw` |
| `City` | `city` |
| `State` | `state` |
| `Postal Code` | `zip` |
| `Country` | `US` (hardcoded) |
| `Description` | Empty |

One row per unique domain.

### Opportunities (`data/master/ghl_opportunities.csv`)

| GHL Field | Source |
|-----------|--------|
| `Opportunity Name` | `company_name` |
| `Phone` | `phone` |
| `Email` | `email` |
| `Pipeline ID` | Empty (mapped in GHL) |
| `Stage ID` | Empty (mapped in GHL) |
| `Lead Value` | `75` |
| `Source` | `source` |
| `Notes` | `score: N, stage: X, confidence: Y` |
| `Tags` | Same as contacts |
| `Status` | `open` |

One row per contact. Filtered by `--min-score` and `--min-stage` at export time.

## Utility Functions

### Location Parser

The existing `shared/fields.js:parseLocation()` returns `{ city, state }` but does not extract zip codes or handle full state names. This script needs an extended parser (`parseLocationFull()`) added to `shared/fields.js` that returns `{ city, state, zip }`:

```
"Austin, TX"          → city=Austin, state=TX, zip=
"Austin, TX 78701"    → city=Austin, state=TX, zip=78701
"New York, New York"  → city=New York, state=NY, zip=
"Miami FL 33101"      → city=Miami, state=FL, zip=33101
```

Implementation requirements:
- Add a full-state-name-to-abbreviation lookup object (50 states + DC + territories)
- Regex for 5-digit zip codes (optionally with +4 extension, but store only 5-digit)
- Handle edge cases: extra whitespace, trailing commas, "USA" suffix
- If no match, leave `city`/`state`/`zip` blank, keep `location_raw` intact
- The existing `parseLocation()` is left unchanged to avoid breaking other scripts

### Name Splitter

The existing `shared/fields.js:parseName()` handles prefix stripping and first/last splitting. For single-token names, the existing behavior is `"Smith" → first=Smith, last=""`. This script follows that convention.

Enhancements needed for `parseName()`:
- Add suffix stripping: Jr., Sr., III, PhD, etc. (not currently implemented)

```
"John Smith"           → first=John, last=Smith
"Dr. Jane Doe"         → first=Jane, last=Doe (strip prefix)
"Mary Jane Watson"     → first=Mary, last=Jane Watson (first token = first name, rest = last)
"Smith"                → first=Smith, last= (existing behavior, kept as-is)
""                     → first=, last=
"John Smith Jr."       → first=John, last=Smith (strip suffix)
```

- If SmartLead already has `first_name`/`last_name` populated, don't overwrite with parsed values

## Data Sources Consumed

| Source | Location | Records | Key Fields Added |
|--------|----------|---------|-----------------|
| SmartLead raw | `data/raw/campaign_*.csv` | ~17,901 | Base contact + engagement metrics |
| GeoLead enriched | `data/enriched/geolead_net_new.csv` | ~26,539 | Decision maker, source query, lat/long |
| Classified venues | `data/classified/venues.csv` + `data/classified_geolead/venues.csv` | ~23,809 combined (8,958 original + 14,851 GeoLead) | is_venue, confidence, reasoning |
| Classified non-venues | `data/classified/non_venues.csv` + `data/classified_geolead/non_venues.csv` | ~15,313 combined | is_venue=false |
| Phone validated | `data/phone_validated/*.csv` | ~25,408 | phone_type, carrier |
| Verified/escalated | `data/verified/*.csv` + `data/verified_geolead/*.csv` | ~524 | Upgraded classifications |
| AnyMailFinder original | `data/anymailfinder/additional_contacts.csv` | ~8,889 | Additional emails per domain |
| AnyMailFinder GeoLead | `data/anymailfinder/geolead_additional_contacts.csv` | ~44,000 | Additional emails per domain |
| Master email list | `data/upload/master_enriched_emails.csv` | ~112,045 | in_smartlead flag |
| Scored venues | `data/scored/scored_venues_*.csv` (most recent) | ~23,000 | score (0-100). **Note:** `data/scored/` may not exist yet if the lead scoring module hasn't been run. The script handles this gracefully — missing scored data means all leads get null score. |

## Output Files

| File | Contents |
|------|----------|
| `data/master/leads_master.csv` | Complete flat master — one row per contact |
| `data/master/ghl_contacts.csv` | GHL Contacts import format |
| `data/master/ghl_companies.csv` | GHL Companies import format (one row per domain) |
| `data/master/ghl_opportunities.csv` | GHL Opportunities import format |

## Dependencies

- `shared/csv.js` — CSV read/write
- `shared/fields.js` — Field normalization (`normalizeRow()`)
- `shared/dedup.js` — Domain normalization (`normalizeDomain()`)
- `shared/utils.js` — Project paths, timestamps, mkdir
- No new npm dependencies required
