// WHOOP Developer API v2 client and mappers. fetch is injected: every rule here is tested with mocked responses.
// Verified against https://developer.whoop.com (2026-11-12):
//   OAuth  authorize https://api.prod.whoop.com/oauth/oauth2/auth   token https://api.prod.whoop.com/oauth/oauth2/token
//          `offline` scope is required for a refresh token; refreshing rotates the pair; access tokens last 3600 s;
//          a self-generated state must be 8 characters.
//   API    https://api.prod.whoop.com/developer  /v2/cycle, /v2/recovery, /v2/activity/sleep, /v2/activity/workout,
//          /v2/user/measurement/body, DELETE /v2/user/access (revoke).  Collections: limit <= 25, start (inclusive), end (exclusive),
//          nextToken.  score_state: SCORED | PENDING_SCORE | UNSCORABLE (score present only when SCORED).
//   Limits 100 requests/min and 10,000/day per app; 429 with X-RateLimit-Reset (seconds).
// Nothing here logs tokens or health values.
import { OAuthError, parseTokenResponse, postToken, type OAuthConfig, type TokenSet } from "./oauth.ts";
import { dedupeObservations, localDayFromOffset, makeObservation, type Observation } from "./normalize.ts";

export const WHOOP_AUTHORIZE = "https://api.prod.whoop.com/oauth/oauth2/auth";
export const WHOOP_TOKEN = "https://api.prod.whoop.com/oauth/oauth2/token";
export const WHOOP_API = "https://api.prod.whoop.com/developer";
/** Only what APEX uses. read:profile (name, e-mail) is deliberately NOT requested. */
export const WHOOP_SCOPES = ["read:recovery", "read:cycles", "read:sleep", "read:workout", "read:body_measurement", "offline"] as const;
export const FIRST_SYNC_DAYS = 90, OVERLAP_DAYS = 3, MAX_PAGES = 40;

export function whoopConfig(env: Record<string, string | undefined>): OAuthConfig | null {
  const clientId = env.WHOOP_CLIENT_ID?.trim(), clientSecret = env.WHOOP_CLIENT_SECRET?.trim(), redirectUri = env.WHOOP_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { provider: "whoop", authorizeUrl: WHOOP_AUTHORIZE, tokenUrl: WHOOP_TOKEN, clientId, clientSecret, redirectUri, scopes: WHOOP_SCOPES, scopeSeparator: " ", stateLength: 8 };
}

