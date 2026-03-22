# Cold Outreach Engine

End-to-end pipeline for OMG Rentals cold email outbound targeting wedding/event venues. Ingests leads from GeoLead searches and SmartLead CRM, deduplicates, classifies via AI, validates contacts, and manages campaign assignment.

## Environment Setup

- **Node.js 18+** with npm
- **Python 3.10+** with pip
- **SmartLead CLI:** `npm install -g @smartlead/cli` then `smartlead config set api_key <key>`
- Copy `.env.example` to `.env` and fill in API keys
- `npm install` for Node dependencies
- `pip install -r requirements.txt` for Python dependencies

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `SMARTLEAD_API_KEY` | SmartLead API key (campaigns, leads, prospect) |
| `ANTHROPIC_API_KEY_BATCH` | Anthropic API key for Haiku/Sonnet batch classification (separate from Claude Code auth) |
| `NUMVERIFY_API_KEY` | Numverify phone validation API |
| `ANYMAILFINDER_API_KEY` | AnyMailFinder contact discovery (credits may be expired) |

## Pipeline Steps

### 1. Prospecting — Find new leads

```bash
# Pull leads from SmartLead campaigns
node 1-prospecting/pull_leads.js [--campaign-id <id>]

# Run GeoLead searches (AnyMailFinder API)
python 1-prospecting/geolead/geolead_finder.py

# Dedup GeoLead results against all existing sources
node 1-prospecting/dedup/dedup_geolead.js
# Output: data/enriched/geolead_net_new.csv + dedup_report.json
```

### 2. Enrichment — Filter, classify, validate

```bash
# Pre-filter: remove government, schools, parks, no-website leads (zero AI cost)
node 2-enrichment/prefilter.js [--input <file>]
# Default input: most recent CSV in data/raw/
# Output: data/filtered/leads.csv + data/excluded/

# AI classification via Anthropic Batch API (Haiku, 50% discount)
python 2-enrichment/classify_batch.py [--input <file>] [--output-dir <dir>]
# Default input: data/filtered/leads.csv
# Output: data/classified/venues.csv, non_venues.csv, ambiguous.csv

# Sonnet escalation for ambiguous leads
python 2-enrichment/escalate_sonnet.py [--input <file>] [--output-dir <dir>]
# Default input: data/classified/ambiguous.csv
# Output: data/verified/venues.csv, non_venues.csv

# Phone validation via Numverify API (resumable)
python 2-enrichment/validate_phones.py [--input <file>] [--output-dir <dir>]
# Default input: data/classified/venues.csv
# Output: data/phone_validated/mobile.csv, voip.csv, landline.csv, invalid.csv, no_phone.csv

# Merge all confirmed venues into final clean CSV
node 2-enrichment/export_clean.js
# Output: data/final/clean_venues_<timestamp>.csv

# AnyMailFinder contact discovery (high concurrency, resumable)
python 2-enrichment/anymailfinder_contacts.py
python 2-enrichment/anymailfinder_bulk.py
```

### 3. Outreach — Upload and campaign management (TODO: next session)

```bash
# Upload leads to SmartLead (REST API)
node 3-outreach/upload_leads.js

# Assign leads to campaigns
node 3-outreach/assign_campaigns.js --campaign-id <id>
```

## Quick Reference: GeoLead Pipeline (new leads)

For processing the incoming GeoLead results end-to-end:

```bash
# 1. Dedup against existing leads
node 1-prospecting/dedup/dedup_geolead.js

# 2. Pre-filter net-new leads
node 2-enrichment/prefilter.js --input data/enriched/geolead_net_new.csv

# 3. Classify with Haiku
python 2-enrichment/classify_batch.py --input data/filtered/leads.csv

# 4. Escalate ambiguous (if any)
python 2-enrichment/escalate_sonnet.py

# 5. Phone validation
python 2-enrichment/validate_phones.py

# 6. Final export
node 2-enrichment/export_clean.js
```

