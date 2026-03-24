# SmartLead Engagement Sync — Design Spec

**Date:** 2026-03-24
**Status:** Draft
**Author:** Dylan + Claude

## Problem

The cold outreach engine uploads leads to SmartLead and runs email campaigns, but engagement data (replies, bounces, unsubscribes) stays trapped in SmartLead. There is no feedback loop to the master lead file or GHL CRM. Bryce has no automated way to know who replied and needs to be called on the Wavv dialer.

## Solution

A modular sync pipeline that:
1. Pulls lead-level engagement data from SmartLead's API
2. Updates the master CSV with engagement columns
3. Generates actionable CSVs (hot leads for Wavv, dead leads for exclusion)
4. Pushes hot leads to GHL (tags + tasks for Bryce)
5. Runs daily via cron

## Architecture

Three scripts orchestrated by a daily runner:

```
scripts/daily-sync.js (orchestrator, cron entry point)
  ├── 5-lifecycle/sync_smartlead_status.js (SmartLead → master CSV + hot/dead CSVs + report)
  └── 5-lifecycle/push_ghl_hot_leads.js (hot_leads.csv → GHL tags + tasks)
```

## Script 1: sync_smartlead_status.js

### Config

`5-lifecycle/sync-config.json`:
```json
{
  "campaign_ids": [3071191, 2434779],
  "sync_all_if_empty": true
}
```

When `campaign_ids` is empty and `sync_all_if_empty` is true, pulls all campaigns via `listCampaigns()`.

### Data Pull

1. For each configured campaign, paginate `GET /campaigns/{id}/leads?limit=100&offset=0` to get every lead with: `sent_count`, `open_count`, `reply_count`, `is_bounced`, `is_unsubscribed`. **Pagination terminates** when a response returns fewer than `limit` records or an empty array. Consider increasing `limit` to the API's maximum supported value to reduce request count.
2. For any lead where `reply_count > 0` **and** `last_replied_at` is after the checkpoint's `last_sync_at` (or no checkpoint exists), hit `GET /campaigns/{id}/leads/{lead_id}/message-history` to get reply text and timestamps. This avoids re-fetching message history for leads whose replies were already captured in prior syncs.
3. All calls go through the existing `shared/smartlead.js` RateLimiter (10 req/2s)

**Important:** The exact response schema for these endpoints should be verified with a test call before implementation. Field names may differ from the documented names above (e.g., `lead_status` string vs. individual count fields). The implementation should normalize whatever schema SmartLead returns.

### Multi-Campaign Merge

Build a map keyed by lowercase email. When a lead appears in multiple campaigns, apply status precedence:

```
replied > opened > unsubscribed > bounced > sent
```

Rationale: Positive engagement (replied, opened) overrides negative signals. But negative signals (unsubscribed, bounced) override mere "sent" — an unsubscribed lead should not appear as just "sent" because another campaign reached them.

Keep the most recent timestamps across campaigns. Concatenate reply texts if multiple replies exist.

### Master CSV Update

Read `data/upload/master_enriched_emails.csv` (produced by `build_master_list.js`), match by email using `resolveField(row, "email")` from `shared/fields.js`, add/overwrite these columns:

| Column | Description |
|--------|-------------|
| `smartlead_status` | replied / opened / sent / unsubscribed / bounced |
| `last_email_sent_at` | Most recent send timestamp |
| `last_opened_at` | Most recent open timestamp |
| `last_replied_at` | Most recent reply timestamp |
| `reply_text` | Latest reply content (truncated to 500 chars) |

Leads with no SmartLead match keep blank engagement columns.

### Checkpoint

- Raw SmartLead pull saved to `data/lifecycle/smartlead_sync_<timestamp>.json` (debug snapshot)
- `data/lifecycle/.sync_checkpoint.json` stores `last_sync_at` for detecting new replies

## Script 1 Outputs

### hot_leads.csv (`data/lifecycle/hot_leads.csv`)

Only leads with new replies since last sync (compared against `last_sync_at` in checkpoint).

Columns (Wavv import format):
```
Phone, First Name, Last Name, Company, Notes
```

- `Notes` = reply text, truncated to 500 chars
- Overwritten each run (not appended)

### dead_leads.csv (`data/lifecycle/dead_leads.csv`)

All leads with status bounced or unsubscribed (cumulative, all time).

Columns:
```
email, company_name, phone_number, website, smartlead_status, campaign_id
```

Overwritten each run.

