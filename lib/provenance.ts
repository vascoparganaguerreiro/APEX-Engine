// Field-level provenance for daily measurements. Pure functions, no imports.
// Rule: a value is only overwritten by a source that is allowed to. Manual (or unknown/legacy) values are
// protected from sync; sync values can be replaced by manual entries.

export type Source = "manual" | "intervals";

export interface MetricRow {
  hrv_ms: number | null; rhr_bpm: number | null; sleep_minutes: number | null; sleep_score: number | null;
  hrv_source: string | null; rhr_source: string | null; sleep_source: string | null; sleep_score_source: string | null;
}

export const EMPTY_METRICS: MetricRow = {
  hrv_ms: null, rhr_bpm: null, sleep_minutes: null, sleep_score: null,
  hrv_source: null, rhr_source: null, sleep_source: null, sleep_score_source: null,
};

export interface SyncedWellness { hrv_ms: number | null; rhr_bpm: number | null; sleep_minutes: number | null; sleep_score: number | null }

/** A stored value is protected from sync unless it is known to have come from sync itself.
 *  A value with an unknown/legacy source is treated as manual (the safe side). */
const protectedFromSync = (value: number | null, source: string | null) => value !== null && source !== "intervals";

/** Merge one day of synced wellness into the existing row. Never overwrites protected values,
 *  and never lets an empty synced value erase anything. The sleep score travels with the sleep duration. */
export function mergeSync(existing: MetricRow | null, inc: SyncedWellness): MetricRow {
  const out: MetricRow = { ...(existing ?? EMPTY_METRICS) };
  if (inc.hrv_ms !== null && !protectedFromSync(out.hrv_ms, out.hrv_source)) {
    out.hrv_ms = inc.hrv_ms; out.hrv_source = "intervals";
  }
  if (inc.rhr_bpm !== null && !protectedFromSync(out.rhr_bpm, out.rhr_source)) {
    out.rhr_bpm = inc.rhr_bpm; out.rhr_source = "intervals";
  }
  if (inc.sleep_minutes !== null && !protectedFromSync(out.sleep_minutes, out.sleep_source)) {
    out.sleep_minutes = inc.sleep_minutes; out.sleep_source = "intervals";
    out.sleep_score = inc.sleep_score;                       // null when Intervals has none: never keep an old score
    out.sleep_score_source = inc.sleep_score !== null ? "intervals" : null;
  }
  return out;
}

export const sameMetrics = (a: MetricRow | null, b: MetricRow): boolean =>
  (Object.keys(EMPTY_METRICS) as Array<keyof MetricRow>).every((k) => (a ? a[k] : null) === b[k]);

export interface ManualInput { hrv: string; rhr: string; sleepH: string }
export type ManualResult = { patch: Partial<MetricRow>; error?: undefined } | { error: string; patch?: undefined };

const parse = (s: string): number | null | "bad" => {
  const t = s.trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : "bad";
};

/** Build the columns to write for a manual save. Only fields the user filled in AND that differ from the
 *  saved value are included, so editing one field never touches the others. Changing the sleep duration
 *  clears the (now outdated) sleep score. */
export function buildManualPatch(existing: MetricRow | null, input: ManualInput): ManualResult {
  const patch: Partial<MetricRow> = {};
  const hrv = parse(input.hrv), rhr = parse(input.rhr), sleepH = parse(input.sleepH);
  if (hrv === "bad" || rhr === "bad" || sleepH === "bad") return { error: "Please enter valid numbers." };

  if (hrv !== null) {
    if (hrv <= 0 || hrv > 300) return { error: "HRV must be between 1 and 300 ms." };
    const v = Math.round(hrv * 10) / 10;
    if (existing?.hrv_ms == null || Math.abs(existing.hrv_ms - v) >= 0.05) { patch.hrv_ms = v; patch.hrv_source = "manual"; }
  }
  if (rhr !== null) {
    if (rhr < 20 || rhr > 250) return { error: "Resting HR must be between 20 and 250 bpm." };
    const v = Math.round(rhr);
    if (existing?.rhr_bpm !== v) { patch.rhr_bpm = v; patch.rhr_source = "manual"; }
  }
  if (sleepH !== null) {
    if (sleepH <= 0 || sleepH > 24) return { error: "Sleep must be between 0 and 24 hours." };
    const v = Math.round(sleepH * 60);
    if (existing?.sleep_minutes !== v) {
      patch.sleep_minutes = v; patch.sleep_source = "manual";
      patch.sleep_score = null; patch.sleep_score_source = null;   // the old score described a different night length
    }
  }
  return { patch };
}
