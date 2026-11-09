#!/usr/bin/env python3
"""Daily Garmin -> APEX sync. Runs on YOUR computer; your Garmin login never leaves it.

Setup (once):   pip install garminconnect supabase
First run:      python sync_garmin.py --url https://YOUR-PROJECT.supabase.co --anon-key YOUR_KEY --email you@gmail.com
                (asks for your Garmin email/password and, if enabled, the Garmin MFA code;
                 Garmin tokens are then cached in ~/.garminconnect so later runs don't log in again)
Check formats:  python sync_garmin.py --probe 2026-11-05     (prints the SHAPE of Garmin's answers, no values)
Test only:      python sync_garmin.py --dry-run ...

Unofficial: uses the same private endpoints as the Garmin Connect app (python-garminconnect).
Garmin can change them without notice and rate-limits repeated logins, so never loop logins.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

SPORT_MAP = {
    "running": "run", "treadmill_running": "run", "trail_running": "run", "track_running": "run",
    "virtual_run": "run", "cycling": "bike", "indoor_cycling": "bike", "virtual_ride": "bike",
    "road_biking": "bike", "mountain_biking": "bike", "gravel_cycling": "bike",
    "lap_swimming": "swim", "open_water_swimming": "swim", "strength_training": "strength",
}
DAY_COLS = ["hrv_ms", "rhr_bpm", "sleep_minutes", "deep_min", "rem_min", "light_min",
            "awake_min", "sleep_score", "body_battery", "stress_avg", "spo2_avg"]


def dig(d, *paths):
    """First non-None value found along any of the dotted paths."""
    for p in paths:
        cur = d
        for k in p.split("."):
            cur = cur.get(k) if isinstance(cur, dict) else None
            if cur is None:
                break
        if cur is not None:
            return cur
    return None


def _int(x):
    return int(round(float(x))) if x is not None else None


# ------------------------------------------------------------ mapping (pure)
def map_sleep(s: dict) -> dict:
    dto = (s or {}).get("dailySleepDTO") or s or {}
    deep, light, rem, awake = (dto.get(k) or 0 for k in (
        "deepSleepSeconds", "lightSleepSeconds", "remSleepSeconds", "awakeSleepSeconds"))
    if deep + light + rem <= 0:
        return {}
    out = {"sleep_minutes": round((deep + light + rem) / 60), "deep_min": round(deep / 60),
           "rem_min": round(rem / 60), "light_min": round(light / 60), "awake_min": round(awake / 60)}
    score = dig(dto, "sleepScores.overall.value", "sleepScores.overallScore")
    if score is not None:
        out["sleep_score"] = _int(score)
    spo2 = dig(dto, "averageSpO2Value", "spo2SleepSummary.averageSPO2")
    if spo2:
        out["spo2_avg"] = round(float(spo2), 1)
    return out


def map_hrv(h: dict) -> dict:
    v = dig(h or {}, "hrvSummary.lastNightAvg", "lastNightAvg")
    return {"hrv_ms": round(float(v), 1)} if v else {}


def map_stats(st: dict) -> dict:
    out = {}
    rhr = dig(st or {}, "restingHeartRate")
    if rhr:
        out["rhr_bpm"] = _int(rhr)
    stress = dig(st or {}, "averageStressLevel")
    if stress and stress > 0:
        out["stress_avg"] = _int(stress)
    bb = dig(st or {}, "bodyBatteryHighestValue")
    if bb is not None and 0 <= bb <= 100:
        out["body_battery"] = _int(bb)
    spo2 = dig(st or {}, "averageSpo2", "averageSpo2Value")
    if spo2:
        out["spo2_avg"] = round(float(spo2), 1)
    return out


def map_activity(a: dict) -> dict | None:
    gmt = a.get("startTimeGMT")
    if gmt:
        started = datetime.strptime(gmt[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    elif a.get("beginTimestamp"):
        started = datetime.fromtimestamp(a["beginTimestamp"] / 1000, tz=timezone.utc)
    else:
        return None
    if not a.get("activityId"):
        return None
    load = a.get("activityTrainingLoad")
    span = max(float(a.get("duration") or 0), float(a.get("elapsedDuration") or 0))
    return {
        "_type": dig(a, "activityType.typeKey"),
        "_start": started - timedelta(seconds=60),
        "_end": started + timedelta(seconds=span + 60),
        "started_at": started.isoformat(),
        "sport": SPORT_MAP.get(dig(a, "activityType.typeKey"), "other"),
        "title": a.get("activityName") or None,
        "duration_s": _int(a.get("duration")) or None,
        "distance_m": round(float(a["distance"]), 1) if a.get("distance") else None,
        "avg_hr": _int(a.get("averageHR")),
        "avg_power_w": _int(a.get("avgPower")),
        "load": round(min(float(load), 9999.9), 1) if load else None,
        "source": "garmin",
        "external_id": str(a["activityId"]),
    }


def dedupe_multisport(acts: list[dict]) -> int:
    """A triathlon is stored as a parent 'multi_sport' activity plus one row per leg, and each
    leg carries the CUMULATIVE load of the whole event. Keep the parent's load, blank the legs."""
    n = 0
    for p in (a for a in acts if a.get("_type") == "multi_sport"):
        for a in acts:
            if a is p or a.get("_type") == "multi_sport":
                continue
            if p["_start"] <= a["_start"] + timedelta(seconds=60) <= p["_end"] and a["load"] is not None:
                a["load"], n = None, n + 1
    return n


def clean(a: dict) -> dict:
    return {k: v for k, v in a.items() if not k.startswith("_")}


