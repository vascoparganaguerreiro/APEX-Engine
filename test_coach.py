from datetime import date

import coach
import engine


def test_context_has_key_facts():
    res = engine.readiness(68, 52, 7.6, [60] * 10, [50] * 10)
    ctx = coach.build_context(
        date(2026, 11, 9), {"weight_kg": 78, "max_hr": 196},
        [{"day": "2026-11-09", "hrv_ms": 68, "rhr_bpm": 52, "sleep_minutes": 459, "sleep_score": 74,
          "body_battery": 63, "stress_avg": 22}],
        [{"day": "2026-11-08", "sport": "bike", "minutes": 186, "load": 92.9, "title": "Ride"}],
        (73, 49, 24, "Peak form window"), res,
        {"name": "10K", "race_type": "10k", "race_date": "2026-12-13", "days": 34, "phase": "Build",
         "priority": "A", "goal": "sub 41", "keep": 11, "taper": 22, "taper_days": 5})
    for text in ("HRV 68 ms", "CTL (42-day fitness) 73", "10K", "sub 41", "bike 186 min"):
        assert text in ctx


def test_context_handles_missing_data():
    ctx = coach.build_context(date(2026, 11, 9), {}, [], [], None, None, None)
    assert "(no daily data)" in ctx and "(no upcoming race)" in ctx
