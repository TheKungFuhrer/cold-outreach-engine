"""
Classify leads as wedding/event venues using Anthropic Batch API.
Uses Claude Haiku for 50% cost savings via batch processing.

Input:  data/filtered/leads.csv (or --input <file>)
Output: data/classified/venues.csv, non_venues.csv, ambiguous.csv, results.csv
"""

import argparse
import csv
import json
import os
import sys
import time
from pathlib import Path

from anthropic import Anthropic
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "shared"))
from fields import resolve_field
load_dotenv(PROJECT_ROOT / ".env")

API_KEY = os.getenv("ANTHROPIC_API_KEY_BATCH")
if not API_KEY:
    print("Error: ANTHROPIC_API_KEY_BATCH not set in .env")
    sys.exit(1)

client = Anthropic(api_key=API_KEY)

MODEL = "claude-haiku-4-5-20251001"
CONFIDENCE_THRESHOLD = 0.7
BATCH_SIZE = 1000

SYSTEM_PROMPT = """You are classifying businesses for a wedding and event venue outreach list.
Given a business name, email, and optional website URL, determine if this business is a wedding or event venue that hosts events and takes bookings.

Respond with ONLY a JSON object (no markdown, no explanation outside the JSON):
{
  "is_venue": true/false,
  "confidence": 0.0-1.0,
  "reasoning": "Brief one-sentence explanation"
}

A venue is a place that:
- Hosts weddings, receptions, corporate events, parties, or similar gatherings
- Has a physical space available for rent/booking
- Examples: banquet halls, wedding barns, hotels with event space, country clubs, estates, conference centers, rooftop venues, gardens/estates for hire

NOT a venue:
- Event planning/coordination companies (they plan, don't host)
- Catering companies, DJs, photographers, florists
- Restaurants (unless they clearly have private event space)
- Government buildings, parks, schools
- Generic businesses unrelated to events"""


def build_request(lead, index):
    name = resolve_field(lead, "companyName")
    email = resolve_field(lead, "email")
    website = resolve_field(lead, "website")

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
        return {"is_venue": False, "confidence": 0.0, "reasoning": "Parse error"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default=str(PROJECT_ROOT / "data" / "filtered" / "leads.csv"))
    parser.add_argument("--output-dir", default=str(PROJECT_ROOT / "data" / "classified"))
    args = parser.parse_args()

    input_file = Path(args.input)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if not input_file.exists():
        print(f"No input file: {input_file}")
        print("Run the pre-filter first: node 2-enrichment/prefilter.js")
        sys.exit(1)

    with open(input_file, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        leads = list(reader)
        fieldnames = reader.fieldnames

    print(f"Loaded {len(leads)} leads for classification")

    all_requests = [build_request(lead, i) for i, lead in enumerate(leads)]
    all_results = {}

    for chunk_start in range(0, len(all_requests), BATCH_SIZE):
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
                    "is_venue": False,
                    "confidence": 0.0,
                    "reasoning": f"Batch error: {result.result.type}",
                }
            all_results[custom_id] = classification

    venues = []
    non_venues = []
    ambiguous = []
    out_fields = fieldnames + ["is_venue", "confidence", "reasoning"]

    for i, lead in enumerate(leads):
        custom_id = f"lead-{i}"
        result = all_results.get(
            custom_id,
            {"is_venue": False, "confidence": 0.0, "reasoning": "No result"},
        )
        row = {**lead, **result}

        if result["confidence"] < CONFIDENCE_THRESHOLD:
            ambiguous.append(row)
        elif result["is_venue"]:
            venues.append(row)
        else:
            non_venues.append(row)

    def write_csv(filepath, rows, fields):
        with open(filepath, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)

    write_csv(output_dir / "venues.csv", venues, out_fields)
    write_csv(output_dir / "non_venues.csv", non_venues, out_fields)
    write_csv(output_dir / "ambiguous.csv", ambiguous, out_fields)
    write_csv(output_dir / "results.csv", venues + non_venues + ambiguous, out_fields)

    print(f"\n--- Classification Summary ---")
    print(f"Total classified:  {len(leads)}")
    print(f"Confirmed venues:  {len(venues)}")
    print(f"Non-venues:        {len(non_venues)}")
    print(f"Ambiguous (-> Sonnet): {len(ambiguous)}")
    print(f"\nResults saved to {output_dir}/")


if __name__ == "__main__":
    main()