def shape(obj, depth=0, maxdepth=3):
    """Describe the structure of a Garmin answer without printing any values."""
    pad = "  " * depth
    if isinstance(obj, dict):
        for k, v in obj.items():
            print(f"{pad}{k}: {type(v).__name__}")
            if depth < maxdepth and isinstance(v, (dict, list)):
                shape(v, depth + 1, maxdepth)
    elif isinstance(obj, list) and obj:
        print(f"{pad}[0] of {len(obj)}:")
        shape(obj[0], depth + 1, maxdepth)


# ------------------------------------------------------------------- Garmin
def garmin_login():
    from garminconnect import Garmin
    store = os.path.expanduser("~/.garminconnect")
    try:                                   # 1) cached tokens: no password needed
        g = Garmin()
        g.login(store)
        return g
    except Exception as e:
        print(f"No valid cached Garmin session ({type(e).__name__}). Logging in once...")
    email = input("Garmin email: ").strip()
    g = Garmin(email=email, password=getpass.getpass("Garmin password: "),
               prompt_mfa=lambda: input("Garmin MFA code: ").strip())
    g.login(store)
    return g


def fetch(g, days: int, pause: float = 0.8):
    today = date.today()
    start = today - timedelta(days=days - 1)
    rows: dict[str, dict] = {}
    for i in range(days):
        d = (start + timedelta(days=i)).isoformat()
        row: dict = {}
        for fn, mapper in ((g.get_sleep_data, map_sleep), (g.get_hrv_data, map_hrv), (g.get_stats, map_stats)):
            try:
                row.update(mapper(fn(d)))
            except Exception as e:
                print(f"  {d}: {fn.__name__} skipped ({type(e).__name__})")
            time.sleep(pause)
        if row:
            rows[d] = row
    acts = []
    try:
        for a in g.get_activities_by_date(start.isoformat(), today.isoformat()) or []:
            m = map_activity(a)
            if m:
                acts.append(m)
    except Exception as e:
        print(f"  activities skipped ({type(e).__name__}: {e})")
    legs = dedupe_multisport(acts)
    if legs:
        print(f"  multisport: {legs} leg row(s) set to no load (the event is counted once)")
    return rows, [clean(a) for a in acts]


SESSION_FILE = Path.home() / ".apex" / "session.json"


def apex_login(sb, email: str) -> str:
    """Sign in to APEX. After the first password login only a refresh token is cached
    locally (never the password), so scheduled runs need no password."""
    def remember(session):
        SESSION_FILE.parent.mkdir(exist_ok=True)
        SESSION_FILE.write_text(json.dumps({"email": email, "refresh_token": session.refresh_token}))

    if SESSION_FILE.exists():
        try:
            saved = json.loads(SESSION_FILE.read_text())
            if saved.get("email", "").lower() == email.lower():
                res = sb.auth.refresh_session(saved["refresh_token"])
                remember(res.session)
                return res.user.id
        except Exception as e:
            print(f"Cached APEX session not usable ({type(e).__name__}); asking for the password.")
    pw = os.getenv("APEX_PASSWORD") or getpass.getpass("APEX password: ")
    res = sb.auth.sign_in_with_password({"email": email, "password": pw})
    remember(res.session)
    return res.user.id


# -------------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=7, help="how many recent days to sync (default 7)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--probe", metavar="YYYY-MM-DD", help="print the structure of Garmin's answers for a day")
    ap.add_argument("--url", default=os.getenv("SUPABASE_URL"))
    ap.add_argument("--anon-key", default=os.getenv("SUPABASE_ANON_KEY"))
    ap.add_argument("--email", default=os.getenv("APEX_EMAIL"))
    args = ap.parse_args()

    g = garmin_login()

    if args.probe:
        for name, fn in (("sleep", g.get_sleep_data), ("hrv", g.get_hrv_data), ("stats", g.get_stats)):
            print(f"\n=== {name} ===")
            shape(fn(args.probe))
            time.sleep(1)
        print("\n=== activities (that day) ===")
        shape(g.get_activities_by_date(args.probe, args.probe))
        return 0

    rows, acts = fetch(g, args.days)
    print(f"Fetched {len(rows)} day(s) and {len(acts)} activitie(s).")
    for d in sorted(rows)[-3:]:
        print(" ", d, rows[d])
    for a in acts[-3:]:
        print("  activity:", {k: a[k] for k in ("started_at", "sport", "title", "duration_s", "distance_m", "avg_hr", "load")})
    if args.dry_run:
        print("Dry run: nothing uploaded.")
        return 0

    if not (args.url and args.anon_key and args.email):
        raise SystemExit("Missing --url, --anon-key or --email (or use --dry-run / --probe).")
    from supabase import create_client
    sb = create_client(args.url, args.anon_key)
    uid = apex_login(sb, args.email)

    since = min(rows) if rows else date.today().isoformat()
    existing = {r["day"]: r for r in sb.table("daily_metrics").select("day,source," + ",".join(DAY_COLS))
                .gte("day", since).execute().data}
    out = []
    for d, new in rows.items():
        old = existing.get(d, {})
        if old.get("source") == "manual":
            continue                                   # never overwrite what you logged by hand
        merged = {c: new.get(c) if new.get(c) is not None else old.get(c) for c in DAY_COLS}
        out.append({"user_id": uid, "day": d, "source": "garmin", **merged})
    if out:
        sb.table("daily_metrics").upsert(out, on_conflict="user_id,day").execute()
    if acts:
        sb.table("activities").upsert([{"user_id": uid, **a} for a in acts],
                                      on_conflict="user_id,source,external_id").execute()
    print(f"Synced {len(out)} day(s) and {len(acts)} activitie(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
