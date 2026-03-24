/**
 * Canonical field name registry and row normalization.
 *
 * Single source of truth for all CSV column name variants across
 * SmartLead exports, AnyMailFinder GeoLead CSVs, and internal pipeline files.
 */

// ---------------------------------------------------------------------------
// Field registry — every known column name variant, grouped by semantic type
// ---------------------------------------------------------------------------

const FIELDS = {
  email: [
    "email", "Email", "email_address", "one_email",
    "decision_maker_email", "company_emails",
  ],
  firstName: [
    "first_name", "First Name", "decision_maker_name",
  ],
  lastName: [
    "last_name", "Last Name",
  ],
  companyName: [
    "company_name", "company", "business_name", "venue_name",
    "name", "Company", "Company Name",
  ],
  phone: [
    "phone_number", "Phone", "phone",
  ],
  website: [
    "website", "Website", "company_url", "url",
    "company_website", "company_domain", "domain",
  ],
  location: [
    "location", "company_location", "Location",
    "city", "state",
  ],
  category: [
    "category", "lead_category", "Category",
  ],
};

// ---------------------------------------------------------------------------
// resolveField(row, fieldType) — look up a semantic field by type name
// ---------------------------------------------------------------------------

/**
 * Resolve a field value from a row using the canonical registry.
 * @param {Object} row - CSV row object
 * @param {string} fieldType - One of: email, firstName, lastName, companyName, phone, website, location, category
 * @returns {string} First non-empty value found, or ""
 */
function resolveField(row, fieldType) {
  const candidates = FIELDS[fieldType];
  if (!candidates) {
    throw new Error(`Unknown field type: "${fieldType}". Valid types: ${Object.keys(FIELDS).join(", ")}`);
  }
  for (const key of candidates) {
    const val = row[key];
    if (val !== undefined && val !== null && val !== "") return String(val).trim();
  }
  return "";
}

// ---------------------------------------------------------------------------
// Name parsing — splits full names into first/last
// ---------------------------------------------------------------------------

const PREFIXES = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sir", "rev", "hon",
  "mr.", "mrs.", "ms.", "dr.", "prof.", "sir.", "rev.", "hon.",
]);

const SUFFIXES = new Set([
  "jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v",
  "phd", "phd.", "md", "md.", "esq", "esq.", "dds", "dds.",
  "cpa", "cpa.",
]);

/**
 * Parse a full name string into { first, last }.
 * Handles: "John Smith", "Dr. Jane A. Smith-Jones", single names,
 * empty strings, and detects company names in the name field.
 */
function parseName(fullName) {
  if (!fullName || typeof fullName !== "string") return { first: "", last: "" };

  const trimmed = fullName.trim();
  if (!trimmed) return { first: "", last: "" };

  // Likely a company name, not a person — return empty
  if (looksLikeCompany(trimmed)) return { first: "", last: "" };

  const parts = trimmed.split(/\s+/);

  // Strip honorific prefix
  if (parts.length > 1 && PREFIXES.has(parts[0].toLowerCase())) {
    parts.shift();
  }

  // Strip suffix
  if (parts.length > 1 && SUFFIXES.has(parts[parts.length - 1].toLowerCase())) {
    parts.pop();
  }

  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };

  // First token = first name, everything else = last name
  // This handles middle names/initials: "Jane A. Smith-Jones" → first="Jane", last="A. Smith-Jones"
  const first = parts[0];
  const last = parts.slice(1).join(" ");
  return { first, last };
}

const COMPANY_INDICATORS = [
  /\bllc\b/i, /\binc\.?\b/i, /\bcorp\.?\b/i, /\bltd\.?\b/i,
  /\bco\.?\b/i, /\bgroup\b/i, /\bventures?\b/i, /\bpartners\b/i,
  /\bservices?\b/i, /\bsolutions?\b/i, /\bconsulting\b/i,
  /\benterprises?\b/i, /\bholdings?\b/i, /\bassociates?\b/i,
  /\bfoundation\b/i, /\borganization\b/i, /\bclub\b/i,
  /\bestate[s]?\b/i, /\bresort\b/i, /\bhotel\b/i, /\bvenue\b/i,
  /\bhall\b/i, /\bbanquet\b/i, /\bgarden[s]?\b/i, /\bcenter\b/i,
  /\bmanor\b/i, /\blodge\b/i, /\bwinery\b/i, /\bvineyard\b/i,
];

function looksLikeCompany(name) {
  return COMPANY_INDICATORS.some((p) => p.test(name));
}

// ---------------------------------------------------------------------------
// normalizeRow(row) — standardize any CSV row into canonical field names
// ---------------------------------------------------------------------------

/**
 * Normalize a raw CSV row into a standardized object.
 * @param {Object} row - Raw CSV row with any column naming convention
 * @returns {Object} Standardized object with canonical field names
 */
