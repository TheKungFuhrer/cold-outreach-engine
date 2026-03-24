"""
Async Haiku batch helper for daily prospecting.

Subcommands:
  submit --input <csv> [--output-dir <dir>]   Submit batch, print batch_id, return immediately
  status <batch_id>                            Check batch status
  results <batch_id> --output-dir <dir>        Stream results to venues/non_venues/ambiguous CSVs
"""

import argparse
import csv
import json
import os
import sys
from pathlib import Path

from anthropic import Anthropic
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "shared"))
from fields import resolve_field

load_dotenv(PROJECT_ROOT / ".env")

API_KEY = os.getenv("ANTHROPIC_API_KEY_BATCH")
if not API_KEY:
    print(json.dumps({"error": "ANTHROPIC_API_KEY_BATCH not set"}))
    sys.exit(1)

client = Anthropic(api_key=API_KEY)

MODEL = "claude-haiku-4-5-20251001"
CONFIDENCE_THRESHOLD = 0.7

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
- Caterers, DJs, photographers, florists (they provide services, not space)
- Standalone restaurants without event space
- Government buildings, parks, schools"""


def build_requests(input_csv):
    """Build batch requests from CSV."""
    requests = []
    with open(input_csv, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader):
            name = resolve_field(row, "companyName")
            email = resolve_field(row, "email")
            website = resolve_field(row, "website")

            user_msg = f"Business: {name}\nEmail: {email}\nWebsite: {website}"
            requests.append({
                "custom_id": f"lead-{i}",
                "params": {
                    "model": MODEL,
                    "max_tokens": 256,
                    "system": SYSTEM_PROMPT,
                    "messages": [{"role": "user", "content": user_msg}],
                },
            })
    return requests


def parse_result(text):
    """Parse classification JSON from model response."""
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"is_venue": False, "confidence": 0.0, "reasoning": "Parse error"}


def cmd_submit(args):
    """Submit a batch and return immediately."""
    requests = build_requests(args.input)
    if not requests:
        print(json.dumps({"batch_id": None, "count": 0, "error": "No leads to classify"}))
        return

    batch = client.messages.batches.create(requests=requests)
    print(json.dumps({"batch_id": batch.id, "count": len(requests)}))


def cmd_status(args):
    """Check batch status."""
    batch = client.messages.batches.retrieve(args.batch_id)
    counts = batch.request_counts
    print(json.dumps({
        "status": batch.processing_status,
        "succeeded": counts.succeeded,
        "errored": counts.errored,
        "processing": counts.processing,
        "canceled": counts.canceled,
    }))


def cmd_results(args):
    """Stream results and write CSVs."""
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Read original input to map custom_ids back to lead data
    input_csv = args.input
    leads = []
    if input_csv:
        with open(input_csv, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            leads = list(reader)

    venues, non_venues, ambiguous = [], [], []

    for result in client.messages.batches.results(args.batch_id):
        idx_str = result.custom_id.replace("lead-", "")
        try:
            idx = int(idx_str)
        except ValueError:
            continue

        lead = leads[idx] if idx < len(leads) else {}

        if result.result.type == "succeeded":
            text = result.result.message.content[0].text
            parsed = parse_result(text)
        else:
            parsed = {"is_venue": False, "confidence": 0.0, "reasoning": f"Batch error: {result.result.type}"}

        row = {**lead, **parsed}

        if parsed["confidence"] < CONFIDENCE_THRESHOLD:
            ambiguous.append(row)
        elif parsed["is_venue"]:
            venues.append(row)
        else:
            non_venues.append(row)

    def write_csv(path, rows):
        if not rows:
            return
        with open(path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=rows[0].keys())
            writer.writeheader()
            writer.writerows(rows)

    write_csv(output_dir / "venues.csv", venues)
    write_csv(output_dir / "non_venues.csv", non_venues)
    write_csv(output_dir / "ambiguous.csv", ambiguous)

    print(json.dumps({
        "venues": len(venues),
        "non_venues": len(non_venues),
        "ambiguous": len(ambiguous),
    }))


def main():
    parser = argparse.ArgumentParser(description="Haiku batch helper")
    sub = parser.add_subparsers(dest="command")

    p_submit = sub.add_parser("submit")
    p_submit.add_argument("--input", required=True)

    p_status = sub.add_parser("status")
    p_status.add_argument("batch_id")

    p_results = sub.add_parser("results")
    p_results.add_argument("batch_id")
    p_results.add_argument("--input", help="Original input CSV for lead data mapping")
    p_results.add_argument("--output-dir", required=True)

    args = parser.parse_args()

    if args.command == "submit":
        cmd_submit(args)
    elif args.command == "status":
        cmd_status(args)
    elif args.command == "results":
        cmd_results(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
