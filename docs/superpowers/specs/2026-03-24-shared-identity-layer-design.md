# Shared Identity Layer — Design Spec

**Date:** 2026-03-24
**Status:** Approved
**Repos:** cold-outreach-engine, skool-engine

## Problem

The cold-outreach-engine (45K+ leads, 112K emails) and skool-engine (1,400+ Skool members synced to GHL) operate in isolation. There is no way to answer:

- Has this cold lead already joined my Skool community?
- Which Skool members came from cold outreach vs organic?
- Should this Skool member be suppressed from outreach?

## Solution

A shared SQLite database at a known filesystem path that both repos read from and write to via thin adapter modules. No new repo — just a shared data directory and ~100-line adapters in each project.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Storage | SQLite at shared path | Handles 112K+ records trivially, indexed lookups, ACID writes, no server |
| Location | `C:\Users\Administrator\projects\shared-data\identity.db` | Configurable via `IDENTITY_DB_PATH` env var |
| Primary key | Lowercase trimmed email | Only field reliably present in both systems |
| Skool email source | `survey_a1` primary, `email` fallback; store both if different | Real emails live in survey answers, not the Skool email field |
| Source taxonomy | `cold_outreach`, `skool_organic`, `skool_referred` | Three sources sufficient; referral detected from Skool `survey_a3` |
| Sync trigger | On-demand command + hook into upload pipeline | Manual reconcile anytime; auto-check before SmartLead uploads |
| Overlap action | Semi-automated — auto-tag in GHL, auto-suppress from new uploads, don't touch live campaigns | Safe default; no retroactive disruption |

## Data Model

### `contacts` table

| Column | Type | Notes |
|--------|------|-------|
| `email` | TEXT PRIMARY KEY | Lowercase, trimmed |
| `domain` | TEXT | Normalized domain (from email or website) |
| `first_name` | TEXT | |
| `last_name` | TEXT | |
| `company_name` | TEXT | |
| `phone` | TEXT | |
| `website` | TEXT | |
| `source` | TEXT | `cold_outreach`, `skool_organic`, or `skool_referred` |
| `cold_outreach_lead` | INTEGER | 1 if exists in cold-outreach pipeline |
| `skool_member` | INTEGER | 1 if exists in skool-engine |
| `skool_member_id` | TEXT | Skool UUID (for linking back) |
| `skool_classification` | TEXT | `active_venue_owner`, `aspiring_venue_owner`, `service_provider`, `other` |
| `ghl_contact_id` | TEXT | GHL ID (for tagging) |
| `ghl_tagged` | INTEGER | 1 if overlap tag has been written to GHL |
| `smartlead_suppressed` | INTEGER | 1 if excluded from future uploads |
| `first_seen_cold` | TEXT | ISO timestamp |
| `first_seen_skool` | TEXT | ISO timestamp |
| `last_synced` | TEXT | ISO timestamp |

### Indexes

- `idx_domain` on `domain` — domain-level overlap checks
- `idx_source` on `source` — attribution queries
- `idx_overlap` on `(cold_outreach_lead, skool_member)` — fast overlap detection

## Adapter Modules

### cold-outreach-engine: `shared/identity.js`

- `openDb()` — opens/creates SQLite DB, runs schema migration if needed
- `loadColdLeads(csvPath)` — bulk upserts cold leads; sets `cold_outreach_lead = 1`, `first_seen_cold` on first insert; preserves existing Skool data
- `checkOverlaps(emails)` — given a batch of emails, returns those where `skool_member = 1` (for upload suppression)
- `markSuppressed(emails)` — sets `smartlead_suppressed = 1`
- `getStats()` — returns counts: total contacts, overlaps, by source, suppressed

### skool-engine: `scripts/lib/identity.js`

- `openDb()` — same open/migrate pattern
- `loadSkoolMembers(progressJson)` — bulk upserts Skool members; tries `survey_a1` then `email`; if both exist and differ, creates rows for both emails with same `skool_member_id`; sets `skool_member = 1`, `first_seen_skool`, `skool_classification`, `ghl_contact_id`
- `getUntaggedOverlaps()` — returns overlaps where `ghl_tagged = 0`
- `markTagged(email)` — sets `ghl_tagged = 1`
- `getStats()` — same stats interface

### Shared conventions

- Both adapters resolve DB path from `IDENTITY_DB_PATH` env var, defaulting to `C:\Users\Administrator\projects\shared-data\identity.db`
- Email normalization: `email.trim().toLowerCase()` before all inserts and lookups
- Upsert via `INSERT ... ON CONFLICT(email) DO UPDATE` — never overwrites `source` or `first_seen_*` timestamps
- Schema version tracked via SQLite `user_version` pragma

## Sync Flow

### Standalone reconcile: `shared-data/reconcile.js`

A Node.js script in the shared-data directory. Performs full reconciliation:

1. **Load cold leads** — reads `cold-outreach-engine/data/upload/master_enriched_emails.csv`, bulk upserts
2. **Load Skool members** — reads `skool-engine/data/enriched/progress.json`, bulk upserts with `survey_a1`/`email` matching
3. **Detect overlaps** — queries `WHERE cold_outreach_lead = 1 AND skool_member = 1`
4. **Report** — prints overlap count, new overlaps since last run, attribution breakdown

Configuration: `shared-data/config.json` stores paths to each repo's data directories.

### Hook: cold-outreach upload suppression

In `3-outreach/upload_leads.js`, before uploading each batch to SmartLead:

1. Call `checkOverlaps(batchEmails)`
2. Filter out emails where `skool_member = 1`
3. Log suppressed count
4. Call `markSuppressed(suppressedEmails)`

~10-line addition to existing upload script.

### Hook: skool-engine GHL tagging

In `scripts/sync-writeback.js`, after writing master notes:

1. Call `getUntaggedOverlaps()`
2. For each overlap, add `cold_outreach_overlap` tag via GHL API
3. Call `markTagged(email)` for each success

Uses existing `ghl-api.js` client. ~15-line addition.

## What Does NOT Change

- No existing CSV/JSON files in either repo are modified by the identity layer
- Reconcile is read-only against both repos' data, write-only to the identity DB
- Existing pipeline steps continue to work without the identity layer present
- The upload suppression is the only place that actively changes pipeline behavior
- Live SmartLead campaigns are never retroactively modified

## Source Attribution Logic

- Contact first appears from cold-outreach pipeline: `source = 'cold_outreach'`
- Contact first appears from Skool with referral indicated in `survey_a3`: `source = 'skool_referred'`
- Contact first appears from Skool with no referral: `source = 'skool_organic'`
- Source is set on first insert and never overwritten — it captures where the contact originated
- Referral detection: `survey_a3` is checked for non-empty values that indicate a person referred them (vs generic answers like "Google" or "Facebook ad")

## Dependencies

- `better-sqlite3` npm package — added to both repos
- Shared data directory created at `C:\Users\Administrator\projects\shared-data\`
- `IDENTITY_DB_PATH` env var (optional, has default)

## Scale Considerations

- 112K emails + 1.4K Skool members = ~113K rows — trivial for SQLite
- Indexed email lookups: sub-millisecond
- Full reconcile (bulk upsert 112K rows): ~2-5 seconds with transactions
- No performance concerns at this scale
