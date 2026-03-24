#!/usr/bin/env python3
"""
Submit remaining venues to AnyMailFinder Bulk API for faster processing.
Reads progress from contacts script, identifies remaining domains, submits as bulk job,
polls for completion, downloads results, and merges into additional_contacts.csv.

Input:  data/classified/venues.csv + progress from contacts script
Output: data/anymailfinder/additional_contacts.csv (merged)
"""

import asyncio
import csv
import json
import os
import sys
import time
from io import StringIO
from pathlib import Path

import aiohttp
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "shared"))
from fields import resolve_field

load_dotenv(PROJECT_ROOT / ".env")

API_KEY = os.getenv("ANYMAILFINDER_API_KEY")
BASE_URL = "https://api.anymailfinder.com/v5.1"
POLL_INTERVAL = 15

VENUES_CSV = PROJECT_ROOT / "data" / "classified" / "venues.csv"
OUTPUT_CSV = PROJECT_ROOT / "data" / "anymailfinder" / "additional_contacts.csv"
PROGRESS_FILE = PROJECT_ROOT / "data" / "anymailfinder" / ".contacts_progress.json"
BULK_PROGRESS = PROJECT_ROOT / "data" / "anymailfinder" / ".bulk_progress.json"

OUTPUT_FIELDS = [
    "venue_name", "domain", "original_email", "email_status",
    "emails_found", "valid_emails", "num_emails_found"
]


