// Race Hub logic. Pure functions, no imports (unit-testable). Dates are plain "YYYY-MM-DD" values (a race day has no time
// zone); "today" is the user's own local calendar date, passed in by the caller, so countdowns never shift with UTC.
// Nothing here predicts results or finish times: it only does arithmetic on what the user entered.

export const SPORTS = ["running", "cycling", "triathlon", "swimming", "football", "other"] as const;
export type Sport = (typeof SPORTS)[number];
export const SPORT_LABEL: Record<Sport, string> = { running: "Running", cycling: "Cycling", triathlon: "Triathlon", swimming: "Swimming", football: "Football", other: "Other" };

// race_type already exists in the database (a fixed list, also used by the training engine). The user picks it explicitly.
export const FORMATS: Record<Sport, Array<{ value: string; label: string }>> = {
  running: [{ value: "10k", label: "10K" }, { value: "half_marathon", label: "Half marathon" }, { value: "marathon", label: "Marathon" }, { value: "trail", label: "Trail" }, { value: "other", label: "Other distance" }],
  cycling: [{ value: "cycling", label: "Cycling event" }, { value: "other", label: "Other" }],
  triathlon: [{ value: "triathlon_sprint", label: "Sprint" }, { value: "triathlon_olympic", label: "Olympic" }, { value: "half_ironman", label: "Half Ironman (70.3)" }, { value: "ironman", label: "Ironman" }, { value: "other", label: "Other" }],
  swimming: [{ value: "other", label: "Swim event" }],
  football: [{ value: "other", label: "Match / tournament" }],
  other: [{ value: "other", label: "Other" }],
};

export const PRIORITIES = ["A", "B", "C"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABEL: Record<Priority, string> = { A: "A - main goal", B: "B - important", C: "C - training race" };

export const STATUSES = ["planned", "registered", "completed", "dnf", "dns", "cancelled"] as const;
export type Status = (typeof STATUSES)[number];
export const STATUS_LABEL: Record<Status, string> = { planned: "Planned", registered: "Registered", completed: "Completed", dnf: "Did not finish", dns: "Did not start", cancelled: "Cancelled" };
export const DISTANCE_UNITS = ["km", "mi", "m"] as const;

export interface Race {
  id: number; name: string; race_date: string; race_type: string; sport: Sport; location: string | null;
  distance: number | null; distance_unit: string | null; target_time_s: number | null;
  priority: Priority; goal: string | null; notes: string | null; status: Status;
}
/** What the form submits (the database row minus id). */
export type RaceInput = Omit<Race, "id">;

// ------------------------------------------------------------------ dates
export const isIsoDate = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const dayNumber = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d) / 86_400_000; };
/** Whole calendar days from `today` to `date` (negative when the date has passed). */
export const daysUntil = (date: string, today: string): number => Math.round(dayNumber(date) - dayNumber(today));

export interface Countdown { days: number; label: string; detail: string; past: boolean }
export function countdown(date: string, today: string): Countdown {
  const days = daysUntil(date, today);
  if (days === 0) return { days, label: "Race day", detail: "today", past: false };
  if (days === 1) return { days, label: "Tomorrow", detail: "1 day to go", past: false };
  if (days > 1) {
    const w = Math.floor(days / 7), r = days % 7;
    return { days, label: `${days} days`, detail: days >= 14 ? `${w} week${w === 1 ? "" : "s"}${r ? ` and ${r} day${r === 1 ? "" : "s"}` : ""} to go` : `${days} days to go`, past: false };
  }
  const n = -days;
  return { days, label: n === 1 ? "Yesterday" : `${n} days ago`, detail: "", past: true };
}

// ------------------------------------------------------------------ time and distance
/** "3:45:00", "1:05:30", "45:30" (mm:ss) -> seconds. Null when it is not a clear duration. */
export function parseDuration(text: string): number | null {
  const m = /^\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!m) return null;
  const h = m[1] === undefined ? 0 : Number(m[1]), min = Number(m[2]), s = Number(m[3]);
  if (min > 59 || s > 59) return null;
  const total = h * 3600 + min * 60 + s;
  return total > 0 && total <= 604_800 ? total : null;
}
export function formatDuration(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec) || sec <= 0) return "";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
export const formatDistance = (d: number | null, unit: string | null) => (d === null || !unit ? "" : `${Number(d.toFixed(2))} ${unit}`);

