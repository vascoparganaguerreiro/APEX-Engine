// Field-level provenance for daily measurements. Pure functions, no imports.
//
// IMPORTANT: the authoritative implementation of these rules is in Postgres (apply_manual_metrics and
// apply_synced_metrics in 06_metric_provenance.sql), where each call is one atomic statement. The TypeScript
// below (a) decides which fields a manual save sends and (b) mirrors the SQL merge rules so they can be
// unit-tested. Keep the two in step.
//
// Sources: 'manual' and 'intervals' are certain. 'legacy_unknown' marks old values whose origin cannot be
// established; it (like NULL) is treated as protected: sync never overwrites it, only a manual edit can.

export type Source = "manual" | "intervals" | "legacy_unknown";

export interface MetricRow {
  hrv_ms: number | null; rhr_bpm: number | null; sleep_minutes: number | null; sleep_score: number | null;
  hrv_source: string | null; rhr_source: string | null; sleep_source: string | null; sleep_score_source: string | null;
}

export const EMPTY_METRICS: MetricRow = {
  hrv_ms: null, rhr_bpm: null, sleep_minutes: null, sleep_score: null,
  hrv_source: null, rhr_source: null, sleep_source: null, sleep_score_source: null,
};

export interface SyncedWellness { hrv_ms: number | null; rhr_bpm: number | null; sleep_minutes: number | null; sleep_score: number | null }

/** Sync may write a field only when it is empty or was itself written by sync. */
const syncMayWrite = (value: number | null, source: string | null) => value === null || source === "intervals";

/** Mirror of apply_synced_metrics for one day. Nothing protected is overwritten and null never erases a value.
 *  The sleep score is independent measured data with its own provenance: it is not tied to sleep_minutes. */
export function mergeSync(existing: MetricRow | null, inc: SyncedWellness): MetricRow {
  const out: MetricRow = { ...(existing ?? EMPTY_METRICS) };
  const put = (v: keyof SyncedWellness, s: keyof MetricRow) => {
    const val = inc[v];
    if (val !== null && syncMayWrite(out[v], out[s] as string | null)) { out[v] = val; (out as unknown as Record<string, unknown>)[s] = "intervals"; }
  };
  put("hrv_ms", "hrv_source");
  put("rhr_bpm", "rhr_source");
  put("sleep_minutes", "sleep_source");
  put("sleep_score", "sleep_score_source");
  return out;
}

export interface ManualInput { hrv: string; rhr: string; sleepH: string }
/** Values to send to apply_manual_metrics. A key is present only for a field the user filled in AND changed. */
export interface ManualPatch { hrv_ms?: number; rhr_bpm?: number; sleep_minutes?: number }
export type ManualResult = { patch: ManualPatch; error?: undefined } | { error: string; patch?: undefined };

const parse = (s: string): number | null | "bad" => {
  const t = s.trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : "bad";
};

/** Mirror of apply_manual_metrics: manual values always win, and only the changed fields are touched.
 *  The sleep score and its provenance are left alone (a measured score is not deleted by a correction). */
export function applyManual(existing: MetricRow | null, patch: ManualPatch): MetricRow {
  const out: MetricRow = { ...(existing ?? EMPTY_METRICS) };
  if (patch.hrv_ms !== undefined) { out.hrv_ms = patch.hrv_ms; out.hrv_source = "manual"; }
  if (patch.rhr_bpm !== undefined) { out.rhr_bpm = patch.rhr_bpm; out.rhr_source = "manual"; }
  if (patch.sleep_minutes !== undefined) { out.sleep_minutes = patch.sleep_minutes; out.sleep_source = "manual"; }
  return out;
}

export function buildManualPatch(existing: MetricRow | null, input: ManualInput): ManualResult {
  const patch: ManualPatch = {};
  const hrv = parse(input.hrv), rhr = parse(input.rhr), sleepH = parse(input.sleepH);
  if (hrv === "bad" || rhr === "bad" || sleepH === "bad") return { error: "Please enter valid numbers." };

  if (hrv !== null) {
    if (hrv <= 0 || hrv > 300) return { error: "HRV must be between 1 and 300 ms." };
    const v = Math.round(hrv * 10) / 10;
    if (existing?.hrv_ms == null || Math.abs(existing.hrv_ms - v) >= 0.05) patch.hrv_ms = v;
  }
  if (rhr !== null) {
    if (rhr < 20 || rhr > 250) return { error: "Resting HR must be between 20 and 250 bpm." };
    const v = Math.round(rhr);
    if (existing?.rhr_bpm !== v) patch.rhr_bpm = v;
  }
  if (sleepH !== null) {
    if (sleepH <= 0 || sleepH > 24) return { error: "Sleep must be between 0 and 24 hours." };
    const v = Math.round(sleepH * 60);
    if (existing?.sleep_minutes !== v) patch.sleep_minutes = v;
  }
  return { patch };
}