## Data Directory Layout

All under `data/` (gitignored — no PII in repo):

| Directory | Contents |
|-----------|----------|
| `raw/` | SmartLead CSV exports (timestamped) |
| `filtered/` | Leads passing pre-filter |
| `excluded/` | Pre-filter rejections + summary.json |
| `classified/` | Haiku classification: venues.csv, non_venues.csv, ambiguous.csv |
| `verified/` | Sonnet escalation results |
| `phone_validated/` | Numverify segments: mobile, voip, landline, invalid, no_phone |
| `anymailfinder/original_csvs/` | Original Event_Venue search results (300 files) |
| `anymailfinder/geolead_results/` | GeoLead search results (~1,080 files) |
| `enriched/` | Dedup output: geolead_net_new.csv, dedup_report.json |
| `final/` | Upload-ready clean venue lists |
| `reports/` | Analytics output |

## Project Structure

```
1-prospecting/          Lead sourcing and deduplication
  pull_leads.js           SmartLead CLI export wrapper
  geolead/                AnyMailFinder GeoLead searches
  dedup/                  Deduplication engine
2-enrichment/           Filtering, AI classification, validation
  prefilter.js            Zero-cost keyword filtering
  classify_batch.py       Haiku batch classification
  escalate_sonnet.py      Sonnet ambiguous escalation
  validate_phones.py      Numverify phone validation
  export_clean.js         Final venue merge
  anymailfinder_*.py      AnyMailFinder contact discovery
3-outreach/             Campaign management (TODO)
4-analytics/            Reporting (TODO)
5-lifecycle/            Funnel tracking (TODO)
shared/                 Reusable utilities
  env.js                  Environment variable loading
  csv.js                  CSV read/write/stream helpers
  dedup.js                Domain normalization and dedup
  progress.js             Checkpoint/resume helpers
  utils.js                Project paths, timestamps, mkdir
  smartlead.js            SmartLead REST API client (stub)
cron/                   Automation scripts
```

## Architecture Notes

- **Cross-language pipeline:** Node.js for CSV processing and SmartLead integration, Python for Anthropic Batch API and async HTTP (aiohttp)
- **Dedup key:** Normalized domain (strip protocol, www, paths, lowercase). Works across both AnyMail format (`company_domain`) and SmartLead format (`website`)
- **Batch API:** Uses `client.messages.batches.create()` for 50% cost savings. Haiku for initial classification (confidence threshold 0.7), Sonnet for ambiguous escalation
- **Resumable workflows:** Phone validation uses JSONL checkpoints, AnyMailFinder uses JSON progress files. Safe to interrupt and re-run
- **Shared utilities:** All scripts import from `shared/` for CSV parsing, env loading, domain normalization, and progress tracking

## SmartLead Reference

```bash
# CLI commands
smartlead campaigns list --format table
smartlead campaigns export --id <id> --out <file>
smartlead leads list-all --all --format csv
smartlead leads categories
smartlead prospect find-emails --domain <domain>
smartlead prospect search --query <query>

# REST API: https://server.smartlead.ai/api/v1/
# Auth: ?api_key=<SMARTLEAD_API_KEY>
# Rate limit: 10 requests per 2 seconds
# Max 400 leads per upload request
```

## Current State (as of 2026-03-22)

- **Original pipeline:** 17,901 scraped leads → 14,052 after pre-filter → 8,958 confirmed venues + 5,018 non-venues + 76 ambiguous
- **Phone validation:** All 8,958 venues validated (mobile/voip/landline segmentation)
- **AnyMail enrichment:** 55,984 additional emails discovered across 8,004 venues
- **GeoLead dedup:** 135,378 raw records → 24,897 net-new leads (after dedup against 24,501 existing domains)
- **Next steps:** Run net-new leads through pre-filter → classify → validate → upload to SmartLead