export async function exchangeCode(c: OAuthConfig, code: string, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<TokenSet> {
  if (!/^[\w.~-]{4,2048}$/.test(code)) throw new OAuthError(400, "bad_code", "The authorization response was malformed.");
  const j = await postToken(c.tokenUrl, { grant_type: "authorization_code", code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: c.redirectUri }, fetchImpl);
  return parseTokenResponse(j, now, " ");
}

export async function refreshTokens(c: OAuthConfig, refreshToken: string, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<TokenSet> {
  const j = await postToken(c.tokenUrl, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: c.clientId, client_secret: c.clientSecret, scope: "offline" }, fetchImpl);
  return parseTokenResponse(j, now, " ");
}

export class WhoopError extends Error {
  status: number; retryAt: string | null; reauth: boolean;
  constructor(status: number, message: string, o: { retryAt?: string | null; reauth?: boolean } = {}) { super(message); this.name = "WhoopError"; this.status = status; this.retryAt = o.retryAt ?? null; this.reauth = !!o.reauth; }
}

export interface Deps { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => Date }
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function getJson(path: string, token: string, deps: Deps): Promise<Record<string, unknown>> {
  const f = deps.fetchImpl ?? fetch, sleep = deps.sleep ?? realSleep, now = deps.now ?? (() => new Date());
  for (let attempt = 0; ; attempt++) {
    let r: Response | null = null;
    try { r = await f(`${WHOOP_API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }); }
    catch { if (attempt === 0) { await sleep(1000); continue; } throw new WhoopError(502, "Could not reach WHOOP."); }
    if (r.status === 401) throw new WhoopError(401, "WHOOP access expired or was revoked. Connect again.", { reauth: true });
    if (r.status === 403) throw new WhoopError(403, "WHOOP did not grant access to this data. Connect again and allow every requested permission.", { reauth: true });
    if (r.status === 429) {
      const reset = Math.max(1, Number(r.headers.get("x-ratelimit-reset")) || 60);
      if (attempt === 0 && reset <= 10) { await sleep(reset * 1000); continue; }
      throw new WhoopError(429, "WHOOP's rate limit was reached. The sync will continue later.", { retryAt: new Date(now().getTime() + reset * 1000).toISOString() });
    }
    if (r.status >= 500 && attempt === 0) { await sleep(1000); continue; }
    if (r.status === 404) return {};
    if (!r.ok) throw new WhoopError(502, `WHOOP answered ${r.status}.`);
    const j = await r.json().catch(() => null);
    return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
  }
}

/** All records of a collection between start (inclusive) and end (exclusive), following nextToken. Bounded by MAX_PAGES. */
export async function collect(path: string, token: string, startIso: string, endIso: string, deps: Deps = {}): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let next: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ limit: "25", start: startIso, end: endIso });
    if (next) q.set("nextToken", next);
    const j = await getJson(`${path}?${q}`, token, deps);
    const recs = Array.isArray(j.records) ? (j.records as Record<string, unknown>[]) : [];
    out.push(...recs);
    const n = typeof j.next_token === "string" ? j.next_token : typeof j.nextToken === "string" ? j.nextToken : null;
    if (!n || recs.length === 0) return out;
    next = n;
  }
  throw new WhoopError(502, "WHOOP returned more pages than expected; try a shorter range.");
}

export async function revoke(token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try { const r = await fetchImpl(`${WHOOP_API}/v2/user/access`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }); return r.ok || r.status === 401 || r.status === 404; }
  catch { return false; }
}

/** Range to read: incremental from the last success minus an overlap (WHOOP re-scores pending records), else the first-sync window. */
export function whoopRange(now: Date, lastSuccessAt: string | null): { start: string; end: string } {
  const last = lastSuccessAt ? Date.parse(lastSuccessAt) : NaN;
  const from = Number.isNaN(last) ? now.getTime() - FIRST_SYNC_DAYS * 86_400_000 : Math.max(now.getTime() - 365 * 86_400_000, last - OVERLAP_DAYS * 86_400_000);
  return { start: new Date(from).toISOString(), end: new Date(now.getTime() + 60_000).toISOString() };
}

// ------------------------------------------------------------------ mapping
type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const state = (r: Rec) => (typeof r.score_state === "string" ? r.score_state : null);
const scored = (r: Rec) => state(r) === "SCORED";

export interface WhoopActivity { external_id: string; started_at: string; sport: string; title: string | null; duration_s: number | null; distance_m: number | null; avg_hr: number | null; max_hr: number | null; calories: number | null }
export interface WhoopBatch { observations: Observation[]; workouts: WhoopActivity[]; pending: number; unscorable: number }

function sportOf(name: string): string {
  if (/run/i.test(name)) return "run";
  if (/swim/i.test(name)) return "swim";
  if (/cycl|bik|spin/i.test(name)) return "bike";
  if (/weight|strength|functional|powerlift|crossfit/i.test(name)) return "strength";
  return "other";
}

/** Map the raw collections into observations (and workouts for the optional activity import). Only SCORED records produce values:
 *  pending and unscorable records are counted, never guessed. Recovery is dated by the local END of its sleep (the morning it
 *  describes); without that sleep it falls back to the cycle start with quality approximate_day, which never fills daily fields. */
export function mapWhoop(raw: { cycles: Rec[]; recoveries: Rec[]; sleeps: Rec[]; workouts: Rec[]; body?: Rec | null }, now: Date): WhoopBatch {
  const obs: Observation[] = [];
  let pending = 0, unscorable = 0;
  const count = (r: Rec) => { if (state(r) === "PENDING_SCORE") pending++; else if (state(r) === "UNSCORABLE") unscorable++; };
  const push = (o: Observation | null) => { if (o) obs.push(o); };
  const cycles = new Map(raw.cycles.map((c) => [str(c.id), c]));
  const sleeps = new Map(raw.sleeps.map((s) => [str(s.id), s]));

  for (const r of raw.recoveries) {
    if (!scored(r)) { count(r); continue; }
    const s = obj(r.score), sl = sleeps.get(str(r.sleep_id)), cy = cycles.get(str(r.cycle_id));
    let at = "", day: string | null = null, quality: "ok" | "approximate_day" = "ok";
    if (sl && typeof sl.end === "string") { at = sl.end; day = localDayFromOffset(sl.end, sl.timezone_offset); }
    else if (cy && typeof cy.start === "string") { at = cy.start; day = localDayFromOffset(cy.start, cy.timezone_offset); quality = "approximate_day"; }
    if (!at || !day) continue;
    if (s.user_calibrating === true) quality = "approximate_day";      // WHOOP is still learning the baseline: keep, but do not fill daily
    const id = `recovery:${str(r.cycle_id)}`;
    const base = { provider: "whoop" as const, transport: "direct" as const, source_record_id: id, measured_at: at, local_day: day, quality, vendor_state: "SCORED" };
    push(makeObservation({ ...base, metric: "whoop.recovery_score", value: s.recovery_score }));
    push(makeObservation({ ...base, metric: "resting_hr_bpm", value: s.resting_heart_rate }));
    push(makeObservation({ ...base, metric: "hrv_rmssd_ms", value: s.hrv_rmssd_milli }));
    push(makeObservation({ ...base, metric: "spo2_pct", value: s.spo2_percentage }));
    push(makeObservation({ ...base, metric: "skin_temp_c", value: s.skin_temp_celsius }));
  }

  for (const sl of raw.sleeps) {
    if (sl.nap === true) continue;                                    // naps are not the night's sleep
    if (!scored(sl)) { count(sl); continue; }
    if (typeof sl.end !== "string") continue;
    const day = localDayFromOffset(sl.end, sl.timezone_offset);
    if (!day) continue;
    const s = obj(sl.score), st = obj(s.stage_summary);
    const asleepMs = [st.total_light_sleep_time_milli, st.total_slow_wave_sleep_time_milli, st.total_rem_sleep_time_milli].every((v) => typeof v === "number")
      ? (st.total_light_sleep_time_milli as number) + (st.total_slow_wave_sleep_time_milli as number) + (st.total_rem_sleep_time_milli as number) : null;
    const base = { provider: "whoop" as const, transport: "direct" as const, source_record_id: `sleep:${str(sl.id)}`, measured_at: sl.end, local_day: day, vendor_state: "SCORED" };
    push(makeObservation({ ...base, metric: "sleep_minutes", value: asleepMs === null ? null : Math.round(asleepMs / 60_000) }));
    push(makeObservation({ ...base, metric: "respiratory_rate_bpm", value: s.respiratory_rate }));
    push(makeObservation({ ...base, metric: "whoop.sleep_performance_pct", value: s.sleep_performance_percentage }));
    push(makeObservation({ ...base, metric: "whoop.sleep_efficiency_pct", value: s.sleep_efficiency_percentage }));
    push(makeObservation({ ...base, metric: "whoop.sleep_consistency_pct", value: s.sleep_consistency_percentage }));
  }

  for (const c of raw.cycles) {
    if (!scored(c)) { count(c); continue; }
    if (typeof c.start !== "string") continue;
    const day = localDayFromOffset(c.start, c.timezone_offset);
    const s = obj(c.score);
    const base = { provider: "whoop" as const, transport: "direct" as const, source_record_id: `cycle:${str(c.id)}`, measured_at: c.start, local_day: day, vendor_state: "SCORED" };
    push(makeObservation({ ...base, metric: "whoop.day_strain", value: s.strain }));
    push(makeObservation({ ...base, metric: "energy_kj", value: s.kilojoule }));
  }

  const workouts: WhoopActivity[] = [];
  for (const w of raw.workouts) {
    if (!scored(w)) { count(w); continue; }
    if (typeof w.start !== "string" || Number.isNaN(Date.parse(w.start))) continue;
    const s = obj(w.score), id = str(w.id);
    const day = localDayFromOffset(w.start, w.timezone_offset);
    const base = { provider: "whoop" as const, transport: "direct" as const, source_record_id: `workout:${id}`, measured_at: w.start, local_day: day, vendor_state: "SCORED" };
    push(makeObservation({ ...base, metric: "whoop.workout_strain", value: s.strain }));
    push(makeObservation({ ...base, metric: "avg_hr_bpm", value: s.average_heart_rate }));
    const endMs = typeof w.end === "string" ? Date.parse(w.end) : NaN, dur = Number.isNaN(endMs) ? null : Math.round((endMs - Date.parse(w.start)) / 1000);
    const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
    const kj = num(s.kilojoule, 0, 100_000);
    workouts.push({
      external_id: id, started_at: new Date(Date.parse(w.start)).toISOString(), sport: sportOf(str(w.sport_name)),
      title: str(w.sport_name) ? `WHOOP ${str(w.sport_name).replace(/[-_]/g, " ")}`.slice(0, 80) : null,
      duration_s: dur !== null && dur > 0 && dur < 2_592_000 ? dur : null, distance_m: num(s.distance_meter, 1, 1_000_000),
      avg_hr: num(s.average_heart_rate, 20, 250) === null ? null : Math.round(s.average_heart_rate as number),
      max_hr: num(s.max_heart_rate, 30, 250) === null ? null : Math.round(s.max_heart_rate as number),
      calories: kj === null ? null : Math.round(kj / 4.184),                 // kJ -> kcal (exact unit conversion, not an estimate)
    });
  }

  if (raw.body) {
    const b = raw.body, at = now.toISOString();
    const base = { provider: "whoop" as const, transport: "direct" as const, source_record_id: `body:${at.slice(0, 10)}`, measured_at: at, local_day: null };
    push(makeObservation({ ...base, metric: "weight_kg", value: b.weight_kilogram }));
    push(makeObservation({ ...base, metric: "height_cm", value: typeof b.height_meter === "number" ? Math.round(b.height_meter * 1000) / 10 : null }));
    push(makeObservation({ ...base, metric: "max_hr_bpm", value: b.max_heart_rate }));
  }
  return { observations: dedupeObservations(obs), workouts, pending, unscorable };
}

/** Read everything needed for one sync. */
export async function readWhoop(token: string, range: { start: string; end: string }, deps: Deps = {}) {
  const cycles = await collect("/v2/cycle", token, range.start, range.end, deps);
  const recoveries = await collect("/v2/recovery", token, range.start, range.end, deps);
  const sleeps = await collect("/v2/activity/sleep", token, range.start, range.end, deps);
  const workouts = await collect("/v2/activity/workout", token, range.start, range.end, deps);
  const body = await getJson("/v2/user/measurement/body", token, deps).catch((e) => { if (e instanceof WhoopError && e.status === 403) return null; throw e; });
  return { cycles, recoveries, sleeps, workouts, body: body && Object.keys(body).length ? body : null };
}