### JSON Report (`data/reports/smartlead_sync_<timestamp>.json`)

```json
{
  "generated_at": "2026-03-24T09:00:00Z",
  "campaigns_synced": [3071191, 2434779],
  "totals": {
    "sent": 450,
    "opened": 120,
    "replied": 8,
    "bounced": 15,
    "unsubscribed": 3
  },
  "new_replies": 3,
  "hot_leads": ["venue@example.com"],
  "dead_leads_count": 18
}
```

### Console Summary

```
SmartLead Sync Complete — 2026-03-24
Today: 450 sent, 120 opened, 8 replied, 15 bounced, 3 unsubscribed
New hot leads for Bryce: 3
  - Wedding Barn Co (555-123-4567) — "Yes we'd love to hear more about..."
  - Lakeside Estate (555-987-6543) — "Can you send me pricing?"
Dead leads excluded: 18
```

## Script 2: push_ghl_hot_leads.js

### Input

Reads `data/lifecycle/hot_leads.csv`.

### Per-Lead Operations

1. **Find or create contact** — search GHL by email. If found, update. If not, create with email, phone, name, company.
2. **Tag contact** — add tags `"hot_lead"` and `"smartlead_replied"`
3. **Create task** — assigned to Bryce, title `"Call back: {Company Name}"`, description = reply text, due today, status pending

### Idempotency

Before creating a task, check `get_contact_tasks` for an existing pending task with the same title. Skip if duplicate.

### Error Handling

Log failures per-lead but don't abort the batch. Process leads sequentially (one at a time) to respect GHL API rate limits. Write success/failure summary to console.

### CLI

```bash
node 5-lifecycle/push_ghl_hot_leads.js [--input <csv>] [--dry-run]
```

`--dry-run` prints actions without touching GHL.

## Script 3: daily-sync.js (Orchestrator)

### Flow

1. Run `sync_smartlead_status.js`
2. If hot leads exist, run `push_ghl_hot_leads.js`
3. Print console summary
4. Exit 0 on success, 1 on failure

### CLI

```bash
node scripts/daily-sync.js [--dry-run]
```

`--dry-run` passes through to both scripts.

### Cron

`0 8 * * *` — 8 AM daily, one hour before daily prospecting cron (9 AM).

## Shared Code Changes

Two new methods added to `shared/smartlead.js`:

- `getCampaignLeads(campaignId, limit, offset)` — `GET /campaigns/{id}/leads?limit=N&offset=N`
- `getLeadMessageHistory(campaignId, leadId)` — `GET /campaigns/{id}/leads/{lead_id}/message-history` (verify exact path with a test call; may be `/leads/{id}/message-history` without campaign nesting)

Both use existing RateLimiter.

## File Inventory

### New Scripts

| File | Purpose |
|------|---------|
| `5-lifecycle/sync_smartlead_status.js` | Pull statuses, update master, generate hot/dead CSVs |
| `5-lifecycle/push_ghl_hot_leads.js` | Tag contacts + create tasks in GHL |
| `5-lifecycle/sync-config.json` | Campaign IDs to sync |
| `scripts/daily-sync.js` | Cron orchestrator |

### Modified Files

| File | Change |
|------|--------|
| `shared/smartlead.js` | Add `getCampaignLeads()` and `getLeadMessageHistory()` |

### Data Files Created

| File | Lifecycle |
|------|-----------|
| `data/lifecycle/hot_leads.csv` | Overwritten each run |
| `data/lifecycle/dead_leads.csv` | Overwritten each run |
| `data/lifecycle/.sync_checkpoint.json` | Persistent, tracks `last_sync_at` |
| `data/lifecycle/smartlead_sync_<ts>.json` | Snapshot per run |
| `data/reports/smartlead_sync_<ts>.json` | Summary report per run |

## Status Precedence

When a lead appears in multiple campaigns:

```
replied > opened > unsubscribed > bounced > sent
```

Rationale: Positive engagement overrides negative. Negative signals override mere "sent" — an unsubscribed lead should not appear as just "sent".

## Dependencies

- SmartLead API: lead-level endpoints (`/campaigns/{id}/leads`, `/leads/{id}/message-history`)
- GHL MCP: `search_contacts`, `create_contact`, `add_contact_tags`, `create_contact_task`, `get_contact_tasks`
- Existing shared modules: `smartlead.js`, `csv.js`, `fields.js`, `utils.js`, `progress.js`, `env.js`
