"""
Sub-classify non-venue leads into event_service_provider, venue_adjacent, or irrelevant
using Anthropic Batch API (Haiku).

Auto-combines non-venues from both SmartLead and GeoLead classification runs,
deduplicates by normalized domain, then classifies via batch.

Input:  data/classified/non_venues.csv + data/classified_geolead/non_venues.csv
        (or --input <single file>)
Output: data/classified_services/event_service_providers.csv, venue_adjacent.csv,
        irrelevant.csv, results.csv
"""

import argparse
import csv
import json
import os
import re
import sys
import time
from pathlib import Path

from anthropic import Anthropic
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).parent.parent
load_dotenv(PROJECT_ROOT / ".env")

API_KEY = os.getenv("ANTHROPIC_API_KEY_BATCH")
if not API_KEY:
    print("Error: ANTHROPIC_API_KEY_BATCH not set in .env")
    sys.exit(1)

client = Anthropic(api_key=API_KEY)

MODEL = "claude-haiku-4-5-20251001"
CONFIDENCE_THRESHOLD = 0.7
BATCH_SIZE = 1000

DEFAULT_INPUTS = [
    PROJECT_ROOT / "data" / "classified" / "non_venues.csv",
    PROJECT_ROOT / "data" / "classified_geolead" / "non_venues.csv",
]

SYSTEM_PROMPT = """You are sub-classifying businesses that were previously identified as NOT being event/wedding venues. These businesses appeared in Google Maps searches for "event venue" and "wedding venue" so many are event-adjacent.

Classify each business into exactly one category:

- event_service_provider: Businesses that provide services FOR events but don't host them. Examples: event planners, wedding coordinators, caterers, DJs, photographers, videographers, florists, decorators, rental companies (tables/chairs/tents/linens), lighting companies, entertainment providers, event staffing agencies, bakeries/cake designers, transportation/limo services.

- venue_adjacent: Businesses that COULD host events as a secondary function but weren't classified as dedicated venues. Examples: hotels with event/banquet space, restaurants with private dining rooms, breweries/wineries with event areas, country clubs, community centers, churches with fellowship halls, museums with rental space, parks departments, recreation centers.

- irrelevant: Businesses completely unrelated to the events industry. Examples: plumbing companies, dentists, car dealerships, software companies, retail stores with no event connection.

Respond with ONLY a JSON object (no markdown, no explanation outside the JSON):
{"category": "event_service_provider"|"venue_adjacent"|"irrelevant", "confidence": 0.0-1.0, "reasoning": "Brief one-sentence explanation"}"""


# ---------------------------------------------------------------------------
# Domain normalization (ported from shared/dedup.js)
# ---------------------------------------------------------------------------

def normalize_domain(raw):
    """Normalize a URL/domain for dedup. Matches shared/dedup.js logic."""
    if not raw:
        return ""
    d = raw.strip().lower()
    d = re.sub(r"^https?://", "", d)
    d = re.sub(r"^www\.", "", d)
    d = d.split("/")[0]
    d = d.split("?")[0]
    d = d.split("#")[0]
    d = d.rstrip(".")
    return d


def extract_domain(row):
    """Extract normalized domain from a row, trying multiple field names."""
    raw = (
        row.get("website")
        or row.get("Website")
        or row.get("company_website")
        or row.get("company_domain")
        or row.get("url")
        or ""
    )
    domain = normalize_domain(raw)
    if domain:
        return domain
    # Fallback: extract domain from email
    email = (
        row.get("email")
        or row.get("Email")
        or row.get("one_email")
        or row.get("decision_maker_email")
        or ""
    )
    if "@" in email:
        return email.split("@")[1].strip().lower()
    return ""


def count_non_empty(row):
    """Count non-empty fields in a row (for dedup tie-breaking)."""
    return sum(1 for v in row.values() if v and str(v).strip())


# ---------------------------------------------------------------------------
# Input loading
# ---------------------------------------------------------------------------

