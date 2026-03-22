"""
Escalate ambiguous leads to Sonnet for higher-confidence classification.

Input:  data/classified/ambiguous.csv (or --input <file>)
Output: data/verified/venues.csv, non_venues.csv, results.csv
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
load_dotenv(PROJECT_ROOT / ".env")

API_KEY = os.getenv("ANTHROPIC_API_KEY_BATCH")
if not API_KEY:
    print("Error: ANTHROPIC_API_KEY_BATCH not set in .env")
    sys.exit(1)

client = Anthropic(api_key=API_KEY)

MODEL = "claude-sonnet-4-6"
BATCH_SIZE = 500

SYSTEM_PROMPT = """You are an expert at identifying wedding and event venues.
You are reviewing leads that were ambiguous in initial screening.
Be thorough: consider the business name, email domain, and website URL carefully.

A venue is a physical location that hosts weddings, receptions, corporate events, parties, or similar gatherings and takes bookings.

Respond with ONLY a JSON object:
{
  "is_venue": true/false,
  "confidence": 0.0-1.0,
  "reasoning": "Detailed explanation of your classification"
}"""


def build_request(lead, index):
    name = lead.get("company_name") or lead.get("company") or lead.get("Company") or lead.get("name") or ""
    email = lead.get("email") or lead.get("Email") or ""
    website = lead.get("website") or lead.get("Website") or lead.get("url") or ""
    prev_reasoning = lead.get("reasoning", "")

    user_msg = f"""Business name: {name}
Email: {email}
Website: {website}

Previous classification attempt was ambiguous with reasoning: "{prev_reasoning}"
Please provide a definitive classification."""

    return {
        "custom_id": f"escalate-{index}",
        "params": {
            "model": MODEL,
            "max_tokens": 300,
            "system": SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": user_msg}],
        },
    }


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
    parser.add_argument("--input", default=str(PROJECT_ROOT / "data" / "classified" / "ambiguous.csv"))
    parser.add_argument("--output-dir", default=str(PROJECT_ROOT / "data" / "verified"))
    args = parser.parse_args()

    input_file = Path(args.input)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if not input_file.exists():
        print(f"No ambiguous leads file: {input_file}")
        print("Run classify_batch.py first.")
        sys.exit(1)

    with open(input_file, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        leads = list(reader)
        fieldnames = reader.fieldnames

    if not leads:
        print("No ambiguous leads to escalate.")
        return

    print(f"Escalating {len(leads)} ambiguous leads to Sonnet...")

    all_requests = [build_request(lead, i) for i, lead in enumerate(leads)]
    all_results = {}

    for chunk_start in range(0, len(all_requests), BATCH_SIZE):
        chunk = all_requests[chunk_start : chunk_start + BATCH_SIZE]
        print(f"Submitting batch of {len(chunk)} requests...")
        batch = client.messages.batches.create(requests=chunk)
        print(f"Batch ID: {batch.id}")

        while True:
            batch = client.messages.batches.retrieve(batch.id)
            counts = batch.request_counts
            print(
                f"  Status: {batch.processing_status} | "
                f"Done: {counts.succeeded} | Failed: {counts.errored}"
            )
            if batch.processing_status == "ended":
                break
            time.sleep(30)

        for result in client.messages.batches.results(batch.id):
            if result.result.type == "succeeded":
                text = result.result.message.content[0].text
                classification = parse_result(text)
            else:
                classification = {
                    "is_venue": False,
                    "confidence": 0.0,
                    "reasoning": f"Error: {result.result.type}",
                }
            all_results[result.custom_id] = classification

    venues = []
    non_venues = []
    out_fields = list(fieldnames) + ["sonnet_is_venue", "sonnet_confidence", "sonnet_reasoning"]

    for i, lead in enumerate(leads):
        result = all_results.get(f"escalate-{i}", {
            "is_venue": False, "confidence": 0.0, "reasoning": "No result"
        })
        row = {
            **lead,
            "sonnet_is_venue": result["is_venue"],
            "sonnet_confidence": result["confidence"],
            "sonnet_reasoning": result["reasoning"],
        }
        if result["is_venue"]:
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
    write_csv(output_dir / "results.csv", venues + non_venues, out_fields)

    print(f"\n--- Sonnet Escalation Summary ---")
    print(f"Total escalated:   {len(leads)}")
    print(f"Confirmed venues:  {len(venues)}")
    print(f"Non-venues:        {len(non_venues)}")
    print(f"Results saved to {output_dir}/")


if __name__ == "__main__":
    main()
