// Provider-independent normalisation. Pure functions, no I/O.
//
// One Observation = one value of one metric from one source record. Two separate labels:
//   provider  = where it was measured (garmin, whoop, ... or "unknown" when the transport does not say)
//   transport = how it reached APEX (direct, intervals, manual, companion_app, file)
// Physiological measurements share a metric name across vendors (hrv_rmssd_ms is rMSSD in ms whoever measured it).
// Vendor scores are NAMESPACED (whoop.recovery_score, intervals.readiness) so they are never compared, averaged or merged with
// another vendor's score. HRV SDNN (Apple) and rMSSD (most others) are different metrics.
import type { Origin, Transport } from "./providers.ts";

export type MetricKind = "measurement" | "vendor_score";
export interface MetricDef { unit: string; kind: MetricKind; min: number; max: number; label: string }

export const METRICS = {
  hrv_rmssd_ms: { unit: "ms", kind: "measurement", min: 1, max: 300, label: "HRV (rMSSD)" },
  hrv_sdnn_ms: { unit: "ms", kind: "measurement", min: 1, max: 300, label: "HRV (SDNN)" },
  resting_hr_bpm: { unit: "bpm", kind: "measurement", min: 20, max: 250, label: "Resting heart rate" },
  sleep_minutes: { unit: "min", kind: "measurement", min: 1, max: 1440, label: "Sleep duration" },
  sleep_avg_hr_bpm: { unit: "bpm", kind: "measurement", min: 20, max: 250, label: "Average sleeping heart rate" },
  respiratory_rate_bpm: { unit: "breaths/min", kind: "measurement", min: 4, max: 60, label: "Respiratory rate" },
  spo2_pct: { unit: "%", kind: "measurement", min: 50, max: 100, label: "Blood oxygen" },
  skin_temp_c: { unit: "°C", kind: "measurement", min: 20, max: 45, label: "Skin temperature" },
  vo2max: { unit: "ml/kg/min", kind: "measurement", min: 10, max: 95, label: "VO2 max" },
  steps: { unit: "steps", kind: "measurement", min: 0, max: 200_000, label: "Steps" },
  weight_kg: { unit: "kg", kind: "measurement", min: 20, max: 400, label: "Body weight" },
  body_fat_pct: { unit: "%", kind: "measurement", min: 2, max: 75, label: "Body fat" },
  height_cm: { unit: "cm", kind: "measurement", min: 80, max: 250, label: "Height" },
  max_hr_bpm: { unit: "bpm", kind: "measurement", min: 100, max: 250, label: "Maximum heart rate" },
  energy_kj: { unit: "kJ", kind: "measurement", min: 0, max: 100_000, label: "Energy expenditure" },
  avg_hr_bpm: { unit: "bpm", kind: "measurement", min: 20, max: 250, label: "Average heart rate" },
  distance_m: { unit: "m", kind: "measurement", min: 0, max: 1_000_000, label: "Distance" },
  // Vendor-specific scores: never compared across vendors.
  "whoop.recovery_score": { unit: "%", kind: "vendor_score", min: 0, max: 100, label: "WHOOP Recovery" },
  "whoop.day_strain": { unit: "WHOOP strain", kind: "vendor_score", min: 0, max: 21, label: "WHOOP day strain" },
  "whoop.workout_strain": { unit: "WHOOP strain", kind: "vendor_score", min: 0, max: 21, label: "WHOOP workout strain" },
  "whoop.sleep_performance_pct": { unit: "%", kind: "vendor_score", min: 0, max: 100, label: "WHOOP sleep performance" },
  "whoop.sleep_efficiency_pct": { unit: "%", kind: "vendor_score", min: 0, max: 100, label: "WHOOP sleep efficiency" },
  "whoop.sleep_consistency_pct": { unit: "%", kind: "vendor_score", min: 0, max: 100, label: "WHOOP sleep consistency" },
  // Intervals.icu wellness scores: the vendor that produced them is not reported, so they stay under "intervals".
  "intervals.readiness": { unit: "score", kind: "vendor_score", min: 0, max: 1000, label: "Readiness reported to Intervals.icu (vendor not reported)" },
  "intervals.sleep_score": { unit: "score", kind: "vendor_score", min: 0, max: 100, label: "Sleep score reported to Intervals.icu (vendor not reported)" },
} as const satisfies Record<string, MetricDef>;
export type MetricName = keyof typeof METRICS;
export const isMetric = (m: unknown): m is MetricName => typeof m === "string" && Object.prototype.hasOwnProperty.call(METRICS, m);

/** ok = measured value with a known origin; origin_unknown = the transport did not say who measured it; approximate_day = the local
 *  day was derived without the record's own time zone; pending = the vendor has not finished scoring the record. */
export type Quality = "ok" | "origin_unknown" | "approximate_day" | "pending";