def load_and_combine(input_file=None):
    """Load leads from one or two CSVs, dedup by domain, return (leads, fieldnames)."""
    if input_file:
        files = [Path(input_file)]
    else:
        files = [f for f in DEFAULT_INPUTS if f.exists()]
        if not files:
            print("Error: No input files found.")
            print("Expected:")
            for f in DEFAULT_INPUTS:
                print(f"  {f}")
            sys.exit(1)

    all_leads = []
    all_fieldnames = []

    for filepath in files:
        with open(filepath, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
            # Build union of fieldnames preserving order
            for fn in reader.fieldnames:
                if fn not in all_fieldnames:
                    all_fieldnames.append(fn)
            print(f"  Loaded {len(rows):,} leads from {filepath.name}")
            all_leads.extend(rows)

    print(f"  Combined: {len(all_leads):,} total")

    # Dedup by normalized domain — keep row with more data
    seen = {}  # domain → (index, non_empty_count)
    deduped = []
    dupes = 0

    for row in all_leads:
        domain = extract_domain(row)
        if not domain:
            deduped.append(row)  # keep rows with no domain (can't dedup)
            continue
        count = count_non_empty(row)
        if domain in seen:
            existing_idx, existing_count = seen[domain]
            if count > existing_count:
                # Replace with richer row
                deduped[existing_idx] = row
                seen[domain] = (existing_idx, count)
            dupes += 1
        else:
            seen[domain] = (len(deduped), count)
            deduped.append(row)

    print(f"  Duplicates removed: {dupes:,}")
    print(f"  Final lead count: {len(deduped):,}")

    return deduped, all_fieldnames


# ---------------------------------------------------------------------------
# Batch API helpers (same pattern as classify_batch.py)
# ---------------------------------------------------------------------------

def build_request(lead, index):
    name = (
        lead.get("company_name")
        or lead.get("company")
        or lead.get("Company")
        or lead.get("name")
        or ""
    )
    email = (
        lead.get("email")
        or lead.get("Email")
        or lead.get("one_email")
        or lead.get("decision_maker_email")
        or ""
    )
    website = (
        lead.get("website")
        or lead.get("Website")
        or lead.get("url")
        or lead.get("company_domain")
        or lead.get("company_website")
        or ""
    )

    user_msg = f"Business name: {name}\nEmail: {email}"
    if website:
        user_msg += f"\nWebsite: {website}"

    return {
        "custom_id": f"lead-{index}",
        "params": {
            "model": MODEL,
            "max_tokens": 200,
            "system": SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": user_msg}],
        },
    }


def submit_batch(requests):
    print(f"Submitting batch of {len(requests)} requests...")
    batch = client.messages.batches.create(requests=requests)
    print(f"Batch ID: {batch.id} | Status: {batch.processing_status}")
    return batch


def wait_for_batch(batch_id):
    while True:
        batch = client.messages.batches.retrieve(batch_id)
        status = batch.processing_status
        counts = batch.request_counts
        print(
            f"  Status: {status} | "
            f"Succeeded: {counts.succeeded} | "
            f"Failed: {counts.errored} | "
            f"Processing: {counts.processing}"
        )
        if status == "ended":
            return batch
        time.sleep(30)


def parse_result(result_text):
    try:
        return json.loads(result_text)
    except json.JSONDecodeError:
        start = result_text.find("{")
        end = result_text.rfind("}") + 1
        if start >= 0 and end > start:
            return json.loads(result_text[start:end])
        return {"category": "irrelevant", "confidence": 0.0, "reasoning": "Parse error"}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Sub-classify non-venue leads via Anthropic Batch API"
    )
    parser.add_argument(
        "--input",
        default=None,
        help="Single CSV input (skips auto-combine of default files)",
    )
    parser.add_argument(
        "--output-dir",
        default=str(PROJECT_ROOT / "data" / "classified_services"),
    )
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print("=== Non-Venue Sub-Classification ===\n")
    print("Loading input files...")
    leads, fieldnames = load_and_combine(args.input)

    if not leads:
        print("No leads to classify.")
        return

    # Build batch requests
    all_requests = [build_request(lead, i) for i, lead in enumerate(leads)]
    all_results = {}

    print(f"\nClassifying {len(leads):,} leads in batches of {BATCH_SIZE}...\n")

    for chunk_start in range(0, len(all_requests), BATCH_SIZE):
        chunk_num = chunk_start // BATCH_SIZE + 1
        total_chunks = (len(all_requests) + BATCH_SIZE - 1) // BATCH_SIZE
        print(f"--- Batch {chunk_num}/{total_chunks} ---")

        chunk = all_requests[chunk_start : chunk_start + BATCH_SIZE]
        batch = submit_batch(chunk)
        completed = wait_for_batch(batch.id)

        for result in client.messages.batches.results(completed.id):
            custom_id = result.custom_id
            if result.result.type == "succeeded":
                text = result.result.message.content[0].text
                classification = parse_result(text)
            else:
                classification = {
                    "category": "irrelevant",
                    "confidence": 0.0,
                    "reasoning": f"Batch error: {result.result.type}",
                }
            all_results[custom_id] = classification

    # Bucket results
    event_service_providers = []
    venue_adjacent = []
    irrelevant = []
    # Add new fields, avoiding duplicates (confidence/reasoning exist from prior classification)
    new_fields = ["category", "confidence", "reasoning"]
    out_fields = fieldnames + [f for f in new_fields if f not in fieldnames]

    for i, lead in enumerate(leads):
        custom_id = f"lead-{i}"
        result = all_results.get(
            custom_id,
            {"category": "irrelevant", "confidence": 0.0, "reasoning": "No result"},
        )
        row = {**lead, **result}

        if result["confidence"] < CONFIDENCE_THRESHOLD:
            irrelevant.append(row)
        elif result["category"] == "event_service_provider":
            event_service_providers.append(row)
        elif result["category"] == "venue_adjacent":
            venue_adjacent.append(row)
        else:
            irrelevant.append(row)

    # Write output CSVs
    def write_csv(filepath, rows, fields):
        with open(filepath, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)

    write_csv(output_dir / "event_service_providers.csv", event_service_providers, out_fields)
    write_csv(output_dir / "venue_adjacent.csv", venue_adjacent, out_fields)
    write_csv(output_dir / "irrelevant.csv", irrelevant, out_fields)
    write_csv(
        output_dir / "results.csv",
        event_service_providers + venue_adjacent + irrelevant,
        out_fields,
    )

    print(f"\n--- Sub-Classification Summary ---")
    print(f"Total classified:        {len(leads):,}")
    print(f"Event service providers:  {len(event_service_providers):,}")
    print(f"Venue-adjacent:           {len(venue_adjacent):,}")
    print(f"Irrelevant:               {len(irrelevant):,}")
    print(f"\nResults saved to {output_dir}/")


if __name__ == "__main__":
    main()
