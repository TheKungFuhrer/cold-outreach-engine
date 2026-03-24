# Lead Scoring Module Design

## Purpose

Rank confirmed venue leads by likelihood to convert to the OMG Rentals Intensive coaching program (~$9,800). Produces a scored CSV sorted by score descending so setter Bryce can work his Wavv dialer list top-down, calling the highest-value prospects first.

## Approach

Weighted points system. Each lead signal contributes a fixed number of points. Points sum to a raw total capped at 100. Weights live in a separate config file for easy tuning without touching scoring logic.

## Scoring Rubric

### Engagement Signals (max +35)

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

| Signal | Points | Rationale |
|--------|--------|-----------|
| Has website | +10 | Established business |
| Social-media-only URL | +3 | Online presence but no real site |
| No website | 0 | — |

### Venue Category (max +12)

Determined from `_source_query` field (GeoLead search term) or inferred from `company_name` keywords.

| Signal | Points | Rationale |
|--------|--------|-----------|
| Primary venue (event venue, banquet hall, wedding venue, reception hall, event center, conference center) | +12 | Core ICP — dedicated event spaces |
| Strong adjacent (winery, vineyard, estate, resort, country club, golf club, mansion, lodge, barn venue) | +8 | Common venue types that host weddings |
| Weak adjacent (restaurant, hotel, brewery, farm, museum, garden, park pavilion) | +3 | Can host events but not primary business |
| Unknown / no match | 0 | — |

### Metro Market Tier (max +12)

Static lookup table mapping (city, state) pairs to population tiers. Uses existing `parseLocation()` from `shared/fields.js`.

| Signal | Points | Rationale |
|--------|--------|-----------|
| Tier 1 — top ~30 US metros (1M+ population) | +12 | Larger market = more events = more revenue |
| Tier 2 — next ~50 US metros (500K-1M) | +7 | Solid mid-size market |
| Tier 3 / Rural / unmatched | +2 | Still viable but smaller market |

### Email Contact Depth (max +8)

Count of unique emails per domain from the master enriched email list.

| Signal | Points | Rationale |
|--------|--------|-----------|
| 3+ email contacts | +8 | Established business with staff |
| 1-2 email contacts | +4 | Has contacts on file |
| 0 email contacts | 0 | — |

### Chain Detection (range: -10 to +5)

Static blocklist of ~50-100 known chains (Marriott, Hilton, Holiday Inn, etc.) plus pattern matching for franchise indicators ("by Marriott", "a Hilton property", "#4521", "Location 12", "Unit").

| Signal | Points | Rationale |
|--------|--------|-----------|
| Likely independent (no chain match) | +5 | Independent owners are the Intensive buyer |
| Likely chain (blocklist or pattern match) | -10 | Chains don't buy coaching |

### Classification Confidence (max +3)

| Signal | Points | Rationale |
|--------|--------|-----------|
| 0.9+ confidence | +3 | High certainty it's a venue |
| 0.7-0.89 confidence | +1 | Moderate certainty |
| Below 0.7 | 0 | — |

### Score Range

- **Theoretical max:** ~100 (reply + mobile + website + primary venue + tier 1 + 3+ emails + independent + high confidence = 20+15+10+12+12+8+5+3 = 85, with click and opens stacking to 100)
- **Raw sum capped at 100.** No normalization needed since the weight budget is designed to fit the 1-100 range naturally.
- **Minimum score:** 1 (floor — every confirmed venue gets at least 1)

## Data Flow

### Input

**Primary:** Most recent `data/final/clean_venues_*.csv` (or specified via `--input` flag).

Fields used directly: `company_name`, `website`, `location`, `phone_number`, `open_count`, `click_count`, `reply_count`, `confidence` (if retained), `_source_query` (if retained), `_social_media_flag`.

### Joined Data

1. **Phone type** — Read all five phone-validated segment files (`data/phone_validated/{mobile,voip,landline,invalid,no_phone}.csv`). Build a lookup map keyed by normalized domain or email to determine phone line type.
2. **Email count** — Read `data/upload/master_enriched_emails.csv`. Count unique emails per normalized domain.
3. **Source query** — If `_source_query` is present in the input CSV, use it directly. Otherwise, fall back to keyword matching against `company_name`.

### Output

`data/scored/scored_venues_<timestamp>.csv`

Same columns as the input clean venues CSV, plus:
- `score` — Integer 1-100
- `score_tier` — Not included (user preference: just score, sorted descending)

Sorted by `score` descending. Bryce imports this into Wavv and works top-down.

### Console Summary

After scoring, print a distribution summary:
```
Scored 24,044 venues
  90-100: 1,203 leads (5.0%)
  70-89:  4,809 leads (20.0%)
  50-69:  7,213 leads (30.0%)
  30-49:  6,011 leads (25.0%)
  1-29:   4,808 leads (20.0%)
```

## Module Structure

### New Files

- **`2-enrichment/score_leads.js`** — Main scorer module. Reads inputs, joins data, applies weights, writes scored CSV.
- **`2-enrichment/scoring-config.js`** — Exported config object containing:
  - Weight values for each signal
  - Category keyword lists (primary venue, strong adjacent, weak adjacent)
  - Chain blocklist and franchise pattern regexes
  - Metro tier lookup table (city/state → tier)

### Dependencies (existing, no new packages)

- `shared/csv.js` — CSV read/write
- `shared/fields.js` — `parseLocation()`, field normalization
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

- "by [ChainName]" (e.g., "Courtyard by Marriott")
- "a [ChainName] property/hotel/resort"
- Location numbering: "#\d+", "Unit \d+", "Location \d+", "Store \d+"

## Metro Tier Lookup (sample — full list in scoring-config.js)

### Tier 1 (1M+ metro population, +12 points)

New York, Los Angeles, Chicago, Dallas-Fort Worth, Houston, Washington DC, Philadelphia, Miami, Atlanta, Boston, Phoenix, San Francisco, Seattle, Minneapolis, San Diego, Denver, Tampa, St. Louis, Baltimore, Orlando, Charlotte, San Antonio, Portland, Sacramento, Pittsburgh, Austin, Las Vegas, Nashville, Cincinnati, Kansas City

### Tier 2 (500K-1M metro population, +7 points)

Indianapolis, Columbus, Jacksonville, San Jose, Memphis, Oklahoma City, Louisville, Richmond, Milwaukee, Raleigh, Hartford, New Orleans, Salt Lake City, Birmingham, Buffalo, Rochester, Grand Rapids, Tucson, Tulsa, Fresno, Bridgeport, El Paso, Omaha, Albuquerque, Knoxville, Bakersfield, McAllen, Baton Rouge, Dayton, Charleston SC, Greenville SC, Honolulu, Sarasota, Cape Coral, Stockton, Colorado Springs, Lakeland, Boise, Des Moines, Spokane, Provo, Chattanooga, Ogden, Madison, Winston-Salem, Deltona, Wichita, Palm Bay, Little Rock