export interface Observation {
  provider: Origin; transport: Transport; source_record_id: string; metric: MetricName; value: number; unit: string;
  measured_at: string; local_day: string | null; quality: Quality; vendor_state: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Build a validated observation, or null. Out-of-range, non-finite or undated values are dropped, never clamped or guessed. */
export function makeObservation(o: { provider: Origin; transport: Transport; source_record_id: unknown; metric: MetricName; value: unknown; measured_at: unknown; local_day?: string | null; quality?: Quality; vendor_state?: string | null }): Observation | null {
  const def: MetricDef = METRICS[o.metric];
  if (!def || typeof o.value !== "number" || !Number.isFinite(o.value) || o.value < def.min || o.value > def.max) return null;
  const id = typeof o.source_record_id === "string" || typeof o.source_record_id === "number" ? String(o.source_record_id).slice(0, 200) : "";
  if (!id) return null;
  const ms = typeof o.measured_at === "string" ? Date.parse(o.measured_at) : NaN;
  if (Number.isNaN(ms)) return null;
  const day = o.local_day ?? null;
  if (day !== null && !DAY.test(day)) return null;
  return {
    provider: o.provider, transport: o.transport, source_record_id: id, metric: o.metric, value: Math.round(o.value * 1000) / 1000, unit: def.unit,
    measured_at: new Date(ms).toISOString(), local_day: day, quality: o.quality ?? (o.provider === "unknown" ? "origin_unknown" : "ok"), vendor_state: o.vendor_state ?? null,
  };
}

/** Collapse duplicates of the same (provider, transport, record, metric): the last one wins (a re-score of the same record). */
export function dedupeObservations(list: Observation[]): Observation[] {
  const m = new Map<string, Observation>();
  for (const o of list) m.set(`${o.provider}|${o.transport}|${o.source_record_id}|${o.metric}`, o);
  return [...m.values()];
}

// ------------------------------------------------------------------ dates
/** Local calendar day of an instant, for an offset like "+01:00" / "-0530" / "Z". Null when the offset is unreadable. */
export function localDayFromOffset(iso: string, offset: unknown): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms) || typeof offset !== "string") return null;
  const m = /^(Z)$|^([+-])(\d{2}):?(\d{2})$/.exec(offset.trim());
  if (!m) return null;
  const mins = m[1] ? 0 : (m[2] === "-" ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4]));
  if (Math.abs(mins) > 14 * 60) return null;
  return new Date(ms + mins * 60_000).toISOString().slice(0, 10);
}

/** Local calendar day of an instant in an IANA time zone. Null for an unknown zone. */
export function localDayInZone(iso: string, tz: unknown): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms) || typeof tz !== "string" || !tz) return null;
  try { return new Date(ms).toLocaleDateString("sv-SE", { timeZone: tz }); } catch { return null; }
}

function tzOffsetMinutes(utcMs: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(utcMs)).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - utcMs) / 60_000;
}

/** A wall-clock time without zone ("2026-03-29T08:30:00") in an IANA zone -> UTC ISO (DST-aware). Null if either part is unusable. */
export function localToUtc(local: unknown, tz: unknown): string | null {
  if (typeof local !== "string" || typeof tz !== "string" || !tz) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(local.trim());
  if (!m) return null;
  try {
    const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
    const off1 = tzOffsetMinutes(guess, tz);
    let utc = guess - off1 * 60_000;
    const off2 = tzOffsetMinutes(utc, tz);
    if (off2 !== off1) utc = guess - off2 * 60_000;
    return new Date(utc).toISOString();
  } catch { return null; }
}

// ------------------------------------------------------------------ freshness
export type Freshness = "fresh" | "stale" | "missing";
/** Daily wellness older than 36 h is stale; activities are judged by the caller. */
export function freshness(latestIso: string | null, now: Date, maxAgeHours = 36): Freshness {
  if (!latestIso) return "missing";
  const ms = Date.parse(latestIso.length === 10 ? `${latestIso}T23:59:59Z` : latestIso);
  if (Number.isNaN(ms)) return "missing";
  return now.getTime() - ms > maxAgeHours * 3_600_000 ? "stale" : "fresh";
}

// ------------------------------------------------------------------ daily_metrics fill (mirror of apply_provider_daily_metrics in 14)
export type DailySource = "manual" | "intervals" | "legacy_unknown" | "whoop";
export interface DailyFields { hrv_ms: number | null; rhr_bpm: number | null; sleep_minutes: number | null; hrv_source: string | null; rhr_source: string | null; sleep_source: string | null }
export interface DailyIncoming { hrv_ms: number | null; rhr_bpm: number | null; sleep_minutes: number | null }

/** A provider may write a daily field only when it is empty or was written by that same provider. Manual, legacy_unknown and any
 *  other provider's value are kept. Null never erases. The sleep score is never touched (vendor scores are not interchangeable). */
export function mergeProviderDaily(existing: DailyFields | null, provider: Exclude<DailySource, "manual" | "legacy_unknown">, inc: DailyIncoming): DailyFields {
  const out: DailyFields = { ...(existing ?? { hrv_ms: null, rhr_bpm: null, sleep_minutes: null, hrv_source: null, rhr_source: null, sleep_source: null }) };
  const put = (v: keyof DailyIncoming, s: "hrv_source" | "rhr_source" | "sleep_source") => {
    if (inc[v] !== null && (out[v] === null || out[s] === provider)) { out[v] = inc[v]; out[s] = provider; }
  };
  put("hrv_ms", "hrv_source"); put("rhr_bpm", "rhr_source"); put("sleep_minutes", "sleep_source");
  return out;
}

/** The daily values a set of observations can fill, per local day. Only rMSSD HRV is used (SDNN is a different measure). */
export function dailyFromObservations(obs: Observation[]): Array<DailyIncoming & { day: string }> {
  const by = new Map<string, DailyIncoming & { day: string }>();
  for (const o of obs) {
    if (!o.local_day || o.quality === "pending" || o.quality === "approximate_day") continue;
    const d = by.get(o.local_day) ?? { day: o.local_day, hrv_ms: null, rhr_bpm: null, sleep_minutes: null };
    if (o.metric === "hrv_rmssd_ms") d.hrv_ms = Math.round(o.value * 10) / 10;
    else if (o.metric === "resting_hr_bpm") d.rhr_bpm = Math.round(o.value);
    else if (o.metric === "sleep_minutes") d.sleep_minutes = Math.round(o.value);
    else continue;
    by.set(o.local_day, d);
  }
  return [...by.values()].filter((d) => d.hrv_ms !== null || d.rhr_bpm !== null || d.sleep_minutes !== null).sort((a, b) => a.day.localeCompare(b.day));
}
