/**
 * Lead Scoring Configuration
 *
 * Tunable parameters for scoring venue leads across engagement,
 * phone type, website presence, category, metro tier, email depth,
 * and chain detection.
 */

// ---------------------------------------------------------------------------
// 1. Scoring weights
// ---------------------------------------------------------------------------
const WEIGHTS = {
  engagement: { reply: 20, click: 10, repeatedOpens: 5, openThreshold: 3 },
  phone: { mobile: 15, voip: 5, landline: 2, none: 0 },
  website: { hasWebsite: 10, socialOnly: 3, none: 0 },
  category: { primary: 12, strongAdjacent: 8, weakAdjacent: 3, unknown: 0 },
  metro: { tier1: 12, tier2: 7, tier3: 2 },
  emailDepth: { threeOrMore: 8, oneOrTwo: 4, none: 0, thresholdHigh: 3 },
  chain: { independent: 5, chain: -10 },
};

// ---------------------------------------------------------------------------
// 2. Category keywords (three tiers)
// ---------------------------------------------------------------------------
const CATEGORY_KEYWORDS = {
  primary: [
    'event venue', 'banquet hall', 'wedding venue', 'reception hall',
    'event center', 'conference center', 'event space', 'ballroom',
  ],
  strongAdjacent: [
    'winery', 'vineyard', 'estate', 'resort', 'country club', 'golf club',
    'mansion', 'lodge', 'barn', 'chateau', 'pavilion', 'inn',
    'bed and breakfast', 'b&b',
  ],
  weakAdjacent: [
    'restaurant', 'hotel', 'brewery', 'farm', 'museum', 'garden',
    'botanical', 'amphitheater', 'yacht club', 'social club',
  ],
};

// ---------------------------------------------------------------------------
// 3. Chain blocklist (~43 lowercase names)
// ---------------------------------------------------------------------------
const CHAIN_BLOCKLIST = [
  // Hotels
  'marriott', 'hilton', 'holiday inn', 'hampton inn', 'best western',
  'hyatt', 'sheraton', 'westin', 'radisson', 'wyndham', 'ihg',
  'crowne plaza', 'doubletree', 'embassy suites', 'fairfield inn',
  'courtyard', 'residence inn', 'springhill suites', 'la quinta',
  'comfort inn', 'quality inn', 'days inn', 'super 8', 'motel 6',
  'four seasons', 'ritz-carlton', 'ritz carlton', 'w hotel',
  'homewood suites', 'home2 suites', 'tru by hilton', 'canopy by hilton',
  'aloft', 'element by westin', 'ac hotel', 'le meridien', 'st regis',
  'jw marriott', 'autograph collection',
  // Restaurants
  'olive garden', 'red lobster', 'applebees', "applebee's", 'chilis',
  "chili's", 'tgi fridays', "tgi friday's", 'outback steakhouse', 'outback',
  "ruths chris", "ruth's chris", 'capital grille', 'the capital grille',
  'mortons', "morton's", 'maggianos', "maggiano's", 'dave and busters',
  "dave & buster's", 'topgolf',
  // Event
  'bowlero', 'main event', 'chuck e cheese', 'chuck e. cheese',
];

// ---------------------------------------------------------------------------
// 4. Chain regex patterns (franchise indicators)
// ---------------------------------------------------------------------------
const CHAIN_PATTERNS = [
  /\b#\d+\b/,
  /\bunit\s+\d+\b/i,
  /\blocation\s+\d+\b/i,
  /\bstore\s+\d+\b/i,
];

