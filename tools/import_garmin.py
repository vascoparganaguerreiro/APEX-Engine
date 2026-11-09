#!/usr/bin/env python3
"""Import a Garmin "Export your data" archive (DI_CONNECT.zip) into APEX / Supabase.

Reads sleep, HRV, resting HR, stress, body battery, SpO2 and all activities straight
from the zip (no need to extract it). Safe to run more than once: rows are upserted,
so nothing is duplicated. Days you logged manually in the app are never overwritten.

  Test without uploading anything:   python import_garmin.py DI_CONNECT.zip --dry-run
  Real import (asks for password):   python import_garmin.py DI_CONNECT.zip \
        --url https://YOUR-PROJECT.supabase.co --anon-key YOUR_KEY --email you@gmail.com
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import statistics
import sys
import zipfile
from datetime import datetime, timezone

SPORT_MAP = {
    "running": "run", "treadmill_running": "run", "trail_running": "run",
    "track_running": "run", "virtual_run": "run",
    "cycling": "bike", "indoor_cycling": "bike", "virtual_ride": "bike",
    "road_biking": "bike", "mountain_biking": "bike", "gravel_cycling": "bike",
    "lap_swimming": "swim", "open_water_swimming": "swim",
    "strength_training": "strength",
}
DAY_COLS = ["hrv_ms", "rhr_bpm", "sleep_minutes", "deep_min", "rem_min", "light_min",
            "awake_min", "sleep_score", "body_battery", "stress_avg", "spo2_avg"]


def read_json(z: zipfile.ZipFile, ends_with: str):
    for name in sorted(z.namelist()):
        if name.endswith(ends_with):
            with z.open(name) as f:
                yield name, json.load(f)


def build_days(z: zipfile.ZipFile) -> dict[str, dict]:
    days: dict[str, dict] = {}

    def row(day: str) -> dict:
        return days.setdefault(day, {})

    for _, data in read_json(z, "_sleepData.json"):
        for r in data:
            day = r.get("calendarDate")
            deep, light, rem, awake = (r.get(k) or 0 for k in (
                "deepSleepSeconds", "lightSleepSeconds", "remSleepSeconds", "awakeSleepSeconds"))
            if not day or deep + light + rem <= 0:
                continue
            x = row(day)
            x.update(sleep_minutes=round((deep + light + rem) / 60), deep_min=round(deep / 60),
                     rem_min=round(rem / 60), light_min=round(light / 60), awake_min=round(awake / 60))
            score = (r.get("sleepScores") or {}).get("overallScore")
            if score is not None:
                x["sleep_score"] = int(score)
            spo2 = (r.get("spo2SleepSummary") or {}).get("averageSPO2")
            if spo2:
                x["spo2_avg"] = round(float(spo2), 1)

    for _, data in read_json(z, "_healthStatusData.json"):
        for r in data:
            day = r.get("calendarDate")
            if not day:
                continue
            for m in r.get("metrics") or []:
                if m.get("value") is None:
                    continue
                if m.get("type") == "HRV":
                    row(day)["hrv_ms"] = round(float(m["value"]), 1)
                elif m.get("type") == "HR":
                    row(day)["_sleep_hr"] = int(round(float(m["value"])))

    for name, data in read_json(z, ".json"):
        if "UDSFile_" not in name:
            continue
        for r in data:
            day = r.get("calendarDate")
            if not day:
                continue
            x = row(day)
            if r.get("restingHeartRate"):
                x["rhr_bpm"] = int(r["restingHeartRate"])
            for agg in (r.get("allDayStress") or {}).get("aggregatorList") or []:
                if agg.get("type") == "TOTAL" and (agg.get("averageStressLevel") or 0) > 0:
                    x["stress_avg"] = int(agg["averageStressLevel"])
            for st in (r.get("bodyBattery") or {}).get("bodyBatteryStatList") or []:
                v = st.get("statsValue")
                if st.get("bodyBatteryStatType") == "HIGHEST" and v is not None and 0 <= v <= 100:
                    x["body_battery"] = int(v)
            if "spo2_avg" not in x and r.get("averageSpo2Value"):
                x["spo2_avg"] = round(float(r["averageSpo2Value"]), 1)

    out = {}
    for day, x in days.items():
        if x.get("rhr_bpm") is None and x.get("_sleep_hr"):
            x["rhr_bpm"] = x["_sleep_hr"]          # fallback: average sleeping HR
        x.pop("_sleep_hr", None)
        if any(x.get(c) is not None for c in DAY_COLS):
            out[day] = {c: x.get(c) for c in DAY_COLS}
    return out


def build_activities(z: zipfile.ZipFile, max_hr: int) -> tuple[list[dict], dict]:
    raw: dict[int, dict] = {}
    for _, data in read_json(z, "summarizedActivities.json"):
        for block in data:
            for a in block.get("summarizedActivitiesExport") or []:
                if a.get("activityId") and a.get("startTimeGmt"):
                    raw[a["activityId"]] = a

    # A triathlon/multisport event is stored as a parent ("multi_sport") plus one row per leg,
    # and every leg carries the CUMULATIVE load of the whole event. Counting all of them
    # inflates the load several times over, so we keep the parent only.
    windows = []
    for a in raw.values():
        if a.get("activityType") == "multi_sport":
            span = max(a.get("duration") or 0, a.get("elapsedDuration") or 0)
            windows.append((a["activityId"], a["startTimeGmt"] - 60_000, a["startTimeGmt"] + span + 60_000))

    def is_leg(a: dict) -> bool:
        return a.get("activityType") != "multi_sport" and any(
            w[1] <= a["startTimeGmt"] <= w[2] for w in windows)

    # Calibrate a fallback for old activities that have no Garmin training load:
    # load ~ k * minutes * (avgHR / maxHR)^2, with k learned from the user's own data.
    ratios = []
    for a in raw.values():
        if is_leg(a):
            continue
        if a.get("activityTrainingLoad") and a.get("avgHr") and a.get("duration"):
            minutes = a["duration"] / 60000
            den = minutes * (a["avgHr"] / max_hr) ** 2
            if den > 0:
                ratios.append(a["activityTrainingLoad"] / den)
    k = statistics.median(ratios) if ratios else None

    rows, fallback, no_load, legs = [], 0, 0, 0
    for a in sorted(raw.values(), key=lambda a: a["startTimeGmt"]):
        dur_ms = a.get("duration") or 0
        load = a.get("activityTrainingLoad")
        if is_leg(a):
            load, legs = None, legs + 1
        elif not load:
            if k and a.get("avgHr") and dur_ms:
                load, fallback = k * (dur_ms / 60000) * (a["avgHr"] / max_hr) ** 2, fallback + 1
            else:
                no_load += 1
        rows.append({
            "started_at": datetime.fromtimestamp(a["startTimeGmt"] / 1000, tz=timezone.utc).isoformat(),
            "sport": SPORT_MAP.get(a.get("activityType"), "other"),
            "title": (a.get("name") or None),
            "duration_s": round(dur_ms / 1000) or None,
            "distance_m": round(a["distance"] / 100, 1) if a.get("distance") else None,   # cm -> m
            "avg_hr": int(a["avgHr"]) if a.get("avgHr") else None,
            "avg_power_w": int(a["avgPower"]) if a.get("avgPower") else None,
            "load": round(min(load, 9999.9), 1) if load else None,
            "source": "garmin",
            "external_id": str(a["activityId"]),
        })
    return rows, {"k": k, "fallback": fallback, "no_load": no_load, "legs": legs, "events": len(windows)}


def chunks(items, n=400):
    for i in range(0, len(items), n):
        yield items[i:i + n]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("zip_path")
    ap.add_argument("--dry-run", action="store_true", help="parse and summarise only, upload nothing")
    ap.add_argument("--max-hr", type=int, default=196, help="your max heart rate (for the load fallback)")
    ap.add_argument("--url", default=os.getenv("SUPABASE_URL"))
    ap.add_argument("--anon-key", default=os.getenv("SUPABASE_ANON_KEY"))
    ap.add_argument("--email")
    args = ap.parse_args()

    with zipfile.ZipFile(args.zip_path) as z:
        days = build_days(z)
        acts, info = build_activities(z, args.max_hr)

    dkeys = sorted(days)
    print(f"Daily metrics : {len(days)} days ({dkeys[0]} to {dkeys[-1]})" if days else "Daily metrics : none")
    for col in DAY_COLS:
        print(f"   {col:14s} {sum(1 for d in days.values() if d[col] is not None):5d} days")
    print(f"Activities    : {len(acts)} ({acts[0]['started_at'][:10]} to {acts[-1]['started_at'][:10]})" if acts else "Activities: none")
    by_sport: dict[str, int] = {}
    for a in acts:
        by_sport[a["sport"]] = by_sport.get(a["sport"], 0) + 1
    print("   by sport     ", by_sport)
    print(f"   load: {len(acts) - info['fallback'] - info['no_load'] - info['legs']} from Garmin, "
          f"{info['fallback']} estimated from heart rate, {info['no_load']} without load")
    print(f"   multisport: {info['events']} events; {info['legs']} leg rows set to no load "
          f"(each event is counted once, through its parent)")
    if args.dry_run:
        print("\nDry run finished. Nothing was uploaded.")
        return 0

    if not (args.url and args.anon_key and args.email):
        sys.exit("Missing --url, --anon-key or --email (or run with --dry-run).")
    from supabase import create_client

    sb = create_client(args.url, args.anon_key)
    res = sb.auth.sign_in_with_password(
        {"email": args.email, "password": getpass.getpass("APEX password: ")})
    uid = res.user.id

    manual = {r["day"] for r in sb.table("daily_metrics").select("day").eq("source", "manual").execute().data}
    day_rows = [{"user_id": uid, "day": d, "source": "garmin", **v} for d, v in days.items() if d not in manual]
    print(f"Skipping {len(days) - len(day_rows)} day(s) you logged manually.")
    for i, part in enumerate(chunks(day_rows), 1):
        sb.table("daily_metrics").upsert(part, on_conflict="user_id,day").execute()
        print(f"  daily_metrics batch {i} ok ({len(part)} rows)")
    act_rows = [{"user_id": uid, **a} for a in acts]
    for i, part in enumerate(chunks(act_rows), 1):
        sb.table("activities").upsert(part, on_conflict="user_id,source,external_id").execute()
        print(f"  activities batch {i} ok ({len(part)} rows)")
    print("Done. Open the app and refresh.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