// ------------------------------------------------------------------ validation
export function validateRace(r: RaceInput, today: string): string | null {
  if (!r.name || !r.name.trim() || r.name.length > 120) return "Give the race a name (up to 120 characters).";
  if (!isIsoDate(r.race_date)) return "Event date is required.";
  const y = Number(r.race_date.slice(0, 4));
  if (y < 1990 || y > Number(today.slice(0, 4)) + 10) return "That event date looks wrong. Check the year.";
  if (!SPORTS.includes(r.sport)) return "Choose a sport.";
  if (!FORMATS[r.sport].some((f) => f.value === r.race_type)) return "Choose a format that matches the sport.";
  if (!PRIORITIES.includes(r.priority)) return "Priority must be A, B or C.";
  if (!STATUSES.includes(r.status)) return "Unknown race status.";
  if ((r.distance === null) !== (r.distance_unit === null)) return "Enter both the distance and its unit, or neither.";
  if (r.distance !== null && (!Number.isFinite(r.distance) || r.distance <= 0 || !DISTANCE_UNITS.includes(r.distance_unit as (typeof DISTANCE_UNITS)[number]))) return "Distance must be a positive number.";
  if (r.target_time_s !== null && (!Number.isInteger(r.target_time_s) || r.target_time_s <= 0 || r.target_time_s > 604_800)) return "Target time must be like 3:45:00.";
  if (r.location && r.location.length > 120) return "Location is too long (120 characters max).";
  if (r.goal && r.goal.length > 300) return "Personal goal is too long (300 characters max).";
  if (r.notes && r.notes.length > 2000) return "Notes are too long (2000 characters max).";
  return null;
}

// ------------------------------------------------------------------ grouping and filtering
const OPEN: Status[] = ["planned", "registered"];
/** Upcoming = still to be run: today or later and not cancelled/finished. Everything else is completed or past. */
export const isUpcoming = (r: Pick<Race, "race_date" | "status">, today: string) => r.race_date >= today && OPEN.includes(r.status);

export function splitRaces(races: Race[], today: string): { upcoming: Race[]; past: Race[] } {
  const upcoming = races.filter((r) => isUpcoming(r, today)).sort((a, b) => a.race_date.localeCompare(b.race_date) || a.priority.localeCompare(b.priority));
  const past = races.filter((r) => !isUpcoming(r, today)).sort((a, b) => b.race_date.localeCompare(a.race_date));
  return { upcoming, past };
}
export const nextRace = (races: Race[], today: string): Race | null => splitRaces(races, today).upcoming[0] ?? null;
/** The main goal race: the soonest upcoming A race. Null when none is marked A (nothing is guessed). */
export const goalRace = (races: Race[], today: string): Race | null => splitRaces(races, today).upcoming.find((r) => r.priority === "A") ?? null;

export function filterRaces(races: Race[], query: string, sport: Sport | "all"): Race[] {
  const q = query.trim().toLowerCase();
  return races.filter((r) => (sport === "all" || r.sport === sport) && (!q || `${r.name} ${r.location ?? ""}`.toLowerCase().includes(q)));
}

export function monthGroups(races: Race[]): Array<[string, Race[]]> {
  const g = new Map<string, Race[]>();
  for (const r of [...races].sort((a, b) => a.race_date.localeCompare(b.race_date))) g.set(r.race_date.slice(0, 7), [...(g.get(r.race_date.slice(0, 7)) ?? []), r]);
  return [...g.entries()];
}

export const formatDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

// ------------------------------------------------------------------ database rows
export const RACE_COLUMNS = "id,name,race_date,race_type,sport,location,distance,distance_unit,target_time_s,priority,goal,notes,status";
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export function raceFromRow(r: Record<string, unknown>): Race {
  return {
    id: Number(r.id), name: String(r.name), race_date: String(r.race_date), race_type: String(r.race_type),
    sport: (SPORTS as readonly string[]).includes(String(r.sport)) ? (r.sport as Sport) : "other",
    location: (r.location as string | null) ?? null, distance: num(r.distance), distance_unit: (r.distance_unit as string | null) ?? null,
    target_time_s: num(r.target_time_s), priority: (PRIORITIES as readonly string[]).includes(String(r.priority)) ? (r.priority as Priority) : "B",
    goal: (r.goal as string | null) ?? null, notes: (r.notes as string | null) ?? null,
    status: (STATUSES as readonly string[]).includes(String(r.status)) ? (r.status as Status) : "planned",
  };
}
// ------------------------------------------------------------------ data access (every call runs as the signed-in user, so RLS applies)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Db { from(table: string): any }
const WRITABLE = ["name", "race_date", "race_type", "sport", "location", "distance", "distance_unit", "target_time_s", "priority", "goal", "notes", "status"] as const;
/** Only known, writable columns pass through: id, user_id and anything else in the input is dropped. */
export function writableRow(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of WRITABLE) if (k in input) out[k] = input[k];
  return out;
}
export const isRaceId = (s: string) => /^\d{1,15}$/.test(s);
const fail = (e: { message?: string } | null | undefined): never => { throw new Error(e?.message ?? "Request failed"); };