function normalizeRow(row) {
  const email = resolveField(row, "email").toLowerCase();
  const website = resolveField(row, "website");
  const phone = resolveField(row, "phone");
  const companyName = resolveField(row, "companyName");

  // Resolve first/last name — try dedicated fields first, fall back to parsing
  let firstName = resolveField(row, "firstName");
  let lastName = resolveField(row, "lastName");

  // If firstName looks like a full name (contains space) and lastName is empty, split it
  if (firstName && !lastName && firstName.includes(" ")) {
    const parsed = parseName(firstName);
    firstName = parsed.first;
    lastName = parsed.last;
  }

  // If firstName is empty, nothing to parse
  // If firstName looks like a company name, clear it
  if (firstName && looksLikeCompany(firstName)) {
    firstName = "";
    lastName = "";
  }

  // Parse location into city/state if possible
  const rawLocation = resolveField(row, "location");
  const { city, state } = parseLocation(rawLocation);

  return {
    email,
    firstName,
    lastName,
    companyName,
    phone,
    website,
    city,
    state,
    location: rawLocation,
    source: row.source || row._source || "",
  };
}

/**
 * Parse a location string into city and state.
 * Handles: "Austin, TX", "123 Main St, Austin, TX 78701", "CA", etc.
 */
function parseLocation(loc) {
  if (!loc) return { city: "", state: "" };

  const trimmed = loc.trim();
  // Try "City, ST" or "City, ST ZIP"
  const match = trimmed.match(/([^,]+),\s*([A-Z]{2})(?:\s+\d{5})?$/i);
  if (match) {
    return { city: match[1].trim(), state: match[2].toUpperCase() };
  }

  // Try "City, State, ..." from longer addresses
  const parts = trimmed.split(",").map((p) => p.trim());
  if (parts.length >= 2) {
    const stateZip = parts[parts.length - 1];
    const stateMatch = stateZip.match(/^([A-Z]{2})(?:\s+\d{5})?$/i);
    if (stateMatch) {
      return { city: parts[parts.length - 2], state: stateMatch[1].toUpperCase() };
    }
  }

  // Just a state code
  if (/^[A-Z]{2}$/i.test(trimmed)) {
    return { city: "", state: trimmed.toUpperCase() };
  }

  return { city: trimmed, state: "" };
}

// ---------------------------------------------------------------------------
// parseLocationFull — parses location string into { city, state, zip }
// ---------------------------------------------------------------------------

const STATE_NAMES = {
  "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
  "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
  "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
  "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
  "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
  "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
  "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
  "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT",
  "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV",
  "wisconsin": "WI", "wyoming": "WY",
  "district of columbia": "DC",
  // Territories
  "puerto rico": "PR", "guam": "GU", "virgin islands": "VI",
  "american samoa": "AS", "northern mariana islands": "MP",
};

const STATE_ABBREVS = new Set(Object.values(STATE_NAMES));

/**
 * Parse a location string into { city, state, zip }.
 * Handles full state names, abbreviations, ZIP codes (5-digit and ZIP+4),
 * trailing country names (USA, United States), and extra whitespace.
 * @param {string|null} loc - Location string to parse
 * @returns {{ city: string, state: string, zip: string }}
 */
function parseLocationFull(loc) {
  const empty = { city: "", state: "", zip: "" };
  if (!loc || typeof loc !== "string") return empty;

  // Strip trailing country names (case-insensitive)
  let s = loc.trim().replace(/,?\s*(united states of america|united states|usa|us)\s*$/i, "").trim();
  if (!s) return empty;

  // Extract ZIP code from end (5 digits, optionally followed by -XXXX)
  let zip = "";
  const zipMatch = s.match(/\b(\d{5})(?:-\d{4})?\s*$/);
  if (zipMatch) {
    zip = zipMatch[1];
    s = s.slice(0, zipMatch.index).trim().replace(/,\s*$/, "").trim();
  }

  // Helper: normalize a candidate state token and return abbreviation or ""
  function resolveState(token) {
    const upper = token.trim().toUpperCase();
    if (STATE_ABBREVS.has(upper)) return upper;
    const lower = token.trim().toLowerCase();
    return STATE_NAMES[lower] || "";
  }

  // Try comma-separated pattern: "City, State" or "City, ST"
  const commaIdx = s.lastIndexOf(",");
  if (commaIdx !== -1) {
    const afterComma = s.slice(commaIdx + 1).trim();
    const beforeComma = s.slice(0, commaIdx).trim();
    const stateAbbr = resolveState(afterComma);
    if (stateAbbr) {
      return { city: beforeComma, state: stateAbbr, zip };
    }
  }

  // Try space-separated pattern: "City ST" or "City ST ZIP" (ZIP already stripped above)
  // Look for a 2-letter state code as the last word
  const spaceMatch = s.match(/^(.*?)\s+([A-Za-z]{2})\s*$/);
  if (spaceMatch) {
    const stateAbbr = resolveState(spaceMatch[2]);
    if (stateAbbr) {
      return { city: spaceMatch[1].trim(), state: stateAbbr, zip };
    }
  }

  // Just a state code alone (2 letters)
  if (/^[A-Za-z]{2}$/.test(s)) {
    const stateAbbr = resolveState(s);
    if (stateAbbr) {
      return { city: "", state: stateAbbr, zip };
    }
  }

  // Fallback: treat entire string as city
  return { city: s, state: "", zip };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  FIELDS,
  resolveField,
  normalizeRow,
  parseName,
  parseLocation,
  parseLocationFull,
  looksLikeCompany,
};
