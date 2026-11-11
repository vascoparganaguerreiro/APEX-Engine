// Minimal Intervals.icu client. No imports, so it runs in Node tests and on the server.
// Docs: https://intervals.icu/api-docs.html  (Basic auth: user "API_KEY", password = your key)

export const INTERVALS_BASE = "https://intervals.icu/api/v1";

/** Error from Intervals.icu or from bad input. `status` is the HTTP status to send back to our client. */
export class IntervalsError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "IntervalsError";
    this.status = status;
  }
}

export interface IntervalsAthlete {
  id: string;
  name: string | null;
}

/** Athlete ids look like "i12345"; "0" means "the athlete that owns the key". */
export function normalizeAthleteId(raw: unknown): string {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (id !== "0" && !/^i?\d{1,12}$/.test(id)) {
    throw new IntervalsError(400, "Invalid athlete id. It looks like i12345 (see Intervals.icu > Settings).");
  }
  return id;
}

export function normalizeApiKey(raw: unknown): string {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (key.length < 8 || key.length > 128 || !/^[A-Za-z0-9_\-]+$/.test(key)) {
    throw new IntervalsError(400, "Invalid API key.");
  }
  return key;
}

export function authHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`API_KEY:${apiKey}`).toString("base64")}`;
}

// ------------------------------------------------------------------ sync mapping
export interface WellnessRow { day: string; hrv_ms: number | null; rhr_bpm: number | null; sleep_minutes: number | null; sleep_score: number | null }
export interface ActivityRow {
  external_id: string; source: "intervals"; started_at: string; sport: string; title: string | null;
  duration_s: number | null; distance_m: number | null; avg_hr: number | null; load: number | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

export function mapSport(type: unknown): string {
  const t = typeof type === "string" ? type : "";
  if (/run/i.test(t)) return "run";
  if (/swim/i.test(t)) return "swim";
  if (/ride|bike|cycl/i.test(t)) return "bike";
  if (/weight|strength|workout/i.test(t)) return "strength";
  return "other";
}

/** Intervals.icu wellness entry -> daily_metrics values. Returns null when it holds nothing we use. */
export function mapWellness(w: Record<string, unknown>): WellnessRow | null {
  const day = typeof w.id === "string" ? w.id.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const hrv = num(w.hrv), rhr = num(w.restingHR), sleepS = num(w.sleepSecs), score = num(w.sleepScore);
  if (hrv === null && rhr === null && sleepS === null) return null;
  return {
    day,
    hrv_ms: hrv,
    rhr_bpm: rhr === null ? null : Math.round(rhr),
    sleep_minutes: sleepS === null ? null : Math.round(sleepS / 60),
    sleep_score: score === null ? null : Math.round(score),
  };
}

/** Intervals.icu activity -> activities values. Skips entries without id or start time. */
export function mapActivity(a: Record<string, unknown>): ActivityRow | null {
  const id = typeof a.id === "string" || typeof a.id === "number" ? String(a.id) : "";
  let started = typeof a.start_date === "string" ? a.start_date : typeof a.start_date_local === "string" ? a.start_date_local + "Z" : "";
  if (!id || !started) return null;
  const ms = Date.parse(started);
  if (Number.isNaN(ms)) return null;
  started = new Date(ms).toISOString();
  const hr = num(a.average_heartrate), load = num(a.icu_training_load), secs = num(a.moving_time) ?? num(a.elapsed_time);
  return {
    external_id: id,
    source: "intervals",
    started_at: started,
    sport: mapSport(a.type),
    title: typeof a.name === "string" && a.name.trim() ? a.name.trim() : null,
    duration_s: secs === null ? null : Math.round(secs),
    distance_m: num(a.distance),
    avg_hr: hr === null ? null : Math.round(hr),
    load: load === null ? null : Math.round(load),
  };
}

async function getList(path: string, apiKey: string, fetchImpl: typeof fetch): Promise<Record<string, unknown>[]> {
  let r: Response;
  try {
    r = await fetchImpl(`${INTERVALS_BASE}${path}`, { headers: { Authorization: authHeader(apiKey) } });
  } catch {
    throw new IntervalsError(502, "Could not reach Intervals.icu.");
  }
  if (r.status === 401 || r.status === 403) throw new IntervalsError(401, "Intervals.icu rejected the saved credentials. Reconnect.");
  if (r.status === 429) throw new IntervalsError(429, "Intervals.icu rate limit reached. Try again shortly.");
  if (!r.ok) throw new IntervalsError(502, `Intervals.icu answered ${r.status}.`);
  const j = await r.json().catch(() => null);
  return Array.isArray(j) ? (j as Record<string, unknown>[]) : [];
}

export async function fetchWellness(athleteId: string, apiKey: string, oldest: string, newest: string, fetchImpl: typeof fetch = fetch): Promise<WellnessRow[]> {
  const id = normalizeAthleteId(athleteId);
  const list = await getList(`/athlete/${id}/wellness?oldest=${oldest}&newest=${newest}`, apiKey, fetchImpl);
  return list.map(mapWellness).filter((x): x is WellnessRow => x !== null);
}

export async function fetchActivities(athleteId: string, apiKey: string, oldest: string, newest: string, fetchImpl: typeof fetch = fetch): Promise<ActivityRow[]> {
  const id = normalizeAthleteId(athleteId);
  const list = await getList(`/athlete/${id}/activities?oldest=${oldest}&newest=${newest}`, apiKey, fetchImpl);
  return list.map(mapActivity).filter((x): x is ActivityRow => x !== null);
}

/** Check the credentials by reading the athlete profile. */
export async function fetchAthlete(
  athleteId: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IntervalsAthlete> {
  const id = normalizeAthleteId(athleteId);
  const key = normalizeApiKey(apiKey);
  let r: Response;
  try {
    r = await fetchImpl(`${INTERVALS_BASE}/athlete/${id}`, { headers: { Authorization: authHeader(key) } });
  } catch {
    throw new IntervalsError(502, "Could not reach Intervals.icu.");
  }
  if (r.status === 401 || r.status === 403) throw new IntervalsError(401, "Intervals.icu rejected the athlete id or API key.");
  if (r.status === 429) throw new IntervalsError(429, "Intervals.icu rate limit reached. Try again shortly.");
  if (!r.ok) throw new IntervalsError(502, `Intervals.icu answered ${r.status}.`);
  const j = (await r.json().catch(() => null)) as { id?: unknown; name?: unknown } | null;
  return {
    id: typeof j?.id === "string" ? j.id : id,
    name: typeof j?.name === "string" ? j.name : null,
  };
}
