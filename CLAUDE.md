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

### 3. Outreach — Upload and campaign management

```bash
# Upload leads to SmartLead (REST API, 400/batch, resumable)
node 3-outreach/upload_leads.js --input <csv> --campaign-id <id> [--dry-run]

# Assign leads to campaigns (optional phone segmentation)
node 3-outreach/assign_campaigns.js --campaign-id <id> [--segment mobile|voip|landline] [--limit N]

# SmartLead email verification (NOTE: API returns 404, must be done manually in SmartLead UI)
# node 3-outreach/verify_emails.js --campaign-id <id>

# SmartLead Prospect find-emails (domain contact discovery, 5 req/s)
node 3-outreach/prospect_emails.js --input <csv> [--limit N]

# Build master enriched email list from all sources
node 3-outreach/build_master_list.js
```

### 4. Analytics & Reporting

```bash
# Pipeline funnel metrics and conversion rates
node 4-analytics/funnel_report.js [--json]

# API cost estimates (Haiku/Sonnet/Numverify)
node 4-analytics/cost_report.js

# SmartLead campaign performance (opens, replies, bounces)
node 4-analytics/campaign_stats.js

# Email account health audit
node 4-analytics/mailbox_audit.js

# Configure new SmartLead email accounts
node 4-analytics/configure_new_mailboxes.js
```

### 5. Lifecycle Tracking

```bash
# Maps SmartLead engagement data to lead segments
node 5-lifecycle/funnel_tracker.js --campaign-id <id>

# Cost-per-acquisition tracker
node 5-lifecycle/cpa_tracker.js [--subscription-cost N]
```

### 6. Daily Automated Prospecting

```bash
# Daily cron job — rotates search terms and US regions, deduplicates, classifies, uploads
node scripts/daily-prospect.js [--dry-run] [--limit N] [--force]

# Config: scripts/daily-prospect-config.json
# Data: data/daily-prospects/
# Cron: 0 9 * * * (9 AM daily)
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
  classify_non_venues.py  Non-venue sub-classification (services/adjacent/irrelevant)
  escalate_sonnet.py      Sonnet ambiguous escalation
  validate_phones.py      Numverify phone validation
  export_clean.js         Final venue merge
  anymailfinder_*.py      AnyMailFinder contact discovery (individual + bulk)
  anymailfinder_bulk_*.js AnyMailFinder bulk submit/status/download (JS)
3-outreach/             Campaign management
  upload_leads.js         SmartLead REST upload (400/batch, resumable)
  assign_campaigns.js     Campaign assignment with phone segmentation
  verify_emails.js        SmartLead email verification trigger
  prospect_emails.js      SmartLead Prospect find-emails discovery
  build_master_list.js    Master enriched email consolidation
4-analytics/            Reporting
  funnel_report.js        Pipeline stage metrics and conversion rates
  cost_report.js          API cost estimates
  campaign_stats.js       SmartLead campaign performance
  mailbox_audit.js        Email account health audit
  configure_new_mailboxes.js  New account setup
5-lifecycle/            Funnel tracking
  funnel_tracker.js       Engagement-to-segment mapping
  cpa_tracker.js          Cost-per-acquisition analysis
scripts/                Automation
  daily-prospect.js       Daily automated prospecting cron job
  daily-prospect-config.json  Cron configuration
  batch-helper.py         Async Haiku batch helper
  update-dashboards.js    HTML dashboard data refresh
shared/                 Reusable utilities
  env.js                  Environment variable loading
  csv.js                  CSV read/write/stream helpers
  dedup.js                Domain normalization and dedup
  progress.js             Checkpoint/resume helpers
  utils.js                Project paths, timestamps, mkdir
  smartlead.js            SmartLead REST API client with rate limiter
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

## Current State (as of 2026-03-23)

### Lead Pipeline Complete
- **Original SmartLead batch:** 17,901 scraped → 14,052 after prefilter → 8,958 venues + 5,018 non-venues + 76 ambiguous
- **GeoLead batch 1:** 146,009 raw records → 26,539 net-new after dedup → 14,851 venues + 10,295 non-venues
- **GeoLead batch 2 (manual inbox):** 5,570 records across 32 CSVs → 2,661 net-new domains processed via AnyMailFinder bulk
- **Total classified venues:** ~24,044 across all batches
- **Phone validation:** All venues validated (mobile/landline/voip segmentation)

### Email Enrichment Complete
- **AnyMailFinder original:** 55,984 additional emails across 8,004 venues
- **AnyMailFinder GeoLead bulk:** 18,594 net-new emails from GeoLead + inbox batches
- **Master email list:** 112,045 unique emails (deduplicated across all sources)

### SmartLead Campaigns
- **Venues_AllSources_Mar26** (ID: 3071191) — All confirmed venue leads
- **NonVenues_AllSources_Mar26** (ID: 3071192) — Non-venue leads for exclusion
- **VenueOwners_US_Sep25** (ID: 2434779) — Original campaign with engagement data

### Automation
- **Daily prospecting cron:** Built (`scripts/daily-prospect.js`), not yet activated
- **Pipeline orchestrator:** `pipeline.js` chains all steps with --start-at, --skip, --dry-run
- **HTML dashboards:** 5 views auto-refreshed by `scripts/update-dashboards.js`
