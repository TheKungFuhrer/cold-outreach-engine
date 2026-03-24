# Live Dashboard & Daily Email Summary — Design Spec

**Date:** 2026-03-24
**Status:** Approved

## Problem

Pipeline data is spread across multiple JSON reports, CSVs, and SmartLead sync files. There's no single view to check pipeline health, campaign performance, or hot leads from a phone or laptop. Bryce (Wavv dialer) has no automated way to receive new replied leads. Five existing HTML dashboards are static files requiring manual refresh — no live server, no email alerts.

## Solution

Three components:

1. **Data refresh script** (`scripts/refresh-dashboard.js`) — reads all source files, writes a single `data/artifacts/dashboard-data.json`
2. **Express dashboard server** (`scripts/dashboard-server.js`) — serves a self-contained HTML dashboard on port 7777 with basic auth, refreshes data on each page load
3. **Daily email summary** (`scripts/daily-email.js`) — sends a mobile-friendly HTML briefing via Gmail SMTP after daily sync completes

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Architecture | Monolithic JSON — single refresh produces single JSON, consumed by both dashboard and email | One data path, no drift between views, minimal code |
| Server | Express on port 7777 | Avoid bot scans on common ports |
| Auth | Basic HTTP auth via `express-basic-auth` | Simple shared password, 3 lines of code, sufficient for personal dashboard |
| Charts | Chart.js from CDN | No build step, self-contained HTML |
| Email transport | Nodemailer with Gmail app password | Simplest option, no OAuth dance, no third-party service |
| Email recipients | Always to owner; CC Bryce only when hot leads exist | No noise for Bryce unless there's something to act on |
| "Hot leads" window | Since last sync run | Aligns with email cadence, no missed replies |
| Old dashboards | Keep but deprecate — stop updating, don't delete | Clean up later, no maintenance burden now |

## Data Refresh (`scripts/refresh-dashboard.js`)

### Prerequisites

The master CSV must exist before refresh runs. Run `node 3-outreach/build_master_list.js` if it hasn't been generated yet. The refresh script will log a warning and skip master-dependent sections (freshness, sourceQuality) if the file is missing, rather than failing.

### Inputs

| Source | File Pattern | Data | Notes |
|--------|-------------|------|-------|
| Pipeline funnel | `data/reports/funnel_report_*.json` (latest) | Stage counts | Source uses descriptive names like "GeoLead net-new", "Post pre-filter", etc. Refresh maps these to simplified stage names (raw, filtered, classified, validated, uploaded, in_campaign). Conversion rates are computed by refresh (not in source). |
| Campaign stats | `data/reports/campaign_stats_*.json` (latest) | SmartLead campaign performance | Source fields are string-typed (`"sent_count": "0"`). Refresh parses to integers and computes rates (openRate = open_count / sent_count, etc.). |
| Cost report | `data/reports/cost_report_*.json` (latest) | API spend breakdown | Source has top-level keys `haiku`, `sonnet`, `numverify`, `smartlead_verification` with `records` and `cost` subfields. Refresh reshapes to per-stage array with costPerLead computed as cost/records. |
| Scored venues | `data/scored/scored_venues_*.csv` (latest) | Venue scores for histogram + score lookups | Used for histogram buckets AND joined with hot leads to attach scores. |
| SmartLead sync | `data/lifecycle/smartlead_sync_*.json` (latest) | Replied/bounced/unsubscribed leads | Primary source for hot leads. Structure: `{ leads: { [email]: { smartlead_status, reply_text, last_replied_at, campaign_ids } } }`. Hot leads = entries where `last_replied_at` is after the previous sync timestamp. Score attached by joining on email/domain with scored venues CSV. |
| Master CSV | `data/master/leads_master.csv` (via `shared/master.js` `loadMaster()`) | Stage counts, source breakdown, freshness | Fallback: `data/upload/master_enriched_emails.csv` if master CSV not yet generated. |
| Exclusion summary | `data/excluded/summary.json` | Prefilter rejection stats | |

"Latest" determined by glob sort on timestamp in filename.

### Data Computation Notes

**Hot leads join strategy:** Read hot leads from the sync JSON (`leads` object, filter by `last_replied_at` > previous sync timestamp). For each hot lead email, look up company/phone from the master CSV and score from the scored venues CSV (join on normalized domain). Fields: `company` from master `company_name`, `phone` from master `phone`, `replyPreview` from sync `reply_text` (first 120 chars), `repliedAt` from sync `last_replied_at`, `score` from scored venues (0 if not found).

**Freshness computation:** For each adjacent stage pair (filtered→classified, classified→validated, etc.), `unprocessedCount` = count of leads in the earlier stage minus count in the later stage (derived from funnel counts). `oldestDays` = days since the earliest-dated file in the earlier stage's output directory was last modified. If master CSV is unavailable, freshness is computed from funnel report counts only.

**Source quality computation:** Computed on the fly from master CSV + scored venues CSV. Group master records by `source` and `source_detail`, join with scores, compute avgScore (mean of scores in group) and conversionRate (count reaching `in_campaign` / total in group).

### Output

`data/artifacts/dashboard-data.json`:

