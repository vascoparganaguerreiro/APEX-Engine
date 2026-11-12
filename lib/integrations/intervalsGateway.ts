// Intervals.icu as a universal gateway. Pure mapping + a small resilient HTTP layer (fetch is injected, so it is fully testable).
//
// Verified against the official OpenAPI spec (https://intervals.icu/api/v1/docs, 2026-11-12):
//   * GET /athlete/{id}/activities?oldest&newest  (no "updated since" filter; no offset paging)  -> we read bounded DATE WINDOWS
//   * GET /athlete/{id}/wellness?oldest&newest
//   * Activity.source enum: STRAVA, UPLOAD, MANUAL, GARMIN_CONNECT, OAUTH_CLIENT, DROPBOX, POLAR, SUUNTO, COROS, WAHOO, ZWIFT, ZEPP,
//     CONCEPT2, HUAWEI; Activity.device_name, timezone, start_date (UTC), start_date_local.
//   * Wellness has NO source field: the device/vendor behind a wellness value is unknown and is recorded as provider "unknown".
//   * Strava-sourced activities are not available through the API (Strava terms); such stubs carry no measurements and are skipped.
//   * Rate limits: 429 with Retry-After.
import { IntervalsError, INTERVALS_BASE, mapActivity, mapActivityExtras, mapWellness, type ActivityExtras, type ActivityRow, type WellnessRow } from "../intervals.ts";
import { localToUtc, makeObservation, type MetricName, type Observation } from "./normalize.ts";

export type IntervalsAuth = { kind: "key"; apiKey: string } | { kind: "bearer"; token: string };
export const authorization = (a: IntervalsAuth) => a.kind === "key" ? `Basic ${Buffer.from(`API_KEY:${a.apiKey}`).toString("base64")}` : `Bearer ${a.token}`;

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

export const MAX_DAYS = 180, FIRST_SYNC_DAYS = 120, OVERLAP_DAYS = 3, WINDOW_DAYS = 31;

/** Which range to read. An explicit request (1-180 days) wins. Otherwise: incremental from the last SUCCESSFUL sync minus an overlap
 *  (Intervals has no "updated since" filter, and wellness/activities are often edited or re-analysed a day or two later); the first
 *  sync reads FIRST_SYNC_DAYS. The range never exceeds MAX_DAYS. */
export function syncRange(today: string, o: { requestedDays?: number | null; lastSuccessAt?: string | null }): { oldest: string; newest: string; incremental: boolean } {
  const t = dayMs(today);
  if (o.requestedDays) {
    const days = Math.min(MAX_DAYS, Math.max(1, Math.floor(o.requestedDays)));
    return { oldest: isoDay(t - days * DAY_MS), newest: today, incremental: false };
  }
  const last = o.lastSuccessAt ? Date.parse(o.lastSuccessAt) : NaN;
  if (Number.isNaN(last)) return { oldest: isoDay(t - FIRST_SYNC_DAYS * DAY_MS), newest: today, incremental: false };
  const from = Math.max(t - MAX_DAYS * DAY_MS, dayMs(isoDay(last)) - OVERLAP_DAYS * DAY_MS);
  return { oldest: isoDay(Math.min(from, t)), newest: today, incremental: true };
}

/** Split [oldest, newest] (inclusive days) into consecutive windows of at most `size` days. */
export function dateWindows(oldest: string, newest: string, size = WINDOW_DAYS): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let s = dayMs(oldest), end = dayMs(newest); s <= end; s += size * DAY_MS) out.push([isoDay(s), isoDay(Math.min(end, s + (size - 1) * DAY_MS))]);
  return out;
}

