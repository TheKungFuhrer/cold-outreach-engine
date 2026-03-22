#!/usr/bin/env python3
"""
GeoLead Finder for new venue discovery using additional search terms.
Parses original Event_Venue CSVs to extract city coordinates, then creates new
GeoLead searches for: "wedding venue", "banquet hall", "reception hall", "event space".
Deduplicates against existing venues.csv and original Event Venue CSVs.

Works in waves of WAVE_SIZE to avoid "too many unpaid searches" API limit.
Each wave: create -> wait for completion -> download -> next wave.
"""

import asyncio
import csv
import glob
import json
import os
import re
import sys
import time
from io import StringIO
from pathlib import Path

import aiohttp
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).parent.parent.parent
load_dotenv(PROJECT_ROOT / ".env")

API_KEY = os.getenv("ANYMAILFINDER_API_KEY")
BASE_URL = "https://api.anymailfinder.com/v5.1/geo-lead"
CONCURRENCY = 10
POLL_INTERVAL = 15
WAVE_SIZE = 10
PARALLEL_WAVES = 4

ADDITIONAL_QUERIES = ["wedding venue", "banquet hall", "reception hall", "event space"]

ORIGINAL_CSV_DIR = PROJECT_ROOT / "data" / "anymailfinder" / "original_csvs"
VENUES_CSV = PROJECT_ROOT / "data" / "classified" / "venues.csv"
OUTPUT_DIR = PROJECT_ROOT / "data" / "anymailfinder" / "geolead_results"
PROGRESS_FILE = PROJECT_ROOT / "data" / "anymailfinder" / ".geolead_progress.json"
FINAL_OUTPUT = PROJECT_ROOT / "data" / "anymailfinder" / "geolead_new_leads.csv"

FILENAME_PATTERN = re.compile(r"Event_Venue_(.+?)_(\d+km)_results\.csv")


def parse_city_coords_from_csvs():
    cities = {}
    csv_files = sorted(glob.glob(str(ORIGINAL_CSV_DIR / "Event_Venue_*_results.csv")))
    for filepath in csv_files:
        fname = os.path.basename(filepath)
        match = FILENAME_PATTERN.match(fname)
        if not match:
            continue
        location_str = match.group(1)
        radius = match.group(2)
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    lat = row.get("latitude", "").strip()
                    lng = row.get("longitude", "").strip()
                    if lat and lng:
                        try:
                            cities[location_str] = {
                                "location": location_str,
                                "latitude": float(lat),
                                "longitude": float(lng),
                                "radius_km": int(radius.replace("km", "")),
                            }
                        except ValueError:
                            pass
                    break
        except Exception as e:
            print(f"  Warning: Could not read {fname}: {e}")
    return cities