```json
{
  "generatedAt": "2026-03-24T08:00:00Z",
  "funnel": {
    "stages": [
      { "name": "raw", "count": 17901, "conversionRate": null },
      { "name": "filtered", "count": 14052, "conversionRate": 0.785 },
      { "name": "classified", "count": 8958, "conversionRate": 0.637 },
      { "name": "validated", "count": 8200, "conversionRate": 0.915 },
      { "name": "uploaded", "count": 7800, "conversionRate": 0.951 },
      { "name": "in_campaign", "count": 7500, "conversionRate": 0.962 }
    ]
  },
  "campaigns": [
    {
      "name": "Venues_AllSources_Mar26",
      "id": 3071191,
      "sent": 5000,
      "opened": 1200,
      "replied": 45,
      "bounced": 300,
      "openRate": 0.24,
      "replyRate": 0.009,
      "bounceRate": 0.06
    }
  ],
  "scoreDistribution": {
    "buckets": [
      { "range": "1-10", "count": 120 },
      { "range": "11-20", "count": 450 }
    ],
    "mean": 42,
    "median": 38
  },
  "hotLeads": [
    {
      "company": "The Grand Ballroom",
      "phone": "+15551234567",
      "email": "info@grandb.com",
      "replyPreview": "Hi, we'd love to learn more about...",
      "repliedAt": "2026-03-24T06:30:00Z",
      "score": 87
    }
  ],
  "deadLeads": {
    "bounced": 300,
    "unsubscribed": 45,
    "total": 345
  },
  "costs": {
    "perStage": [
      { "stage": "classification", "costPerLead": 0.003, "totalCost": 42.15 }
    ],
    "totalSpend": 85.50
  },
  "freshness": {
    "stages": [
      { "name": "filtered", "unprocessedCount": 0, "oldestDays": 0 },
      { "name": "classified", "unprocessedCount": 150, "oldestDays": 3 }
    ]
  },
  "sourceQuality": {
    "bySource": [
      { "source": "smartlead_original", "count": 8958, "avgScore": 44, "conversionRate": 0.64 },
      { "source": "geolead", "count": 14851, "avgScore": 39, "conversionRate": 0.56 }
    ],
    "byDetail": [
      { "searchTerm": "wedding venue", "count": 3200, "avgScore": 52, "conversionRate": 0.72 }
    ]
  }
}
```

### Module Interface

```javascript
const { refresh } = require('./refresh-dashboard');
const data = await refresh(); // writes JSON, returns parsed object
```

Exported as a function so it can be called programmatically by the Express server and daily-sync, or run standalone via `node scripts/refresh-dashboard.js`.

## Express Dashboard Server (`scripts/dashboard-server.js`)

### Configuration

| Env Var | Purpose | Default |
|---------|---------|---------|
| `DASHBOARD_PORT` | Server port | `7777` |
| `DASHBOARD_USER` | Basic auth username | `admin` |
| `DASHBOARD_PASS` | Basic auth password | *(required)* |

### Routes

| Method | Path | Behavior |
|--------|------|----------|
| `GET /` | Calls `refresh()`, then serves `data/artifacts/dashboard.html` | Always-current data |
| `GET /api/data` | Serves `data/artifacts/dashboard-data.json` | For client-side fetch |
| `GET /api/hot-leads.csv` | Serves hot leads as Wavv-ready CSV download | company, phone, email, score, reply_preview |

### Startup

```bash
# Direct
node scripts/dashboard-server.js

# Persistent (survives terminal close)
pm2 start scripts/dashboard-server.js --name outreach-dashboard

# Or without pm2 (create logs/ dir first: mkdir -p logs)
nohup node scripts/dashboard-server.js > logs/dashboard.log 2>&1 &
```

Note: `logs/` directory is gitignored. Create it manually on the VPS if using nohup.

## Dashboard HTML (`data/artifacts/dashboard.html`)

Self-contained HTML file. Fetches `/api/data` on page load. Mobile-first responsive grid with dark theme.

### Sections (top to bottom)

1. **Header** — "OMG Outreach Dashboard" + last refreshed timestamp + refresh button
2. **Pipeline Funnel** — Horizontal bar chart (Chart.js). Each bar: stage name, count, conversion rate from previous stage
3. **Campaign Performance** — Table with one row per campaign: sent, opened, replied, bounced, open rate, reply rate, bounce rate. Color-coded cells (green = healthy, red = concerning)
4. **Lead Score Distribution** — Histogram with 10-point buckets (1-10, 11-20, ..., 91-100). Mean and median as vertical reference lines
5. **Hot Leads** — Card list of replied leads since last sync. Each card: company name, phone (click-to-call `tel:` link), reply preview (first 120 chars), score badge. "Export CSV for Wavv" button at top
6. **Dead Leads** — Stat cards: total bounced, total unsubscribed, cumulative
7. **Cost Metrics** — Table: stage, cost per lead, total cost. Summary row with total API spend
8. **Pipeline Freshness** — Table: stage name, unprocessed count, oldest lead age in days. Yellow/red highlighting for stale stages
9. **Source Quality** — Two sub-sections:
   - By source: bar chart comparing avg score and conversion rate (smartlead_original vs geolead)
   - By search term: sortable table with count, avg score, conversion rate. Top 5 highlighted