export async function listRaces(db: Db): Promise<Race[]> {
  const { data, error } = await db.from("races").select(RACE_COLUMNS).order("race_date", { ascending: true });
  if (error) fail(error);
  return ((data ?? []) as Record<string, unknown>[]).map(raceFromRow);
}
export async function getRace(db: Db, id: number): Promise<Race | null> {
  const { data, error } = await db.from("races").select(RACE_COLUMNS).eq("id", id).maybeSingle();
  if (error) fail(error);
  return data ? raceFromRow(data as Record<string, unknown>) : null;
}
/** user_id always comes from the verified session, never from the form input. */
export async function createRace(db: Db, uid: string, input: RaceInput): Promise<Race> {
  const { data, error } = await db.from("races").insert({ ...writableRow(input as unknown as Record<string, unknown>), user_id: uid }).select(RACE_COLUMNS).single();
  if (error) fail(error);
  return raceFromRow(data as Record<string, unknown>);
}
/** Updates by id only; user_id is never written. Another user's race matches no row (RLS), which is reported as not found. */
export async function updateRace(db: Db, id: number, input: RaceInput): Promise<Race> {
  const { data, error } = await db.from("races").update(writableRow(input as unknown as Record<string, unknown>)).eq("id", id).select(RACE_COLUMNS);
  if (error) fail(error);
  if (!data || data.length === 0) throw new Error("Race not found.");
  return raceFromRow(data[0] as Record<string, unknown>);
}
export async function deleteRace(db: Db, id: number): Promise<void> {
  const { data, error } = await db.from("races").delete().eq("id", id).select("id");
  if (error) fail(error);
  if (!data || data.length === 0) throw new Error("Race not found.");
}
/** All races for read-only views (Today). Same rows as listRaces, but if the Race Hub columns (migration 10) are missing it reads the
 *  original columns instead of failing: those races then get the defaults raceFromRow gives (status "planned", sport "other"), exactly
 *  like nextUpcomingRace. `legacy` tells the caller the extra fields are unavailable. Only throws when even the original table fails. */
export const BASE_RACE_COLUMNS = "id,name,race_date,race_type,priority,goal,notes";
/** The columns migration 10 adds (RACE_COLUMNS minus BASE_RACE_COLUMNS). */
export const RACE_HUB_COLUMNS = RACE_COLUMNS.split(",").filter((c) => !BASE_RACE_COLUMNS.split(",").includes(c));
/** True ONLY when a query failed because one of the migration-10 columns does not exist. Postgres reports that as 42703
 *  ("column races.status does not exist"); PostgREST's schema-cache variant is PGRST204 ("Could not find the 'status' column of
 *  'races' in the schema cache"). Network failures (status 0, no such code), timeouts, permission (42501), JWT/auth (PGRST3xx) and every
 *  other error return false, as does a missing column that is NOT a Race Hub column. */
export function isMissingRaceHubColumn(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const { code, message } = e as { code?: unknown; message?: unknown };
  if (code !== "42703" && code !== "PGRST204") return false;
  const msg = typeof message === "string" ? message : "";
  return RACE_HUB_COLUMNS.some((c) => new RegExp(`(^|[^a-z0-9_])${c}([^a-z0-9_]|$)`).test(msg));
}
export async function listRacesCompat(db: Db): Promise<{ races: Race[]; legacy: boolean }> {
  const full = await db.from("races").select(RACE_COLUMNS).order("race_date", { ascending: true });
  if (!full.error) return { races: ((full.data ?? []) as Record<string, unknown>[]).map(raceFromRow), legacy: false };
  if (!isMissingRaceHubColumn(full.error)) fail(full.error);             // a genuine error is reported, never hidden by the legacy query
  const base = await db.from("races").select(BASE_RACE_COLUMNS).order("race_date", { ascending: true });
  if (base.error) fail(base.error);
  return { races: ((base.data ?? []) as Record<string, unknown>[]).map(raceFromRow), legacy: true };
}
/** The next upcoming race (Races page rule: isUpcoming, soonest first, then priority) or null when none qualifies. Throws on a genuine
 *  error. Before migration 10 it reads the original columns; those races have no status yet and count as planned (raceFromRow). */
export async function nextUpcomingRaceStrict(db: Db, today: string): Promise<Race | null> {
  const full = await db.from("races").select(RACE_COLUMNS).gte("race_date", today).in("status", ["planned", "registered"])
    .order("race_date", { ascending: true }).order("priority", { ascending: true }).limit(20);
  let rows = full.data;
  if (full.error) {
    if (!isMissingRaceHubColumn(full.error)) fail(full.error);
    const base = await db.from("races").select(BASE_RACE_COLUMNS).gte("race_date", today)
      .order("race_date", { ascending: true }).order("priority", { ascending: true }).limit(20);
    if (base.error) fail(base.error);
    rows = base.data;
  }
  return nextRace(((rows ?? []) as Record<string, unknown>[]).map(raceFromRow), today);
}
/** The next upcoming race for the Coach page: same rule, but null on any error (unchanged contract). */
export async function nextUpcomingRace(db: Db, today: string): Promise<Race | null> {
  try { return await nextUpcomingRaceStrict(db, today); } catch { return null; }
}