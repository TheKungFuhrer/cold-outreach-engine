"""
Validate phone numbers using Numverify API.
Segments venues into mobile/voip/landline/invalid/no_phone CSVs.
Resumable via JSONL checkpoint.

Input:  data/classified/venues.csv (or --input <file>)
Output: data/phone_validated/mobile.csv, voip.csv, landline.csv, invalid.csv, no_phone.csv
"""

import argparse
import csv
import json
import os
import sys
import time
import urllib.request
import urllib.parse
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).parent.parent
load_dotenv(PROJECT_ROOT / ".env")

API_KEY = os.getenv("NUMVERIFY_API_KEY")
if not API_KEY:
    print("Error: NUMVERIFY_API_KEY not set in .env")
    sys.exit(1)

API_ENDPOINT = "http://apilayer.net/api/validate"
MAX_CALLS = 10000
DELAY_SECONDS = 0.2
SAVE_EVERY = 100


def load_results(results_file):
    results = {}
    if results_file.exists():
        with open(results_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    entry = json.loads(line)
                    results[entry["lead_id"]] = entry
    return results


def append_result(results_file, lead_id, phone_valid, line_type, carrier):
    results_file.parent.mkdir(parents=True, exist_ok=True)
    with open(results_file, "a", encoding="utf-8") as f:
        f.write(json.dumps({
            "lead_id": lead_id,
            "phone_valid": phone_valid,
            "line_type": line_type,
            "carrier": carrier,
        }) + "\n")


def validate_phone(phone_number):
    params = urllib.parse.urlencode({
        "access_key": API_KEY,
        "number": phone_number,
        "country_code": "US",
        "format": 1,
    })
    url = f"{API_ENDPOINT}?{params}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def normalize_phone(raw):
    digits = "".join(c for c in raw if c.isdigit())
    if len(digits) == 10:
        digits = "1" + digits
    return digits


def classify_result(result):
    if "error" in result and result["error"]:
        return "error", "", ""
    if result.get("valid"):
        line_type = (result.get("line_type") or "unknown").lower()
        carrier = result.get("carrier") or ""
        return "true", line_type, carrier
    return "false", "", ""


def bucket_for(phone_valid, line_type):
    if phone_valid not in ("true",):
        return "invalid"
    if line_type == "mobile":
        return "mobile"
    if line_type == "voip":
        return "voip"
    return "landline"


def count_buckets(saved_results):
    counts = {"mobile": 0, "voip": 0, "landline": 0, "invalid": 0}
    for r in saved_results.values():
        b = bucket_for(r["phone_valid"], r["line_type"])
        counts[b] += 1
    return counts


def write_csvs(leads_with_phone, leads_no_phone, saved_results, fieldnames, output_dir):
    buckets = {"mobile": [], "voip": [], "landline": [], "invalid": []}
    unprocessed = []

    for lead in leads_with_phone:
        lead_id = lead.get("id", lead.get("email"))
        if lead_id in saved_results:
            r = saved_results[lead_id]
            lead_out = dict(lead)
            lead_out["phone_valid"] = r["phone_valid"]
            lead_out["line_type"] = r["line_type"]
            lead_out["carrier"] = r["carrier"]
            b = bucket_for(r["phone_valid"], r["line_type"])
            buckets[b].append(lead_out)
        else:
            unprocessed.append(lead)

    for name, rows in buckets.items():
        outpath = output_dir / f"{name}.csv"
        with open(outpath, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)

    no_phone_path = output_dir / "no_phone.csv"
    with open(no_phone_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for lead in leads_no_phone:
            lead_out = dict(lead)
            lead_out["phone_valid"] = ""
            lead_out["line_type"] = ""
            lead_out["carrier"] = ""
            writer.writerow(lead_out)

    if unprocessed:
        unprocessed_path = output_dir / "unprocessed.csv"
        with open(unprocessed_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
            writer.writeheader()
            for lead in unprocessed:
                lead_out = dict(lead)
                lead_out["phone_valid"] = ""
                lead_out["line_type"] = ""
                lead_out["carrier"] = ""
                writer.writerow(lead_out)
    else:
        up = output_dir / "unprocessed.csv"
        if up.exists():
            up.unlink()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default=str(PROJECT_ROOT / "data" / "classified" / "venues.csv"))
    parser.add_argument("--output-dir", default=str(PROJECT_ROOT / "data" / "phone_validated"))
    args = parser.parse_args()

    input_file = Path(args.input)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    results_file = output_dir / "results.jsonl"

    if not input_file.exists():
        print(f"Error: Input file not found: {input_file}")
        sys.exit(1)

    with open(input_file, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        leads = list(reader)

    print(f"Loaded {len(leads)} leads from {input_file.name}")
    out_fields = fieldnames + ["phone_valid", "line_type", "carrier"]

    saved_results = load_results(results_file)
    if saved_results:
        print(f"Resuming: {len(saved_results)} leads already have results on disk")

    leads_with_phone = []
    leads_no_phone = []
    for lead in leads:
        phone = (lead.get("phone_number") or "").strip()
        if phone:
            leads_with_phone.append(lead)
        else:
            leads_no_phone.append(lead)

    print(f"  With phone: {len(leads_with_phone)}")
    print(f"  No phone:   {len(leads_no_phone)}")

    need_processing = sum(
        1 for lead in leads_with_phone
        if lead.get("id", lead.get("email")) not in saved_results
    )
    print(f"  Need API calls: {need_processing}")
    print(f"  API credit limit: {MAX_CALLS}")
    print()

    if need_processing == 0:
        print("All leads already validated. Writing segment CSVs...")
    else:
        calls_this_run = 0
        total_calls = len(saved_results)

        for i, lead in enumerate(leads_with_phone):
            lead_id = lead.get("id", lead.get("email", str(i)))
            if lead_id in saved_results:
                continue
            if total_calls >= MAX_CALLS:
                break

            phone_raw = lead["phone_number"].strip()
            phone_normalized = normalize_phone(phone_raw)

            try:
                result = validate_phone(phone_normalized)
                total_calls += 1
                calls_this_run += 1
            except Exception as e:
                print(f"  API error for {phone_raw}: {e}")
                append_result(results_file, lead_id, "error", "", "")
                saved_results[lead_id] = {
                    "lead_id": lead_id, "phone_valid": "error",
                    "line_type": "", "carrier": "",
                }
                time.sleep(DELAY_SECONDS)
                continue

            phone_valid, line_type, carrier = classify_result(result)

            if "error" in result and result["error"]:
                error_info = result["error"]
                print(f"  API error for {phone_raw}: {error_info.get('info', error_info)}")

            append_result(results_file, lead_id, phone_valid, line_type, carrier)
            saved_results[lead_id] = {
                "lead_id": lead_id, "phone_valid": phone_valid,
                "line_type": line_type, "carrier": carrier,
            }

            if calls_this_run % 100 == 0:
                counts = count_buckets(saved_results)
                print(f"  Processed {calls_this_run} this run ({total_calls} total) | "
                      f"mobile={counts['mobile']} voip={counts['voip']} "
                      f"landline={counts['landline']} invalid={counts['invalid']}")

            if calls_this_run % SAVE_EVERY == 0:
                write_csvs(leads_with_phone, leads_no_phone, saved_results, out_fields, output_dir)

            time.sleep(DELAY_SECONDS)

        print(f"\nAPI calls this run: {calls_this_run}")

    write_csvs(leads_with_phone, leads_no_phone, saved_results, out_fields, output_dir)

    counts = count_buckets(saved_results)
    unprocessed = len(leads_with_phone) - len(saved_results)

    print()
    print("=" * 50)
    print("PHONE VALIDATION COMPLETE")
    print("=" * 50)
    print(f"Total validated: {len(saved_results)}/{len(leads_with_phone)}")
    print(f"Results in {output_dir}/:")
    print(f"  mobile.csv:   {counts['mobile']} leads (SMS + MMS capable)")
    print(f"  voip.csv:     {counts['voip']} leads (SMS likely, no MMS)")
    print(f"  landline.csv: {counts['landline']} leads (voice only)")
    print(f"  invalid.csv:  {counts['invalid']} leads (invalid numbers)")
    print(f"  no_phone.csv: {len(leads_no_phone)} leads (no phone on record)")
    if unprocessed > 0:
        print(f"\n  {unprocessed} leads still need processing. Re-run after adding credits.")


if __name__ == "__main__":
    main()
