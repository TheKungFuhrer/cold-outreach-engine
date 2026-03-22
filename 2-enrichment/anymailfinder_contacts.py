#!/usr/bin/env python3
"""
Find additional contacts at existing verified venues.
Calls AnyMailFinder /v5.1/find-email/company for each venue domain.
Runs with high concurrency (30 parallel requests). Saves progress every 100 leads.

Input:  data/classified/venues.csv
Output: data/anymailfinder/additional_contacts.csv
"""

import asyncio
import csv
import json
import os
import sys
import time
from pathlib import Path

import aiohttp
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).parent.parent
load_dotenv(PROJECT_ROOT / ".env")

API_KEY = os.getenv("ANYMAILFINDER_API_KEY")
API_URL = "https://api.anymailfinder.com/v5.1/find-email/company"
CONCURRENCY = 30
SAVE_EVERY = 100
TIMEOUT = 180

VENUES_CSV = PROJECT_ROOT / "data" / "classified" / "venues.csv"
OUTPUT_CSV = PROJECT_ROOT / "data" / "anymailfinder" / "additional_contacts.csv"
PROGRESS_FILE = PROJECT_ROOT / "data" / "anymailfinder" / ".contacts_progress.json"

OUTPUT_FIELDS = [
    "venue_name", "domain", "original_email", "email_status",
    "emails_found", "valid_emails", "num_emails_found"
]


def load_venues():
    venues = []
    with open(VENUES_CSV, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            domain = (row.get("website") or "").strip()
            if domain:
                domain = domain.replace("https://", "").replace("http://", "").split("/")[0]
                venues.append({
                    "venue_name": row.get("company_name", ""),
                    "domain": domain,
                    "original_email": row.get("email", ""),
                })
    return venues


def load_progress():
    if PROGRESS_FILE.exists():
        with open(PROGRESS_FILE, "r") as f:
            return set(json.load(f).get("completed_domains", []))
    return set()


def save_progress(completed_domains):
    PROGRESS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(PROGRESS_FILE, "w") as f:
        json.dump({"completed_domains": list(completed_domains)}, f)


async def find_emails(session, sem, venue):
    async with sem:
        headers = {
            "Authorization": API_KEY,
            "Content-Type": "application/json",
        }
        payload = {"domain": venue["domain"], "email_type": "any"}
        try:
            async with session.post(
                API_URL, json=payload, headers=headers,
                timeout=aiohttp.ClientTimeout(total=TIMEOUT)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return {
                        "venue_name": venue["venue_name"],
                        "domain": venue["domain"],
                        "original_email": venue["original_email"],
                        "email_status": data.get("email_status", ""),
                        "emails_found": "; ".join(data.get("emails", [])),
                        "valid_emails": "; ".join(data.get("valid_emails", [])),
                        "num_emails_found": len(data.get("emails", [])),
                    }
                else:
                    text = await resp.text()
                    print(f"  ERROR {resp.status} for {venue['domain']}: {text[:100]}")
                    return {
                        "venue_name": venue["venue_name"],
                        "domain": venue["domain"],
                        "original_email": venue["original_email"],
                        "email_status": f"error_{resp.status}",
                        "emails_found": "",
                        "valid_emails": "",
                        "num_emails_found": 0,
                    }
        except Exception as e:
            print(f"  EXCEPTION for {venue['domain']}: {e}")
            return {
                "venue_name": venue["venue_name"],
                "domain": venue["domain"],
                "original_email": venue["original_email"],
                "email_status": "error_exception",
                "emails_found": "",
                "valid_emails": "",
                "num_emails_found": 0,
            }


async def main():
    if not API_KEY:
        print("ERROR: ANYMAILFINDER_API_KEY not set in .env")
        sys.exit(1)

    venues = load_venues()
    print(f"Loaded {len(venues)} venues with domains")

    completed = load_progress()
    if completed:
        print(f"Resuming: {len(completed)} already completed")

    remaining = [v for v in venues if v["domain"] not in completed]
    print(f"Remaining to process: {len(remaining)}")

    if not remaining:
        print("All venues already processed!")
        return

    existing_results = []
    if OUTPUT_CSV.exists() and completed:
        with open(OUTPUT_CSV, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            existing_results = list(reader)

    all_results = existing_results
    sem = asyncio.Semaphore(CONCURRENCY)
    connector = aiohttp.TCPConnector(limit=CONCURRENCY, force_close=False)

    async with aiohttp.ClientSession(connector=connector) as session:
        batch_start = time.time()
        tasks = []
        batch_count = 0

        for i, venue in enumerate(remaining):
            tasks.append(find_emails(session, sem, venue))

            if len(tasks) >= SAVE_EVERY or i == len(remaining) - 1:
                results = await asyncio.gather(*tasks)
                all_results.extend(results)

                for r in results:
                    completed.add(r["domain"])

                OUTPUT_CSV.parent.mkdir(parents=True, exist_ok=True)
                with open(OUTPUT_CSV, "w", encoding="utf-8", newline="") as f:
                    writer = csv.DictWriter(f, fieldnames=OUTPUT_FIELDS)
                    writer.writeheader()
                    writer.writerows(all_results)
                save_progress(completed)

                batch_count += len(tasks)
                elapsed = time.time() - batch_start
                rate = batch_count / elapsed if elapsed > 0 else 0
                valid_count = sum(1 for r in all_results if r.get("email_status") == "valid")
                total_emails = sum(int(r.get("num_emails_found", 0)) for r in all_results)

                print(
                    f"  Progress: {len(completed)}/{len(venues)} | "
                    f"Rate: {rate:.1f}/s | "
                    f"Valid: {valid_count} | "
                    f"Total emails found: {total_emails} | "
                    f"Saved to {OUTPUT_CSV}"
                )

                tasks = []

    valid = sum(1 for r in all_results if r.get("email_status") == "valid")
    total_emails = sum(int(r.get("num_emails_found", 0)) for r in all_results)
    credits_used = valid
    print(f"\n=== COMPLETE ===")
    print(f"Total venues processed: {len(all_results)}")
    print(f"Valid results (credits used): {credits_used}")
    print(f"Total emails discovered: {total_emails}")
    print(f"Output: {OUTPUT_CSV}")


if __name__ == "__main__":
    asyncio.run(main())