// ---------------------------------------------------------------------------
// 5. isChain(name) — check company name against blocklist + patterns
// ---------------------------------------------------------------------------
function isChain(name) {
  if (!name) return false;
  const lower = name.toLowerCase();

  // Check blocklist using whole-word boundaries
  for (const chain of CHAIN_BLOCKLIST) {
    const escaped = chain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(lower)) return true;
  }

  // Check "a [ChainName] property/hotel/resort" pattern
  for (const chain of CHAIN_BLOCKLIST) {
    const escaped = chain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\ba\\s+${escaped}\\s+(property|hotel|resort)\\b`, 'i');
    if (re.test(lower)) return true;
  }

  // Check generic franchise patterns (location numbering)
  for (const pattern of CHAIN_PATTERNS) {
    if (pattern.test(name)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// 6. Metro tiers  { STATE: { City: tier } }
// ---------------------------------------------------------------------------
const METRO_TIERS = {
  // --- Tier 1 metros with suburbs ---
  NY: {
    'New York': 1, 'Brooklyn': 1, 'Queens': 1, 'Bronx': 1,
    'Staten Island': 1, 'Yonkers': 1, 'White Plains': 1, 'New Rochelle': 1,
    // Tier 2
    'Buffalo': 2, 'Rochester': 2,
  },
  CA: {
    // LA metro
    'Los Angeles': 1, 'Long Beach': 1, 'Pasadena': 1, 'Glendale': 1,
    'Santa Monica': 1, 'Burbank': 1, 'Torrance': 1, 'Anaheim': 1, 'Irvine': 1,
    // SF Bay Area
    'San Francisco': 1, 'Oakland': 1, 'San Jose': 1, 'Berkeley': 1,
    'Fremont': 1, 'Hayward': 1, 'Sunnyvale': 1, 'Santa Clara': 1, 'Palo Alto': 1,
    // San Diego
    'San Diego': 1, 'Chula Vista': 1, 'Carlsbad': 1, 'Oceanside': 1, 'Escondido': 1,
    // Sacramento
    'Sacramento': 1, 'Elk Grove': 1, 'Roseville': 1, 'Folsom': 1,
    // Tier 2
    'Fresno': 2, 'Bakersfield': 2, 'Stockton': 2,
  },
  IL: {
    'Chicago': 1, 'Aurora': 1, 'Naperville': 1, 'Evanston': 1,
    'Schaumburg': 1, 'Joliet': 1, 'Elgin': 1, 'Arlington Heights': 1,
  },
  TX: {
    // Dallas-Fort Worth
    'Dallas': 1, 'Fort Worth': 1, 'Arlington': 1, 'Plano': 1, 'Frisco': 1,
    'McKinney': 1, 'Irving': 1, 'Grand Prairie': 1, 'Denton': 1,
    // Houston
    'Houston': 1, 'Sugar Land': 1, 'Pearland': 1, 'The Woodlands': 1,
    'Katy': 1, 'Pasadena': 1, 'League City': 1,
    // San Antonio
    'San Antonio': 1, 'New Braunfels': 1,
    // Austin
    'Austin': 1, 'Round Rock': 1, 'Cedar Park': 1, 'Georgetown': 1, 'Pflugerville': 1,
    // Tier 2
    'El Paso': 2, 'McAllen': 2,
  },
  DC: {
    'Washington': 1,
  },
  VA: {
    'Alexandria': 1, 'Arlington': 1, 'Fairfax': 1, 'Reston': 1,
    'McLean': 1, 'Tysons': 1,
    'Richmond': 2,
  },
  MD: {
    'Baltimore': 1, 'Bethesda': 1, 'Silver Spring': 1, 'Rockville': 1,
    'Columbia': 1, 'Annapolis': 1,
  },
  PA: {
    'Philadelphia': 1, 'King of Prussia': 1, 'Pittsburgh': 1,
  },
  FL: {
    // Miami
    'Miami': 1, 'Fort Lauderdale': 1, 'West Palm Beach': 1, 'Boca Raton': 1,
    'Coral Gables': 1, 'Hialeah': 1,
    // Tampa
    'Tampa': 1, 'St. Petersburg': 1, 'Clearwater': 1, 'Brandon': 1,
    // Orlando
    'Orlando': 1, 'Kissimmee': 1, 'Winter Park': 1, 'Lake Mary': 1,
    // Tier 2
    'Jacksonville': 2, 'Sarasota': 2, 'Cape Coral': 2, 'Fort Myers': 2,
    'Lakeland': 2, 'Deltona': 2, 'Palm Bay': 2,
  },
  GA: {
    'Atlanta': 1, 'Marietta': 1, 'Roswell': 1, 'Sandy Springs': 1,
    'Alpharetta': 1, 'Decatur': 1, 'Kennesaw': 1,
  },
  MA: {
    'Boston': 1, 'Cambridge': 1, 'Brookline': 1, 'Somerville': 1,
    'Quincy': 1, 'Newton': 1, 'Worcester': 1,
  },
  AZ: {
    'Phoenix': 1, 'Scottsdale': 1, 'Mesa': 1, 'Tempe': 1,
    'Chandler': 1, 'Gilbert': 1, 'Glendale': 1,
    'Tucson': 2,
  },
  WA: {
    'Seattle': 1, 'Bellevue': 1, 'Tacoma': 1, 'Redmond': 1,
    'Kirkland': 1, 'Everett': 1,
    'Spokane': 2,
  },
  MN: {
    'Minneapolis': 1, 'St. Paul': 1, 'Bloomington': 1,
    'Plymouth': 1, 'Eagan': 1, 'Eden Prairie': 1,
  },
  CO: {
    'Denver': 1, 'Aurora': 1, 'Lakewood': 1, 'Arvada': 1,
    'Boulder': 1, 'Centennial': 1,
    'Colorado Springs': 2,
  },
  MO: {
    'St. Louis': 1, 'Clayton': 1, 'Chesterfield': 1,
    'Kansas City': 1, 'Independence': 1, "Lee's Summit": 1,
    'Overland Park': 1, 'Olathe': 1,
  },
  KS: {
    'Overland Park': 1, 'Olathe': 1, 'Kansas City': 1,
    'Wichita': 2,
  },
  OR: {
    'Portland': 1, 'Beaverton': 1, 'Hillsboro': 1,
    'Lake Oswego': 1, 'Tigard': 1,
  },
  NC: {
    'Charlotte': 1, 'Concord': 1, 'Huntersville': 1,
    'Raleigh': 2, 'Durham': 2, 'Winston-Salem': 2,
    'Greensboro': 2, 'Greenville': 2,
  },
  NV: {
    'Las Vegas': 1, 'Henderson': 1, 'North Las Vegas': 1,
    'Reno': 2,
  },
  TN: {
    'Nashville': 1, 'Franklin': 1, 'Murfreesboro': 1, 'Brentwood': 1,
    'Memphis': 2, 'Knoxville': 2, 'Chattanooga': 2,
  },
  OH: {
    'Cincinnati': 1,
    'Columbus': 2, 'Dayton': 2,
  },
  MI: {
    'Detroit': 1, 'Ann Arbor': 1, 'Troy': 1, 'Dearborn': 1,
    'Grand Rapids': 2,
  },
  // --- Tier 2 only states ---
  IN: { 'Indianapolis': 2, 'Carmel': 2, 'Fishers': 2 },
  WI: { 'Milwaukee': 2, 'Madison': 2 },
  LA: { 'New Orleans': 2, 'Metairie': 2, 'Baton Rouge': 2 },
  UT: { 'Salt Lake City': 2, 'Provo': 2, 'Ogden': 2 },
  AL: { 'Birmingham': 2 },
  OK: { 'Oklahoma City': 2, 'Tulsa': 2 },
  KY: { 'Louisville': 2 },
  SC: { 'Charleston': 2, 'Greenville': 2 },
  CT: { 'Hartford': 2, 'Bridgeport': 2 },
  NE: { 'Omaha': 2 },
  NM: { 'Albuquerque': 2 },
  IA: { 'Des Moines': 2 },
  ID: { 'Boise': 2 },
  HI: { 'Honolulu': 2 },
  AR: { 'Little Rock': 2 },
};

// ---------------------------------------------------------------------------
// 7. getMetroTier(city, state) — lookup with case-insensitive fallback
// ---------------------------------------------------------------------------
function getMetroTier(city, state) {
  if (!city || !state) return 3;

  const stateUpper = state.toUpperCase();
  const stateCities = METRO_TIERS[stateUpper];
  if (!stateCities) return 3;

  // Exact match
  if (stateCities[city] !== undefined) return stateCities[city];

  // Case-insensitive fallback
  const cityLower = city.toLowerCase();
  for (const [key, tier] of Object.entries(stateCities)) {
    if (key.toLowerCase() === cityLower) return tier;
  }

  return 3;
}

// ---------------------------------------------------------------------------
// 8. matchesKeywords(text, keywords) — whole-word regex matching
// ---------------------------------------------------------------------------
function matchesKeywords(text, keywords) {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const kw of keywords) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(lower)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 9. matchCategory(sourceQuery, companyName) — two-pass category matching
// ---------------------------------------------------------------------------
function matchCategory(sourceQuery, companyName) {
  const tiers = ['primary', 'strongAdjacent', 'weakAdjacent'];

  // Pass 1: check sourceQuery
  if (sourceQuery) {
    for (const tier of tiers) {
      if (matchesKeywords(sourceQuery, CATEGORY_KEYWORDS[tier])) return tier;
    }
  }

  // Pass 2: check companyName
  if (companyName) {
    for (const tier of tiers) {
      if (matchesKeywords(companyName, CATEGORY_KEYWORDS[tier])) return tier;
    }
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
// 10. Exports
// ---------------------------------------------------------------------------
module.exports = {
  WEIGHTS,
  CATEGORY_KEYWORDS,
  CHAIN_BLOCKLIST,
  CHAIN_PATTERNS,
  METRO_TIERS,
  isChain,
  getMetroTier,
  matchCategory,
};