export interface HttpDeps { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** GET a JSON list with one retry for 429 (honouring Retry-After up to 10 s) and one for 5xx / network errors. */
export async function getList(path: string, auth: IntervalsAuth, deps: HttpDeps = {}): Promise<Record<string, unknown>[]> {
  const f = deps.fetchImpl ?? fetch, sleep = deps.sleep ?? realSleep;
  for (let attempt = 0; ; attempt++) {
    let r: Response | null = null;
    try { r = await f(`${INTERVALS_BASE}${path}`, { headers: { Authorization: authorization(auth), Accept: "application/json" } }); }
    catch { if (attempt === 0) { await sleep(1000); continue; } throw new IntervalsError(502, "Could not reach Intervals.icu."); }
    if (r.status === 401 || r.status === 403) throw new IntervalsError(401, "Intervals.icu rejected the saved credentials. Reconnect.");
    if (r.status === 429) {
      const wait = Math.max(1, Number(r.headers.get("retry-after")) || 0);
      if (attempt === 0 && wait <= 10) { await sleep(wait * 1000); continue; }
      throw Object.assign(new IntervalsError(429, "Intervals.icu rate limit reached. Try again shortly."), { retryAfterS: wait });
    }
    if (r.status >= 500 && attempt === 0) { await sleep(1000); continue; }
    if (!r.ok) throw new IntervalsError(502, `Intervals.icu answered ${r.status}.`);
    const j = await r.json().catch(() => null);
    return Array.isArray(j) ? (j as Record<string, unknown>[]) : [];
  }
}

/** True for the placeholder Intervals returns for Strava-sourced activities: no duration, distance or load to import. */
export function isStravaStub(a: Record<string, unknown>): boolean {
  const has = (k: string) => typeof a[k] === "number" && (a[k] as number) > 0;
  return String(a.source ?? "").toUpperCase() === "STRAVA" && !has("moving_time") && !has("elapsed_time") && !has("distance") && !has("icu_training_load");
}

/** mapActivity with correct time handling: start_date is UTC; when only start_date_local exists it is converted with the activity's
 *  own IANA `timezone` (DST-aware). Without either, the activity is skipped instead of being stored at a guessed time. */
export function mapActivityTz(a: Record<string, unknown>): (ActivityRow & ActivityExtras) | null {
  let fixed = a;
  if (typeof a.start_date !== "string" || Number.isNaN(Date.parse(a.start_date))) {
    const utc = localToUtc(a.start_date_local, a.timezone);
    if (!utc) return null;
    fixed = { ...a, start_date: utc };
  }
  const row = mapActivity(fixed);
  return row ? { ...row, ...mapActivityExtras(a) } : null;
}

const WELLNESS_FIELDS: Array<[string, MetricName]> = [
  ["hrv", "hrv_rmssd_ms"], ["hrvSDNN", "hrv_sdnn_ms"], ["restingHR", "resting_hr_bpm"], ["avgSleepingHR", "sleep_avg_hr_bpm"],
  ["spO2", "spo2_pct"], ["respiration", "respiratory_rate_bpm"], ["vo2max", "vo2max"], ["steps", "steps"], ["weight", "weight_kg"],
  ["bodyFat", "body_fat_pct"], ["readiness", "intervals.readiness"], ["sleepScore", "intervals.sleep_score"],
];

/** Every useful wellness field as observations. provider = "unknown" because Intervals does not report which device measured it.
 *  Values Intervals marks as temporary (tempWeight / tempRestingHR) are skipped. */
export function wellnessObservations(w: Record<string, unknown>): Observation[] {
  const day = typeof w.id === "string" ? w.id.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  const at = typeof w.updated === "string" && !Number.isNaN(Date.parse(w.updated)) ? w.updated : `${day}T12:00:00Z`;
  const out: Observation[] = [];
  for (const [field, metric] of WELLNESS_FIELDS) {
    if ((field === "weight" && w.tempWeight === true) || (field === "restingHR" && w.tempRestingHR === true)) continue;
    const o = makeObservation({ provider: "unknown", transport: "intervals", source_record_id: `wellness:${day}`, metric, value: w[field], measured_at: at, local_day: day });
    if (o) out.push(o);
  }
  if (typeof w.sleepSecs === "number") {
    const o = makeObservation({ provider: "unknown", transport: "intervals", source_record_id: `wellness:${day}`, metric: "sleep_minutes", value: Math.round(w.sleepSecs / 60), measured_at: at, local_day: day });
    if (o) out.push(o);
  }
  return out;
}

export interface GatewayResult {
  wellness: WellnessRow[]; observations: Observation[]; activities: Array<ActivityRow & ActivityExtras>;
  skippedStrava: number; skippedNoTime: number; windows: number; latestWellnessDay: string | null;
}

/** Read a range window by window. A failure in any window aborts the run (the cursor is not advanced, so nothing is lost). */
export async function readRange(athleteId: string, auth: IntervalsAuth, oldest: string, newest: string, deps: HttpDeps = {}): Promise<GatewayResult> {
  const res: GatewayResult = { wellness: [], observations: [], activities: [], skippedStrava: 0, skippedNoTime: 0, windows: 0, latestWellnessDay: null };
  const seen = new Set<string>();
  for (const [a, b] of dateWindows(oldest, newest)) {
    res.windows++;
    const [wl, al] = await Promise.all([
      getList(`/athlete/${athleteId}/wellness?oldest=${a}&newest=${b}`, auth, deps),
      getList(`/athlete/${athleteId}/activities?oldest=${a}T00:00:00&newest=${b}T23:59:59`, auth, deps),   // local date-times, whole days
    ]);
    for (const w of wl) {
      const m = mapWellness(w);
      if (m) { res.wellness.push(m); if (!res.latestWellnessDay || m.day > res.latestWellnessDay) res.latestWellnessDay = m.day; }
      res.observations.push(...wellnessObservations(w));
    }
    for (const raw of al) {
      const id = String(raw.id ?? "");
      if (seen.has(id)) continue;                              // an activity near a window boundary is counted and imported once
      seen.add(id);
      if (isStravaStub(raw)) { res.skippedStrava++; continue; }
      const row = mapActivityTz(raw);
      if (!row) { res.skippedNoTime++; continue; }
      res.activities.push(row);
    }
  }
  return res;
}