### Interactions

- **Refresh button** — re-fetches `/api/data`
- **CSV export button** — hits `/api/hot-leads.csv`, triggers download
- **Click-to-call** — `tel:` links on phone numbers (mobile-friendly)
- Everything else is read-only

### Tech

- Chart.js from CDN (`https://cdn.jsdelivr.net/npm/chart.js`)
- Vanilla JS, inline CSS
- No build step, no framework

## Daily Email Summary (`scripts/daily-email.js`)

### Transport

Nodemailer with Gmail SMTP:
- Host: `smtp.gmail.com`, port 587, STARTTLS
- Auth: `GMAIL_USER` + `GMAIL_APP_PASSWORD` (Google app password)

### Env Vars

| Var | Purpose |
|-----|---------|
| `GMAIL_USER` | Sender Gmail address (also primary recipient) |
| `GMAIL_APP_PASSWORD` | 16-character Google app password |
| `BRYCE_EMAIL` | CC'd only when hot leads exist |
| `VPS_URL` | Dashboard URL for email footer link (e.g., `http://123.45.67.89:7777`) |

### Recipient Logic

- **To:** `GMAIL_USER` (always)
- **CC:** `BRYCE_EMAIL` (only when `hotLeads.length > 0`)

### Subject Line

```
OMG Outreach Daily — Mar 24 | 3 replies, 12 new leads
```

### Email Body

Mobile-friendly HTML, inline CSS, max-width 600px, system font stack, no images.

**Sections:**

1. **Pipeline Snapshot** — One line per stage, counts only:
   ```
   Raw: 17,901 → Filtered: 14,052 → Classified: 8,958 → Validated: 8,200 → Uploaded: 7,800 → In Campaign: 7,500
   ```

2. **Campaign Performance (since last sync)** — Small table: sent, opened, replied, bounced deltas per active campaign

3. **Hot Leads for Bryce** — Card-style blocks per replied lead: company name, phone (`tel:` link), first 150 chars of reply text. If no replies: "No new replies today."

4. **Score Distribution Change** — One-liner: "Mean score shifted from 42→44 (+2). 6 new leads scored above 80." Omitted if no meaningful delta.

5. **Action Items** — Auto-generated bullets:
   - "5 hot leads ready for Wavv import" (if hot leads exist)
   - "12 leads sitting unprocessed in classified for 3+ days" (if freshness issues)
   - "Pipeline healthy, no action needed" (if nothing to flag)

6. **Footer** — "View full dashboard: [VPS_URL]" link

### Module Interface

```javascript
const { sendDailyEmail } = require('./daily-email');
await sendDailyEmail(dashboardData); // accepts parsed dashboard-data.json
```

Standalone test: `node scripts/daily-email.js --test` sends to `GMAIL_USER` only with current data.

## Integration with `daily-sync.js`

Two new steps appended after SmartLead sync completes:

```javascript
// ... existing sync steps ...

// Step N+1: Refresh dashboard data
const { refresh } = require('./refresh-dashboard');
const dashboardData = await refresh();

// Step N+2: Send daily email
const { sendDailyEmail } = require('./daily-email');
await sendDailyEmail(dashboardData);
```

**Deprecation:** Remove `update-dashboards.js` call from daily-sync (if present). Keep script and HTML files in repo, stop running them.

**Error handling:** Both steps are non-fatal. If refresh or email fails, log the error and continue. Don't break the sync pipeline.

## New Dependencies

| Package | Purpose |
|---------|---------|
| `express` | Dashboard web server |
| `express-basic-auth` | HTTP basic auth middleware |
| `nodemailer` | Gmail SMTP email sending |

No Python dependencies. No build step.

## New Env Vars Summary

| Variable | Purpose | Default |
|----------|---------|---------|
| `DASHBOARD_PORT` | Dashboard server port | `7777` |
| `DASHBOARD_USER` | Basic auth username | `admin` |
| `DASHBOARD_PASS` | Basic auth password | *(required)* |
| `GMAIL_USER` | Gmail address (sender + recipient) | *(required for email)* |
| `GMAIL_APP_PASSWORD` | Google app password | *(required for email)* |
| `BRYCE_EMAIL` | CC'd when hot leads exist | *(optional)* |
| `VPS_URL` | Dashboard URL for email footer | *(required for email)* |

## File Summary

| File | New/Modified | Purpose |
|------|-------------|---------|
| `scripts/refresh-dashboard.js` | New | Reads all sources, writes `dashboard-data.json` |
| `scripts/dashboard-server.js` | New | Express server, port 7777, basic auth |
| `data/artifacts/dashboard.html` | New | Self-contained Chart.js dashboard |
| `scripts/daily-email.js` | New | Builds and sends daily HTML email via Nodemailer |
| `scripts/daily-sync.js` | Modified | Adds refresh + email steps, removes old dashboard update |
| `package.json` | Modified | Adds express, express-basic-auth, nodemailer deps |
| `.env.example` | Modified | Adds new env vars |
