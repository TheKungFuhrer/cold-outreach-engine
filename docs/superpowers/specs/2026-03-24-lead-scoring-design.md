# Lead Scoring Module Design

## Purpose

Rank confirmed venue leads by likelihood to convert to the OMG Rentals Intensive coaching program (~$9,800). Produces a scored CSV sorted by score descending so setter Bryce can work his Wavv dialer list top-down, calling the highest-value prospects first.

## Approach

Weighted points system. Each lead signal contributes a fixed number of points. Points sum to a raw total capped at 100. Weights live in a separate config file for easy tuning without touching scoring logic.

## Scoring Rubric

### Engagement Signals (max +35)

Engagement data is only available for leads that have been uploaded to SmartLead campaigns. For the first scoring pass, most leads will score 0 on engagement. As leads enter campaigns and accumulate opens/clicks/replies, re-running the scorer picks up this data and re-ranks accordingly.

Engagement data is joined from SmartLead campaign CSV exports in `data/raw/` (matching by email). If no engagement data is found for a lead, all engagement signals default to 0.

| Signal | Points | Rationale |
|--------|--------|-----------|
| Reply (reply_count > 0) | +20 | Strongest signal — responded to cold outreach |
| Click (click_count > 0) | +10 | Visited a link, showed active interest |
| Repeated opens (open_count >= 3) | +5 | Curiosity beyond a single glance |

### Phone Type (max +15)

| Signal | Points | Rationale |
|--------|--------|-----------|
| Mobile | +15 | Direct line to decision maker, best for dialer |
| VOIP | +5 | Reachable but less personal |
| Landline | +2 | Front desk, harder to reach owner |
| None / Invalid | 0 | No phone signal |

### Website Presence (max +10)

Social-media-only and has-website are **mutually exclusive**. If `_social_media_flag` is set, award +3. If website is present and not flagged as social-media-only, award +10. If no website, award 0.

| Signal | Points | Rationale |
|--------|--------|-----------|
| Has website (not social-only) | +10 | Established business |
| Social-media-only URL | +3 | Online presence but no real site |
| No website | 0 | — |

### Venue Category (max +12)

Determined by keyword matching against `company_name` (primary method). If `_source_query` field is present in the input CSV, it is checked first as it contains the GeoLead search term (e.g., "banquet hall") which is a reliable category signal. Falls back to `company_name` keyword matching when `_source_query` is absent (which it will be for the original SmartLead batch).

**Keyword matching rules:** Match keywords as whole words (case-insensitive) against `company_name` or `_source_query`. First matching tier wins. Keywords are checked in order: primary first, then strong adjacent, then weak adjacent.

| Signal | Points | Keywords |
|--------|--------|----------|
| Primary venue | +12 | event venue, banquet hall, wedding venue, reception hall, event center, conference center, event space, ballroom |
| Strong adjacent | +8 | winery, vineyard, estate, resort, country club, golf club, mansion, lodge, barn, chateau, pavilion, inn, bed and breakfast, B&B |
| Weak adjacent | +3 | restaurant, hotel, brewery, farm, museum, garden, botanical, amphitheater, yacht club, social club |
| Unknown / no match | 0 | — |

### Metro Market Tier (max +12)

Static lookup table structured as `{ state: { city: tier } }` mapping individual cities (including suburbs) to their metro tier. Uses existing `parseLocation()` from `shared/fields.js` to extract city and state from the location field.

The lookup maps individual cities — not metro area names. For example, Frisco TX, Plano TX, and Arlington TX all map to Tier 1 (Dallas-Fort Worth metro). The config file includes the primary city plus ~5-10 major suburbs per Tier 1 metro.

| Signal | Points | Rationale |
|--------|--------|-----------|
| Tier 1 — top ~30 US metros (1M+ population) | +12 | Larger market = more events = more revenue |
| Tier 2 — next ~50 US metros (500K-1M) | +7 | Solid mid-size market |
| Tier 3 / Rural / unmatched | +2 | Still viable but smaller market |

