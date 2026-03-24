"""
Canonical field name registry and row normalization for Python scripts.

Mirrors shared/fields.js — single source of truth for all CSV column name
variants across SmartLead exports, AnyMailFinder GeoLead CSVs, and internal
pipeline files.
"""

import re

# ---------------------------------------------------------------------------
# Field registry — every known column name variant, grouped by semantic type
# ---------------------------------------------------------------------------

FIELDS = {
    "email": [
        "email", "Email", "email_address", "one_email",
        "decision_maker_email", "company_emails",
    ],
    "firstName": [
        "first_name", "First Name", "decision_maker_name",
    ],
    "lastName": [
        "last_name", "Last Name",
    ],
    "companyName": [
        "company_name", "company", "business_name", "venue_name",
        "name", "Company", "Company Name",
    ],
    "phone": [
        "phone_number", "Phone", "phone",
    ],
    "website": [
        "website", "Website", "company_url", "url",
        "company_website", "company_domain", "domain",
    ],
    "location": [
        "location", "company_location", "Location",
        "city", "state",
    ],
    "category": [
        "category", "lead_category", "Category",
    ],
}

# ---------------------------------------------------------------------------
# resolve_field(row, field_type)
# ---------------------------------------------------------------------------

def resolve_field(row: dict, field_type: str) -> str:
    """Resolve a field value from a row using the canonical registry."""
    candidates = FIELDS.get(field_type)
    if candidates is None:
        raise ValueError(
            f'Unknown field type: "{field_type}". '
            f'Valid types: {", ".join(FIELDS.keys())}'
        )
    for key in candidates:
        val = row.get(key)
        if val is not None and str(val).strip():
            return str(val).strip()
    return ""


# ---------------------------------------------------------------------------
# Name parsing
# ---------------------------------------------------------------------------

_PREFIXES = {
    "mr", "mrs", "ms", "dr", "prof", "sir", "rev", "hon",
    "mr.", "mrs.", "ms.", "dr.", "prof.", "sir.", "rev.", "hon.",
}

_COMPANY_PATTERNS = [
    re.compile(p, re.IGNORECASE)
    for p in [
        r"\bllc\b", r"\binc\.?\b", r"\bcorp\.?\b", r"\bltd\.?\b",
        r"\bco\.?\b", r"\bgroup\b", r"\bventures?\b", r"\bpartners\b",
        r"\bservices?\b", r"\bsolutions?\b", r"\bconsulting\b",
        r"\benterprises?\b", r"\bholdings?\b", r"\bassociates?\b",
        r"\bfoundation\b", r"\borganization\b", r"\bclub\b",
        r"\bestate[s]?\b", r"\bresort\b", r"\bhotel\b", r"\bvenue\b",
        r"\bhall\b", r"\bbanquet\b", r"\bgarden[s]?\b", r"\bcenter\b",
        r"\bmanor\b", r"\blodge\b", r"\bwinery\b", r"\bvineyard\b",
    ]
]


def looks_like_company(name: str) -> bool:
    """Check if a string looks like a company name rather than a person."""
    return any(p.search(name) for p in _COMPANY_PATTERNS)


def parse_name(full_name: str) -> dict:
    """
    Parse a full name string into {"first": ..., "last": ...}.
    Handles honorifics, middle names/initials, single names, empty strings,
    and detects company names accidentally in the name field.
    """
    if not full_name or not isinstance(full_name, str):
        return {"first": "", "last": ""}

    trimmed = full_name.strip()
    if not trimmed:
        return {"first": "", "last": ""}

    if looks_like_company(trimmed):
        return {"first": "", "last": ""}

    parts = trimmed.split()

    # Strip honorific prefix
    if len(parts) > 1 and parts[0].lower() in _PREFIXES:
        parts = parts[1:]

    if not parts:
        return {"first": "", "last": ""}
    if len(parts) == 1:
        return {"first": parts[0], "last": ""}

    return {"first": parts[0], "last": " ".join(parts[1:])}


# ---------------------------------------------------------------------------
# Location parsing
# ---------------------------------------------------------------------------

_CITY_STATE_RE = re.compile(r"([^,]+),\s*([A-Z]{2})(?:\s+\d{5})?$", re.IGNORECASE)
_STATE_ONLY_RE = re.compile(r"^[A-Z]{2}$", re.IGNORECASE)


def parse_location(loc: str) -> dict:
    """Parse a location string into {"city": ..., "state": ...}."""
    if not loc:
        return {"city": "", "state": ""}

    trimmed = loc.strip()

    m = _CITY_STATE_RE.search(trimmed)
    if m:
        return {"city": m.group(1).strip(), "state": m.group(2).upper()}

    parts = [p.strip() for p in trimmed.split(",")]
    if len(parts) >= 2:
        state_zip = parts[-1]
        sm = re.match(r"^([A-Z]{2})(?:\s+\d{5})?$", state_zip, re.IGNORECASE)
        if sm:
            return {"city": parts[-2], "state": sm.group(1).upper()}

    if _STATE_ONLY_RE.match(trimmed):
        return {"city": "", "state": trimmed.upper()}

    return {"city": trimmed, "state": ""}


# ---------------------------------------------------------------------------
# normalize_row(row)
# ---------------------------------------------------------------------------

def normalize_row(row: dict) -> dict:
    """
    Normalize a raw CSV row into a standardized dict with canonical field names.
    """
    email = resolve_field(row, "email").lower()
    website = resolve_field(row, "website")
    phone = resolve_field(row, "phone")
    company_name = resolve_field(row, "companyName")

    first_name = resolve_field(row, "firstName")
    last_name = resolve_field(row, "lastName")

    if first_name and not last_name and " " in first_name:
        parsed = parse_name(first_name)
        first_name = parsed["first"]
        last_name = parsed["last"]

    if first_name and looks_like_company(first_name):
        first_name = ""
        last_name = ""

    raw_location = resolve_field(row, "location")
    loc = parse_location(raw_location)

    return {
        "email": email,
        "firstName": first_name,
        "lastName": last_name,
        "companyName": company_name,
        "phone": phone,
        "website": website,
        "city": loc["city"],
        "state": loc["state"],
        "location": raw_location,
        "source": row.get("source", row.get("_source", "")),
    }