def load_venues():
    venues = []
    with open(VENUES_CSV, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            raw_website = resolve_field(row, "website")
            if raw_website:
                domain = raw_website.replace("https://", "").replace("http://", "").split("/")[0]
                venues.append({
                    "venue_name": resolve_field(row, "companyName"),
                    "domain": domain,
                    "original_email": resolve_field(row, "email"),
                })
    return venues


def load_completed():
    if PROGRESS_FILE.exists():
        with open(PROGRESS_FILE, "r") as f:
            return set(json.load(f).get("completed_domains", []))
    return set()


def save_completed(completed):
    with open(PROGRESS_FILE, "w") as f:
        json.dump({"completed_domains": list(completed)}, f)


async def main():
    if not API_KEY:
        print("ERROR: ANYMAILFINDER_API_KEY not set in .env")
        sys.exit(1)

    venues = load_venues()
    completed = load_completed()
    remaining = [v for v in venues if v["domain"] not in completed]
    print(f"Total venues: {len(venues)}")
    print(f"Already completed: {len(completed)}")
    print(f"Remaining to submit: {len(remaining)}")

    if not remaining:
        print("All venues already processed!")
        return

    bulk_search_id = None
    if BULK_PROGRESS.exists():
        with open(BULK_PROGRESS, "r") as f:
            bp = json.load(f)
            bulk_search_id = bp.get("search_id")
            print(f"Resuming bulk job: {bulk_search_id}")

    async with aiohttp.ClientSession() as session:
        headers = {"Authorization": API_KEY, "Content-Type": "application/json"}

        if not bulk_search_id:
            data = [["domain", "venue_name", "original_email"]]
            domain_to_venue = {}
            for v in remaining:
                data.append([v["domain"], v["venue_name"], v["original_email"]])
                domain_to_venue[v["domain"]] = v

            print(f"\nSubmitting {len(remaining)} domains to Bulk API...")
            payload = {
                "data": data,
                "domain_field_index": 0,
                "file_name": f"venue_contacts_remaining_{len(remaining)}",
            }

            async with session.post(
                f"{BASE_URL}/bulk/json",
                json=payload,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=120)
            ) as resp:
                if resp.status == 200:
                    result = await resp.json()
                    bulk_search_id = result.get("id")
                    status = result.get("status")
                    print(f"Bulk job created: {bulk_search_id} | Status: {status}")
                    with open(BULK_PROGRESS, "w") as f:
                        json.dump({"search_id": bulk_search_id, "remaining_count": len(remaining)}, f)
                else:
                    text = await resp.text()
                    print(f"ERROR {resp.status}: {text[:300]}")
                    sys.exit(1)

        print("\nPolling for completion...")
        poll_headers = {"Authorization": API_KEY}
        while True:
            async with session.get(
                f"{BASE_URL}/bulk/{bulk_search_id}",
                headers=poll_headers,
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status == 200:
                    info = await resp.json()
                    status = info.get("status", "unknown")
                    counts = info.get("counts", {})
                    total = counts.get("total", 0)
                    found_valid = counts.get("found_valid", 0)
                    found_unknown = counts.get("found_unknown", 0)
                    not_found = counts.get("not_found", 0)
                    failed = counts.get("failed", 0)
                    processed = found_valid + found_unknown + not_found + failed
                    credits = info.get("credits_needed", 0)

                    print(f"  Status: {status} | Processed: {processed}/{total} | "
                          f"Valid: {found_valid} | Credits needed: {credits}")

                    if status == "completed":
                        print("\nBulk job completed!")
                        break
                    elif status == "failed":
                        print("\nBulk job FAILED!")
                        sys.exit(1)
                else:
                    print(f"  Poll error: {resp.status}")

            await asyncio.sleep(POLL_INTERVAL)

        print("\nDownloading results...")
        async with session.get(
            f"{BASE_URL}/bulk/{bulk_search_id}/download",
            params={"download_as": "csv", "format": "company-one-email-per-line"},
            headers=poll_headers,
            timeout=aiohttp.ClientTimeout(total=300)
        ) as resp:
            if resp.status == 200:
                csv_content = await resp.text()
                bulk_csv_path = PROJECT_ROOT / "data" / "anymailfinder" / "bulk_remaining_results.csv"
                with open(bulk_csv_path, "w", encoding="utf-8") as f:
                    f.write(csv_content)
                print(f"Raw results saved to: {bulk_csv_path}")
            else:
                text = await resp.text()
                print(f"Download error {resp.status}: {text[:300]}")
                sys.exit(1)

        print("\nParsing and merging results...")
        domain_to_venue = {}
        for v in remaining:
            domain_to_venue[v["domain"]] = v

        bulk_reader = csv.DictReader(StringIO(csv_content))
        bulk_fields = bulk_reader.fieldnames
        print(f"Bulk CSV columns: {bulk_fields}")

        domain_emails = {}
        domain_status = {}
        for row in bulk_reader:
            domain = (row.get("domain") or row.get("Domain") or "").strip().lower()
            if not domain:
                for key in bulk_fields:
                    if "domain" in key.lower():
                        domain = (row.get(key) or "").strip().lower()
                        if domain:
                            break
            if not domain:
                continue

            email = (row.get("email") or row.get("Email") or
                     row.get("found_email") or row.get("Found Email") or "").strip()
            status = (row.get("email_status") or row.get("Email Status") or
                      row.get("status") or row.get("Status") or "").strip()

            if domain not in domain_emails:
                domain_emails[domain] = []
                domain_status[domain] = status or "unknown"
            if email:
                domain_emails[domain].append(email)
            if status:
                domain_status[domain] = status

        existing_results = []
        if OUTPUT_CSV.exists():
            with open(OUTPUT_CSV, "r", encoding="utf-8") as f:
                existing_results = list(csv.DictReader(f))

        new_results = []
        for domain, emails in domain_emails.items():
            venue = domain_to_venue.get(domain, {})
            new_results.append({
                "venue_name": venue.get("venue_name", ""),
                "domain": domain,
                "original_email": venue.get("original_email", ""),
                "email_status": domain_status.get(domain, "unknown"),
                "emails_found": "; ".join(emails),
                "valid_emails": "; ".join(emails) if domain_status.get(domain) == "valid" else "",
                "num_emails_found": len(emails),
            })

        for v in remaining:
            d = v["domain"].lower()
            if d not in domain_emails:
                new_results.append({
                    "venue_name": v["venue_name"],
                    "domain": d,
                    "original_email": v["original_email"],
                    "email_status": domain_status.get(d, "not_found"),
                    "emails_found": "",
                    "valid_emails": "",
                    "num_emails_found": 0,
                })

        all_results = existing_results + new_results
        with open(OUTPUT_CSV, "w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=OUTPUT_FIELDS)
            writer.writeheader()
            writer.writerows(all_results)

        for v in remaining:
            completed.add(v["domain"])
        save_completed(completed)

        if BULK_PROGRESS.exists():
            os.remove(str(BULK_PROGRESS))

        valid_count = sum(1 for r in new_results if r.get("email_status") == "valid")
        total_emails = sum(int(r.get("num_emails_found", 0)) for r in new_results)
        print(f"\n=== BULK RESULTS ===")
        print(f"Domains processed: {len(remaining)}")
        print(f"Valid: {valid_count}")
        print(f"New emails found: {total_emails}")
        print(f"Merged into: {OUTPUT_CSV}")

        all_valid = sum(1 for r in all_results if r.get("email_status") == "valid")
        all_emails = sum(int(r.get("num_emails_found", 0)) for r in all_results)
        print(f"\n=== GRAND TOTALS ===")
        print(f"Total venues processed: {len(all_results)}")
        print(f"Total valid: {all_valid}")
        print(f"Total emails: {all_emails}")


if __name__ == "__main__":
    asyncio.run(main())