### Email Contact Depth (max +8)

Count of unique emails per domain from the master enriched email list. For each row in `data/upload/master_enriched_emails.csv`, normalize the `website` field using `normalizeDomain()` from `shared/dedup.js`. Group by normalized domain and count unique email addresses per domain.

| Signal | Points | Rationale |
|--------|--------|-----------|
| 3+ email contacts | +8 | Established business with staff |
| 1-2 email contacts | +4 | Has contacts on file |
| 0 email contacts | 0 | — |

### Chain Detection (range: -10 to +5)

Static blocklist of ~50-100 known chain names plus pattern matching for franchise indicators.

**Matching rules:**
- Blocklist names are matched as **whole words** (case-insensitive) against `company_name`. "Marriott Ranch" would match "Marriott" — this is acceptable; false positives at this scale are low-cost (a few points lost) vs. missing actual chains.
- The "by [ChainName]" pattern matches only against blocklisted chain names specifically (e.g., "Courtyard by Marriott" matches, "The Estate by the Lake" does not).
- Location numbering patterns (`#\d+`, `Unit \d+`, `Location \d+`, `Store \d+`) are matched independently as franchise indicators.

| Signal | Points | Rationale |
|--------|--------|-----------|
| Likely independent (no chain match) | +5 | Independent owners are the Intensive buyer |
| Likely chain (blocklist or pattern match) | -10 | Chains don't buy coaching |

### Score Range

- **Theoretical max:** ~100 (reply + mobile + website + primary venue + tier 1 + 3+ emails + independent = 20+15+10+12+12+8+5 = 82, with click and opens stacking to 97)
- **Raw sum capped at 100.** No normalization needed since the weight budget fits the 1-100 range naturally.
- **Minimum score:** 1 (floor — every confirmed venue gets at least 1)
- **Expected first-pass distribution:** Without engagement data, most leads will fall in the 15-55 range. This is expected. The distribution shifts upward as leads enter campaigns and engagement signals activate. The console summary reflects actual distribution, not an idealized target.

## Data Flow

### Input

**Primary:** Most recent `data/final/clean_venues_*.csv` (or specified via `--input` flag).

Fields used directly from clean venues CSV: `company_name`, `website`, `location`, `phone_number`, `_social_media_flag`, `_source_query` (if present).

### Joined Data

1. **Phone type** — Read all five phone-validated segment files (`data/phone_validated/{mobile,voip,landline,invalid,no_phone}.csv`). Build a lookup map keyed by **email address**. If a lead's email appears in `mobile.csv`, it gets mobile type. Precedence if a lead appears in multiple files: mobile > voip > landline > invalid > no_phone.
2. **Email count** — Read `data/upload/master_enriched_emails.csv`. Normalize the `website` field using `normalizeDomain()` from `shared/dedup.js`. Group by normalized domain, count unique emails per domain.
3. **Engagement** — Read most recent SmartLead campaign export from `data/raw/` (matching by email). Extract `open_count`, `click_count`, `reply_count`. Defaults to 0 for all if no campaign export found or lead not in any campaign.
4. **Source query** — Use `_source_query` from input CSV if present. Otherwise, fall back to keyword matching against `company_name` using the category keyword lists in the config.

### Output

`data/scored/scored_venues_<timestamp>.csv`

Same columns as the input clean venues CSV, plus:
- `score` — Integer 1-100

Sorted by `score` descending. Bryce imports this into Wavv and works top-down.

### Console Summary

After scoring, print a distribution summary:
```
Scored 24,044 venues

Score distribution:
  90-100:   203 leads  (0.8%)
  70-89:  2,405 leads (10.0%)
  50-69:  5,530 leads (23.0%)
  30-49:  9,614 leads (40.0%)
  1-29:   6,292 leads (26.2%)

Top 10 leads:
  1. Willowdale Estate (Austin, TX) — 82
  2. ...
```

## Module Structure

### New Files