def load_existing_domains():
    domains = set()
    if VENUES_CSV.exists():
        with open(VENUES_CSV, "r", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                domain = (row.get("website") or "").strip().lower()
                domain = domain.replace("https://", "").replace("http://", "").split("/")[0]
                if domain:
                    domains.add(domain)
    csv_files = glob.glob(str(ORIGINAL_CSV_DIR / "Event_Venue_*_results.csv"))
    for filepath in csv_files:
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    domain = (row.get("company_domain") or "").strip().lower()
                    if domain:
                        domains.add(domain)
        except Exception:
            pass
    return domains


def load_progress():
    if PROGRESS_FILE.exists():
        with open(PROGRESS_FILE, "r") as f:
            return json.load(f)
    return {"created": {}, "downloaded": [], "failed": []}


def save_progress(progress):
    PROGRESS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(PROGRESS_FILE, "w") as f:
        json.dump(progress, f, indent=2)


async def create_search(session, sem, city, query):
    async with sem:
        headers = {"Authorization": API_KEY, "Content-Type": "application/json"}
        file_name = f"{query.replace(' ', '_')}_{city['location']}_{city['radius_km']}km"
        payload = {
            "file_name": file_name,
            "query": query,
            "latitude": city["latitude"],
            "longitude": city["longitude"],
            "radius_km": city["radius_km"],
            "find_company_emails": True,
            "find_decision_maker_categories": ["ceo"],
        }
        try:
            async with session.post(
                BASE_URL, json=payload, headers=headers,
                timeout=aiohttp.ClientTimeout(total=60)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return {
                        "id": data["id"],
                        "file_name": file_name,
                        "query": query,
                        "city": city["location"],
                        "status": data.get("status", "unknown"),
                    }
                else:
                    text = await resp.text()
                    print(f"  CREATE ERROR {resp.status} for {file_name}: {text[:120]}")
                    return None
        except Exception as e:
            print(f"  CREATE EXCEPTION for {file_name}: {e}")
            return None


async def check_status(session, search_id):
    headers = {"Authorization": API_KEY}
    try:
        async with session.get(
            f"{BASE_URL}/{search_id}", headers=headers,
            timeout=aiohttp.ClientTimeout(total=30)
        ) as resp:
            if resp.status == 200:
                return await resp.json()
            return None
    except Exception:
        return None


async def download_results(session, search_id, file_name):
    headers = {"Authorization": API_KEY}
    try:
        async with session.get(
            f"{BASE_URL}/{search_id}/download",
            params={"download_as": "csv", "format": "default"},
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=120)
        ) as resp:
            if resp.status == 200:
                content = await resp.text()
                out_path = OUTPUT_DIR / f"{file_name}.csv"
                out_path.parent.mkdir(parents=True, exist_ok=True)
                with open(out_path, "w", encoding="utf-8") as f:
                    f.write(content)
                return content
            else:
                text = await resp.text()
                print(f"  DOWNLOAD ERROR {resp.status} for {file_name}: {text[:120]}")
                return None
    except Exception as e:
        print(f"  DOWNLOAD EXCEPTION for {file_name}: {e}")
        return None


async def wait_and_download_wave(session, wave_searches, progress, existing_domains):
    pending = {s["id"]: s for s in wave_searches if s["status"] not in ("completed", "failed")}
    new_leads = []
    total_credits = 0

    while pending:
        print(f"    Polling {len(pending)} pending searches...")
        await asyncio.sleep(POLL_INTERVAL)

        for search_id in list(pending.keys()):
            info = await check_status(session, search_id)
            if not info:
                continue
            status = info.get("status", "unknown")
            s = pending[search_id]

            if status == "completed":
                counts = info.get("counts", {})
                total = counts.get("total", 0)
                credits = info.get("credits_needed", 0)
                print(f"    COMPLETED: {s['file_name']} | {total} results | {credits} credits")
                s["status"] = "completed"
                s["credits_needed"] = credits
                s["total_results"] = total
                del pending[search_id]
            elif status == "failed":
                print(f"    FAILED: {s['file_name']}")
                s["status"] = "failed"
                progress["failed"].append(s["file_name"])
                del pending[search_id]

    completed = [s for s in wave_searches if s.get("status") == "completed"]
    already_downloaded = set(progress.get("downloaded", []))

    for s in completed:
        if s["file_name"] in already_downloaded:
            continue
        csv_content = await download_results(session, s["id"], s["file_name"])
        if csv_content:
            progress["downloaded"].append(s["file_name"])
            reader = csv.DictReader(StringIO(csv_content))
            for row in reader:
                domain = (row.get("company_domain") or "").strip().lower()
                if domain and domain not in existing_domains:
                    existing_domains.add(domain)
                    row["source_query"] = s.get("query", "")
                    row["source_city"] = s.get("city", "")
                    new_leads.append(row)
            total_credits += s.get("credits_needed", 0)

    for s in wave_searches:
        key = s.get("file_name", "")
        if key:
            progress["created"][key] = s
    save_progress(progress)

    return new_leads, total_credits


async def main():
    if not API_KEY:
        print("ERROR: ANYMAILFINDER_API_KEY not set in .env")
        sys.exit(1)

    print("=== GeoLead Finder: Additional Query Searches ===\n")

    print("Parsing original Event Venue CSVs for city coordinates...")
    cities = parse_city_coords_from_csvs()
    print(f"Found {len(cities)} cities with coordinates")
    if not cities:
        print("ERROR: No city coordinates found.")
        sys.exit(1)

    print("Loading existing domains for deduplication...")
    existing_domains = load_existing_domains()
    print(f"Loaded {len(existing_domains)} existing domains to deduplicate against")

    progress = load_progress()
    already_created = set(progress.get("created", {}).keys())
    already_downloaded = set(progress.get("downloaded", []))

    all_tasks = []
    for query in ADDITIONAL_QUERIES:
        for loc_str, city in cities.items():
            key = f"{query.replace(' ', '_')}_{loc_str}_{city['radius_km']}km"
            if key not in already_created:
                all_tasks.append((key, query, city))

    total_searches = len(cities) * len(ADDITIONAL_QUERIES)
    print(f"\nTotal searches needed: {total_searches}")
    print(f"Already created: {len(already_created)}")
    print(f"Remaining to create: {len(all_tasks)}")
    print(f"Working in {PARALLEL_WAVES} parallel mini-waves of {WAVE_SIZE} "
          f"({PARALLEL_WAVES * WAVE_SIZE} concurrent unpaid searches)\n")

    connector = aiohttp.TCPConnector(limit=CONCURRENCY)
    sem = asyncio.Semaphore(CONCURRENCY)
    all_new_leads = []
    total_credits = 0

    async with aiohttp.ClientSession(connector=connector) as session:
        prev_created = list(progress["created"].values())
        undownloaded = [s for s in prev_created
                       if s and s.get("status") != "failed"
                       and s.get("file_name") not in already_downloaded]
        if undownloaded:
            print(f"Processing {len(undownloaded)} previously created searches first...")
            leads, credits = await wait_and_download_wave(
                session, undownloaded, progress, existing_domains
            )
            all_new_leads.extend(leads)
            total_credits += credits
            print(f"  Got {len(leads)} new leads from previous wave\n")

        async def process_mini_wave(mini_wave_tasks, wave_label):
            print(f"  [{wave_label}] Creating {len(mini_wave_tasks)} searches...")
            create_coros = [
                create_search(session, sem, city, query)
                for (key, query, city) in mini_wave_tasks
            ]
            results = await asyncio.gather(*create_coros)

            wave_searches = []
            for (key, query, city), result in zip(mini_wave_tasks, results):
                if result:
                    progress["created"][key] = result
                    wave_searches.append(result)

            save_progress(progress)
            print(f"  [{wave_label}] Created {len(wave_searches)}/{len(mini_wave_tasks)}")

            if not wave_searches:
                return [], 0

            print(f"  [{wave_label}] Waiting for completion...")
            leads, credits = await wait_and_download_wave(
                session, wave_searches, progress, existing_domains
            )
            print(f"  [{wave_label}] Done: {len(leads)} new leads | {credits} credits")
            return leads, credits

        task_offset = 0
        batch_num = 0
        while task_offset < len(all_tasks):
            batch_num += 1
            batch_end = min(task_offset + PARALLEL_WAVES * WAVE_SIZE, len(all_tasks))
            batch_tasks = all_tasks[task_offset:batch_end]

            mini_waves = []
            for j in range(0, len(batch_tasks), WAVE_SIZE):
                mini_waves.append(batch_tasks[j:j + WAVE_SIZE])

            print(f"=== Batch {batch_num}: {len(mini_waves)} parallel mini-waves, "
                  f"{len(batch_tasks)} searches "
                  f"({batch_end}/{len(all_tasks)} total) ===")

            coros = [
                process_mini_wave(mw, f"W{task_offset + i * WAVE_SIZE + 1}")
                for i, mw in enumerate(mini_waves)
            ]
            results = await asyncio.gather(*coros)

            for leads, credits in results:
                all_new_leads.extend(leads)
                total_credits += credits

            task_offset = batch_end
            print(f"  Batch {batch_num} complete. Total new leads so far: {len(all_new_leads)}\n")

        for fname in progress.get("downloaded", []):
            fpath = OUTPUT_DIR / f"{fname}.csv"
            if fpath.exists():
                with open(fpath, "r", encoding="utf-8") as f:
                    for row in csv.DictReader(f):
                        domain = (row.get("company_domain") or "").strip().lower()
                        if domain and domain not in existing_domains:
                            existing_domains.add(domain)
                            matching = [s for s in prev_created if s and s.get("file_name") == fname]
                            row["source_query"] = matching[0].get("query", "") if matching else ""
                            row["source_city"] = matching[0].get("city", "") if matching else ""
                            all_new_leads.append(row)

    print(f"\n=== FINAL RESULTS ===")
    print(f"Total new unique leads (after dedup): {len(all_new_leads)}")

    if all_new_leads:
        fieldnames = list(all_new_leads[0].keys())
        FINAL_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        with open(FINAL_OUTPUT, "w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(all_new_leads)
        print(f"Saved to: {FINAL_OUTPUT}")

    print(f"Total credits used for downloads: {total_credits}")
    print(f"Individual results saved in: {OUTPUT_DIR}/")
    failed = progress.get("failed", [])
    if failed:
        print(f"Failed searches: {len(failed)}")


if __name__ == "__main__":
    asyncio.run(main())
