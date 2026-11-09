"""APEX engine: pure functions (no Streamlit, no database) so they are easy to test."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from statistics import mean, pstdev
from typing import Optional, Sequence


def _clip(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _clean(values: Sequence[Optional[float]]) -> list[float]:
    return [float(v) for v in values if v is not None]


@dataclass(frozen=True)
class Readiness:
    score: int           # 0-100
    verdict: str         # "PUSH" | "HOLD" | "RECOVER"
    hrv_z: Optional[float]
    baseline_days: int   # how many prior HRV days the baseline is built on


def hrv_baseline(prior: Sequence[Optional[float]]) -> Optional[tuple[float, float]]:
    """Mean and SD of prior HRV days. Needs at least 3 days; SD has a 5% floor."""
    vals = _clean(prior)
    if len(vals) < 3:
        return None
    m = mean(vals)
    return m, max(pstdev(vals), 0.05 * m)


def readiness(
    hrv: Optional[float],
    rhr: Optional[float],
    sleep_h: Optional[float],
    hrv_prior: Sequence[Optional[float]] = (),
    rhr_prior: Sequence[Optional[float]] = (),
    sleep_goal_h: float = 8.0,
) -> Optional[Readiness]:
    """Weighted 0-100 readiness score from HRV (45%), resting HR (25%) and sleep (30%).
    Missing inputs are skipped and the remaining weights are renormalised."""
    parts: list[tuple[float, float]] = []  # (weight, component score 0-100)
    z: Optional[float] = None

    if hrv is not None:
        base = hrv_baseline(hrv_prior)
        if base:
            z = (float(hrv) - base[0]) / base[1]
            parts.append((0.45, (_clip(z, -2, 2) + 2) / 4 * 100))
        else:
            parts.append((0.45, 50.0))  # baseline still building: neutral

    if rhr is not None:
        prior = _clean(rhr_prior)
        if len(prior) >= 3:
            delta = mean(prior) - float(rhr)  # lower RHR than usual is good
            parts.append((0.25, (_clip(delta, -8, 8) + 8) / 16 * 100))
        else:
            parts.append((0.25, 50.0))

    if sleep_h is not None and sleep_goal_h > 0:
        parts.append((0.30, _clip(float(sleep_h) / sleep_goal_h, 0, 1) * 100))

    if not parts:
        return None

    total_w = sum(w for w, _ in parts)
    score = round(sum(w * s for w, s in parts) / total_w)
    verdict = "PUSH" if score >= 70 else "HOLD" if score >= 45 else "RECOVER"
    return Readiness(score, verdict, z, len(_clean(hrv_prior)))


TAPER_DAYS = {
    "10k": 5, "half_marathon": 10, "marathon": 18, "trail": 14,
    "triathlon_sprint": 5, "triathlon_olympic": 8, "half_ironman": 12,
    "ironman": 18, "cycling": 8, "other": 10,
}


def race_phase(days_to_race: int, race_type: str) -> str:
    """Coarse training phase from the time left to the race."""
    if days_to_race < 0:
        return "Completed"
    if days_to_race == 0:
        return "Race day"
    taper = TAPER_DAYS.get(race_type, 10)
    if days_to_race <= taper:
        return "Taper"
    if days_to_race <= taper + 14:
        return "Peak load"
    if days_to_race <= 84:
        return "Build"
    return "Base"


def banister(
    loads: Sequence[float],
    ctl0: float = 0.0,
    atl0: float = 0.0,
    ctl_tau: float = 42.0,
    atl_tau: float = 7.0,
) -> list[tuple[float, float, float]]:
    """Banister impulse-response load model. One (CTL, ATL, TSB) tuple per day."""
    ctl, atl = ctl0, atl0
    out = []
    for load in loads:
        ctl += (load - ctl) / ctl_tau
        atl += (load - atl) / atl_tau
        out.append((ctl, atl, ctl - atl))
    return out


def estimate_load(duration_min: float, rpe: int) -> float:
    """Session-RPE load, scaled so that 1 hour at RPE 6 is about 60."""
    return round(duration_min * rpe / 6, 1)


def tsb_state(tsb: float) -> str:
    if tsb > 25:
        return "Detraining risk"
    if tsb >= 5:
        return "Peak form window"
    if tsb >= -10:
        return "Productive training"
    if tsb >= -30:
        return "Elevated fatigue"
    return "Overtraining risk"


def load_series(daily: dict[date, float], start: date, end: date):
    """(day, load, CTL, ATL, TSB) for every day from start to end; rest days count as 0."""
    days, d = [], start
    while d <= end:
        days.append(d)
        d += timedelta(days=1)
    vals = banister([daily.get(x, 0.0) for x in days])
    return [(x, daily.get(x, 0.0), c, a, t) for x, (c, a, t) in zip(days, vals)]


def project_tsb(
    ctl: float,
    atl: float,
    days_to_race: int,
    avg_load: float,
    taper_days: int = 0,
    taper_factor: float = 0.5,
    ctl_tau: float = 42.0,
    atl_tau: float = 7.0,
) -> float:
    """Form (TSB) on race morning if you train at avg_load until then; the last
    taper_days run at avg_load * taper_factor."""
    n = max(days_to_race - 1, 0)
    for i in range(n):
        load = avg_load * taper_factor if (n - i) <= taper_days else avg_load
        ctl += (load - ctl) / ctl_tau
        atl += (load - atl) / atl_tau
    return ctl - atl