- **`2-enrichment/score_leads.js`** — Main scorer module. Reads inputs, joins data, applies weights, writes scored CSV.
- **`2-enrichment/scoring-config.js`** — Exported config object containing:
  - Weight values for each signal
  - Category keyword lists (primary venue, strong adjacent, weak adjacent)
  - Chain blocklist and franchise pattern regexes
  - Metro tier lookup table (`{ state: { city: tier } }` with suburbs)

### Dependencies (existing, no new packages)

- `shared/csv.js` — CSV read/write
- `shared/fields.js` — `parseLocation()`, field normalization
- `shared/dedup.js` — `normalizeDomain()` for email count join
- `shared/utils.js` — paths, timestamps, mkdir

### Integration

- **No changes to existing files.** The scorer is purely additive.
- Can be added to `pipeline.js` as a step after `export_clean.js`.
- Can be added to `scripts/update-dashboards.js` for score distribution stats.

### CLI Usage

```bash
node 2-enrichment/score_leads.js [--input <file>] [--output-dir <dir>]

# Defaults:
#   --input: most recent data/final/clean_venues_*.csv
#   --output-dir: data/scored/
```

## Chain Detection Details

### Static Blocklist (partial — full list in scoring-config.js)

Hotels/Resorts: Marriott, Hilton, Holiday Inn, Hampton Inn, Best Western, Hyatt, Sheraton, Westin, Radisson, Wyndham, IHG, Crowne Plaza, DoubleTree, Embassy Suites, Fairfield Inn, Courtyard, Residence Inn, SpringHill Suites, La Quinta, Comfort Inn, Quality Inn, Days Inn, Super 8, Motel 6, Four Seasons, Ritz-Carlton, W Hotels

Restaurants/Chains: Olive Garden, Red Lobster, Applebee's, Chili's, TGI Friday's, Outback, Ruth's Chris, The Capital Grille, Morton's, Maggiano's, Dave & Buster's, Topgolf

Event Chains: Bowlero, Main Event, Chuck E. Cheese

### Franchise Patterns

- "by [ChainName]" — only matches blocklisted chain names (e.g., "Courtyard by Marriott" matches, "Estate by the Lake" does not)
- "a [ChainName] property/hotel/resort"
- Location numbering: `#\d+`, `Unit \d+`, `Location \d+`, `Store \d+` (matched as word boundaries)

## Metro Tier Lookup (sample — full list in scoring-config.js)

Structure: `{ "TX": { "Dallas": 1, "Fort Worth": 1, "Arlington": 1, "Plano": 1, "Frisco": 1, ... }, ... }`

### Tier 1 (1M+ metro population, +12 points)

New York, Los Angeles, Chicago, Dallas-Fort Worth, Houston, Washington DC, Philadelphia, Miami, Atlanta, Boston, Phoenix, San Francisco, Seattle, Minneapolis, San Diego, Denver, Tampa, St. Louis, Baltimore, Orlando, Charlotte, San Antonio, Portland, Sacramento, Pittsburgh, Austin, Las Vegas, Nashville, Cincinnati, Kansas City

Each entry includes the primary city plus ~5-10 major suburbs.

### Tier 2 (500K-1M metro population, +7 points)

Indianapolis, Columbus, Jacksonville, San Jose, Memphis, Oklahoma City, Louisville, Richmond, Milwaukee, Raleigh, Hartford, New Orleans, Salt Lake City, Birmingham, Buffalo, Rochester, Grand Rapids, Tucson, Tulsa, Fresno, Bridgeport, El Paso, Omaha, Albuquerque, Knoxville, Bakersfield, McAllen, Baton Rouge, Dayton, Charleston SC, Greenville SC, Honolulu, Sarasota, Cape Coral, Stockton, Colorado Springs, Lakeland, Boise, Des Moines, Spokane, Provo, Chattanooga, Ogden, Madison, Winston-Salem, Deltona, Wichita, Palm Bay, Little Rock

Tier 2 entries map primary city name only (no suburb expansion needed for mid-size metros).
