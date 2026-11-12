// Profile logic. Pure functions, no imports (unit-testable).
//
// What lives where:
//  * Profile = slow-moving BASELINES the user owns (body measurements, resting-HR baseline, max HR, VO2max, thresholds).
//  * Daily measurements (HRV, daily resting HR, sleep, ...) stay in daily_metrics / activities and are never copied into the profile.
//    The page may show the latest daily value next to a baseline and offer "use this value"; nothing is ever imported silently.
// Nothing is estimated: no max HR from age, no zones, no predictions. Missing stays missing.
// Provenance: field_sources records where each baseline value came from. A value with no entry shows as "source not recorded".

export const UNITS = ["metric", "imperial"] as const;
export type Units = (typeof UNITS)[number];
export const SPORT_CHOICES = ["running", "cycling", "triathlon", "swimming", "strength", "football", "other"] as const;
export const SPORT_LABELS: Record<string, string> = { running: "Running", cycling: "Cycling", triathlon: "Triathlon", swimming: "Swimming", strength: "Strength", football: "Football", other: "Other" };
export const GOALS = [
  { value: "general_fitness", label: "General fitness" }, { value: "weight_management", label: "Weight management" }, { value: "endurance", label: "Build endurance" },
  { value: "speed", label: "Get faster" }, { value: "race_performance", label: "Race performance" }, { value: "health", label: "Health and longevity" },
  { value: "return_from_injury", label: "Return from injury" },
] as const;
export const EXPERIENCE = [
  { value: "beginner", label: "Beginner (under 1 year)" }, { value: "intermediate", label: "Intermediate (1 to 3 years)" },
  { value: "advanced", label: "Advanced (3 to 7 years)" }, { value: "elite", label: "Elite / competitive" },
] as const;

export type Source = "manual" | "lab" | "garmin" | "intervals";
export const SOURCE_LABEL: Record<Source, string> = { manual: "Manual", lab: "Lab test", garmin: "Garmin", intervals: "Intervals.icu" };
export const USER_SOURCES: Source[] = ["manual", "lab"];          // what a person can choose when typing a value in
export const SOURCE_FIELDS = ["weight_kg", "height_cm", "body_fat_pct", "resting_hr", "max_hr", "vo2max", "lthr", "threshold_pace_s_per_km", "ftp_watts"] as const;
export type SourceField = (typeof SOURCE_FIELDS)[number];
export type FieldSources = Partial<Record<SourceField, { source: Source; at: string }>>;

export interface Profile {
  id: string; display_name: string | null; timezone: string; units: Units;
  weight_kg: number | null; height_cm: number | null; max_hr: number | null; ftp_watts: number | null; sleep_goal_h: number;
  birth_date: string | null; body_fat_pct: number | null; preferred_sports: string[]; primary_goal: string | null; goal_notes: string | null;
  resting_hr: number | null; vo2max: number | null; lthr: number | null; threshold_pace_s_per_km: number | null; experience_level: string | null;
  field_sources: FieldSources;
}

export const BASE_COLUMNS = "id,display_name,timezone,units,weight_kg,height_cm,max_hr,ftp_watts,sleep_goal_h";
export const FULL_COLUMNS = `${BASE_COLUMNS},birth_date,body_fat_pct,preferred_sports,primary_goal,goal_notes,resting_hr,vo2max,lthr,threshold_pace_s_per_km,experience_level,field_sources`;
export const NEW_KEYS = ["birth_date", "body_fat_pct", "preferred_sports", "primary_goal", "goal_notes", "resting_hr", "vo2max", "lthr", "threshold_pace_s_per_km", "experience_level", "field_sources"] as const;
const WRITABLE = ["display_name", "timezone", "units", "weight_kg", "height_cm", "max_hr", "ftp_watts", "sleep_goal_h", ...NEW_KEYS] as const;

// ------------------------------------------------------------------ rows
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const isSource = (s: unknown): s is Source => s === "manual" || s === "lab" || s === "garmin" || s === "intervals";

export function sourcesFromRow(v: unknown): FieldSources {
  const out: FieldSources = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const f of SOURCE_FIELDS) {
      const e = (v as Record<string, unknown>)[f] as { source?: unknown; at?: unknown } | undefined;
      if (e && isSource(e.source)) out[f] = { source: e.source, at: typeof e.at === "string" ? e.at : "" };
    }
  }
  return out;
}

/** A row from the database (or null when the user has no profile row yet). Missing values stay null: nothing is made up. */
export function profileFromRow(row: Record<string, unknown> | null, uid: string, defaultTz = "Europe/Lisbon"): Profile {
  const r = row ?? {};
  return {
    id: uid, display_name: (r.display_name as string | null) ?? null, timezone: typeof r.timezone === "string" && r.timezone ? r.timezone : defaultTz,
    units: r.units === "imperial" ? "imperial" : "metric", weight_kg: num(r.weight_kg), height_cm: num(r.height_cm), max_hr: num(r.max_hr), ftp_watts: num(r.ftp_watts),
    sleep_goal_h: r.sleep_goal_h === undefined || r.sleep_goal_h === null ? 8 : Number(r.sleep_goal_h),
    birth_date: (r.birth_date as string | null) ?? null, body_fat_pct: num(r.body_fat_pct),
    preferred_sports: Array.isArray(r.preferred_sports) ? (r.preferred_sports as unknown[]).filter((s): s is string => typeof s === "string") : [],
    primary_goal: (r.primary_goal as string | null) ?? null, goal_notes: (r.goal_notes as string | null) ?? null, resting_hr: num(r.resting_hr), vo2max: num(r.vo2max),
    lthr: num(r.lthr), threshold_pace_s_per_km: num(r.threshold_pace_s_per_km), experience_level: (r.experience_level as string | null) ?? null,
    field_sources: sourcesFromRow(r.field_sources),
  };
}
/** True when the row was read with the Profile-module columns (migration 11 applied). */
export const hasNewColumns = (row: Record<string, unknown> | null) => row !== null && "field_sources" in row;

// ------------------------------------------------------------------ dates, time zones, units
export const isIsoDate = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
/** Completed years between a date of birth and today (both YYYY-MM-DD). Null when there is no date of birth. */
export function ageFromBirth(birth: string | null, today: string): number | null {
  if (!birth || !isIsoDate(birth) || !isIsoDate(today) || birth > today) return null;
  const [by, bm, bd] = birth.split("-").map(Number), [ty, tm, td] = today.split("-").map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}
export function timezoneValid(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz.trim() === tz && tz.length > 0 && tz.length <= 64; } catch { return false; }
}

const KG_PER_LB = 0.45359237, CM_PER_IN = 2.54, KM_PER_MI = 1.609344;
export const kgToLb = (kg: number) => kg / KG_PER_LB;
export const lbToKg = (lb: number) => lb * KG_PER_LB;
export const cmToFtIn = (cm: number) => { let ft = Math.floor(cm / CM_PER_IN / 12), inch = Math.round((cm / CM_PER_IN - ft * 12) * 10) / 10; if (inch >= 12) { ft += 1; inch = 0; } return { ft, inch }; };
export const ftInToCm = (ft: number, inch: number) => (ft * 12 + inch) * CM_PER_IN;

export function formatPace(sPerKm: number | null, units: Units): string {
  if (sPerKm === null || !Number.isFinite(sPerKm) || sPerKm <= 0) return "";
  const s = Math.round(units === "imperial" ? sPerKm * KM_PER_MI : sPerKm);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
/** "4:35" (per km, or per mile when imperial) -> seconds per km. Undefined for empty, "bad" when not a time. */
export function parsePace(text: string, units: Units): number | null | "bad" {
  const t = text.trim();
  if (!t) return null;
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(t);
  if (!m) return "bad";
  const sec = Number(m[1]) * 60 + Number(m[2]);
  return sec <= 0 ? "bad" : units === "imperial" ? sec / KM_PER_MI : sec;
}

// ------------------------------------------------------------------ the editable draft (everything is a string, like form inputs)
export interface ProfileDraft {
  display_name: string; birth_date: string; height_cm: string; height_ft: string; height_in: string; weight: string; body_fat: string;
  resting_hr: string; max_hr: string; vo2max: string; lthr: string; threshold_pace: string; ftp_watts: string; sleep_goal_h: string;
  experience_level: string; primary_goal: string; goal_notes: string; timezone: string; units: Units; preferred_sports: string[];
  sources: Partial<Record<SourceField, Source>>;
}
const s = (v: number | null) => (v === null ? "" : String(v));
const r1 = (v: number) => String(Math.round(v * 10) / 10);

export function draftFromProfile(p: Profile, units: Units = p.units): ProfileDraft {
  const ft = p.height_cm !== null ? cmToFtIn(p.height_cm) : null;
  return {
    display_name: p.display_name ?? "", birth_date: p.birth_date ?? "",
    height_cm: units === "metric" ? s(p.height_cm) : "", height_ft: units === "imperial" && ft ? String(ft.ft) : "", height_in: units === "imperial" && ft ? String(ft.inch) : "",
    weight: p.weight_kg === null ? "" : units === "metric" ? String(p.weight_kg) : r1(kgToLb(p.weight_kg)), body_fat: s(p.body_fat_pct),
    resting_hr: s(p.resting_hr), max_hr: s(p.max_hr), vo2max: s(p.vo2max), lthr: s(p.lthr), threshold_pace: formatPace(p.threshold_pace_s_per_km, units),
    ftp_watts: s(p.ftp_watts), sleep_goal_h: String(p.sleep_goal_h), experience_level: p.experience_level ?? "", primary_goal: p.primary_goal ?? "", goal_notes: p.goal_notes ?? "",
    timezone: p.timezone, units, preferred_sports: [...p.preferred_sports],
    sources: Object.fromEntries(SOURCE_FIELDS.filter((f) => p.field_sources[f]).map((f) => [f, p.field_sources[f]!.source])) as Partial<Record<SourceField, Source>>,
  };
}

type P<T> = T | null | "bad";
const parseNum = (t: string): P<number> => { const x = t.trim().replace(",", "."); if (x === "") return null; const n = Number(x); return Number.isFinite(n) ? n : "bad"; };
const parseInt0 = (t: string): P<number> => { const n = parseNum(t); return n === "bad" || n === null ? n : Number.isInteger(n) ? n : "bad"; };
export function parseHeightCm(d: ProfileDraft): P<number> {
  if (d.units === "metric") return parseNum(d.height_cm);
  const ft = parseNum(d.height_ft), inch = parseNum(d.height_in);
  if (ft === "bad" || inch === "bad") return "bad";
  if (ft === null && inch === null) return null;
  return ftInToCm(ft ?? 0, inch ?? 0);
}
export function parseWeightKg(d: ProfileDraft): P<number> { const n = parseNum(d.weight); return n === "bad" || n === null ? n : d.units === "imperial" ? lbToKg(n) : n; }

// ------------------------------------------------------------------ validation + patch (only changed fields are sent)
export interface PatchResult { patch: Record<string, unknown>; error?: string }
const same = (a: number | null, b: number | null, tol: number) => (a === null || b === null ? a === b : Math.abs(a - b) <= tol);
const range = (label: string, v: number | null, lo: number, hi: number, unit = "") => (v !== null && (v < lo || v > hi) ? `${label} must be between ${lo} and ${hi}${unit}.` : null);

/** Compare the form with the saved profile and build the update. Unchanged fields (including rounding drift from unit
 *  conversion) are NOT sent, so saving can never overwrite values the user did not touch. */
export function buildProfilePatch(existing: Profile, d: ProfileDraft, nowIso: string, today: string, migrated = true): PatchResult {
  const bad = (m: string): PatchResult => ({ patch: {}, error: m });
  if (!UNITS.includes(d.units)) return bad("Choose metric or imperial units.");
  const name = d.display_name.trim();
  if (name.length > 60) return bad("Display name is too long (60 characters max).");
  if (!timezoneValid(d.timezone.trim())) return bad("Choose a valid time zone, for example Europe/Lisbon.");

  const height = parseHeightCm(d), weight = parseWeightKg(d), fat = parseNum(d.body_fat), rhr = parseInt0(d.resting_hr), maxhr = parseInt0(d.max_hr);
  const vo2 = parseNum(d.vo2max), lthr = parseInt0(d.lthr), pace = parsePace(d.threshold_pace, d.units), ftp = parseInt0(d.ftp_watts), sleep = parseNum(d.sleep_goal_h);
  for (const [label, v] of [["Height", height], ["Weight", weight], ["Body fat", fat], ["Resting heart rate", rhr], ["Maximum heart rate", maxhr], ["VO2 max", vo2], ["Lactate threshold heart rate", lthr], ["FTP", ftp], ["Sleep goal", sleep]] as const) {
    if (v === "bad") return bad(`${label}: enter a valid number${label === "Resting heart rate" || label === "Maximum heart rate" || label === "Lactate threshold heart rate" || label === "FTP" ? " (whole)" : ""}.`);
  }
  if (pace === "bad") return bad(`Threshold pace must look like 4:35 (minutes:seconds per ${d.units === "imperial" ? "mile" : "km"}).`);
  if (sleep === null) return bad("Sleep goal is required.");
  const e = range("Height", height as number | null, 80, 250, " cm") ?? range("Weight", weight as number | null, 20, 400, " kg") ?? range("Body fat", fat as number | null, 2, 60, " %")
    ?? range("Resting heart rate", rhr as number | null, 25, 120, " bpm") ?? range("Maximum heart rate", maxhr as number | null, 100, 230, " bpm") ?? range("VO2 max", vo2 as number | null, 10, 95)
    ?? range("Lactate threshold heart rate", lthr as number | null, 60, 230, " bpm") ?? range("FTP", ftp as number | null, 30, 2000, " W") ?? range("Sleep goal", sleep as number, 4, 12, " hours")
    ?? (pace !== null && (pace < 90 || pace > 1200) ? "Threshold pace is outside a realistic range." : null);
  if (e) return bad(e);
  if (d.birth_date.trim()) {
    if (!isIsoDate(d.birth_date)) return bad("Date of birth is not a valid date.");
    const age = ageFromBirth(d.birth_date, today);
    if (age === null) return bad("Date of birth cannot be in the future.");
    if (age < 5 || age > 110) return bad("Date of birth looks wrong. Check the year.");
  }
  if (d.experience_level && !EXPERIENCE.some((x) => x.value === d.experience_level)) return bad("Unknown training experience.");
  if (d.primary_goal && !GOALS.some((x) => x.value === d.primary_goal)) return bad("Unknown training goal.");
  if (d.goal_notes.length > 500) return bad("Goal notes are too long (500 characters max).");
  if (d.preferred_sports.some((x) => !SPORT_CHOICES.includes(x as (typeof SPORT_CHOICES)[number])) || new Set(d.preferred_sports).size !== d.preferred_sports.length) return bad("Preferred sports contain an unknown or repeated sport.");

  const next = {
    height_cm: height as number | null, weight_kg: weight as number | null, body_fat_pct: fat as number | null, resting_hr: rhr as number | null, max_hr: maxhr as number | null,
    vo2max: vo2 as number | null, lthr: lthr as number | null, threshold_pace_s_per_km: pace === null ? null : Math.round(pace), ftp_watts: ftp as number | null,
  };
  // The final values must make sense together (checked on the merged result, so a partial edit is still caught).
  const mr = same(next.resting_hr, existing.resting_hr, 0) ? existing.resting_hr : next.resting_hr;
  const mm = same(next.max_hr, existing.max_hr, 0) ? existing.max_hr : next.max_hr;
  const ml = same(next.lthr, existing.lthr, 0) ? existing.lthr : next.lthr;
  if (mr !== null && mm !== null && mr >= mm) return bad("Resting heart rate must be lower than maximum heart rate.");
  if (ml !== null && mm !== null && ml > mm) return bad("Lactate threshold heart rate cannot be above maximum heart rate.");

  const patch: Record<string, unknown> = {};
  if ((existing.display_name ?? "") !== name) patch.display_name = name || null;
  if (existing.timezone !== d.timezone.trim()) patch.timezone = d.timezone.trim();
  if (existing.units !== d.units) patch.units = d.units;
  if (existing.sleep_goal_h !== sleep) patch.sleep_goal_h = sleep;
  if (!same(next.height_cm, existing.height_cm, 0.3)) patch.height_cm = next.height_cm === null ? null : Math.round(next.height_cm * 10) / 10;
  if (!same(next.weight_kg, existing.weight_kg, 0.06)) patch.weight_kg = next.weight_kg === null ? null : Math.round(next.weight_kg * 100) / 100;
  if (!same(next.max_hr, existing.max_hr, 0)) patch.max_hr = next.max_hr;
  if (!same(next.ftp_watts, existing.ftp_watts, 0)) patch.ftp_watts = next.ftp_watts;
  if ((existing.birth_date ?? "") !== d.birth_date.trim()) patch.birth_date = d.birth_date.trim() || null;
  if (!same(next.body_fat_pct, existing.body_fat_pct, 0)) patch.body_fat_pct = next.body_fat_pct === null ? null : Math.round(next.body_fat_pct * 10) / 10;
  if (!same(next.resting_hr, existing.resting_hr, 0)) patch.resting_hr = next.resting_hr;
  if (!same(next.vo2max, existing.vo2max, 0)) patch.vo2max = next.vo2max === null ? null : Math.round(next.vo2max * 10) / 10;
  if (!same(next.lthr, existing.lthr, 0)) patch.lthr = next.lthr;
  if (!same(next.threshold_pace_s_per_km, existing.threshold_pace_s_per_km, 1)) patch.threshold_pace_s_per_km = next.threshold_pace_s_per_km;
  if ((existing.experience_level ?? "") !== d.experience_level) patch.experience_level = d.experience_level || null;
  if ((existing.primary_goal ?? "") !== d.primary_goal) patch.primary_goal = d.primary_goal || null;
  if ((existing.goal_notes ?? "") !== d.goal_notes.trim()) patch.goal_notes = d.goal_notes.trim() || null;
  if (existing.preferred_sports.join(",") !== d.preferred_sports.join(",")) patch.preferred_sports = d.preferred_sports;

  // Provenance: a changed value is recorded with the chosen source; a cleared value drops its entry; an untouched value keeps what it had.
  const finalValue: Record<SourceField, number | null> = {
    weight_kg: "weight_kg" in patch ? (patch.weight_kg as number | null) : existing.weight_kg, height_cm: "height_cm" in patch ? (patch.height_cm as number | null) : existing.height_cm,
    body_fat_pct: "body_fat_pct" in patch ? (patch.body_fat_pct as number | null) : existing.body_fat_pct, resting_hr: "resting_hr" in patch ? (patch.resting_hr as number | null) : existing.resting_hr,
    max_hr: "max_hr" in patch ? (patch.max_hr as number | null) : existing.max_hr, vo2max: "vo2max" in patch ? (patch.vo2max as number | null) : existing.vo2max,
    lthr: "lthr" in patch ? (patch.lthr as number | null) : existing.lthr, threshold_pace_s_per_km: "threshold_pace_s_per_km" in patch ? (patch.threshold_pace_s_per_km as number | null) : existing.threshold_pace_s_per_km,
    ftp_watts: "ftp_watts" in patch ? (patch.ftp_watts as number | null) : existing.ftp_watts,
  };
  const sources: FieldSources = { ...existing.field_sources };
  // Before migration 11 there is nowhere to store provenance, so none is recorded (and nothing is claimed).
  for (const f of migrated ? SOURCE_FIELDS : []) {
    const chosen = d.sources[f], had = existing.field_sources[f]?.source;
    if (finalValue[f] === null) { delete sources[f]; continue; }
    if (f in patch) sources[f] = { source: chosen ?? "manual", at: nowIso };
    else if (chosen && chosen !== had) sources[f] = { source: chosen, at: nowIso };
  }
  if (JSON.stringify(sources) !== JSON.stringify(existing.field_sources)) patch.field_sources = sources;

  if (!migrated) {
    const blocked = NEW_KEYS.filter((k) => k in patch);
    if (blocked.length) return bad("Some of these fields need the Profile database update (migration 11), which has not been applied yet.");
  }
  return { patch };
}

// ------------------------------------------------------------------ labels, measured values, context for other modules
export function sourceBadge(p: Profile, f: SourceField): string {
  const v = f === "threshold_pace_s_per_km" ? p.threshold_pace_s_per_km : p[f];
  if (v === null) return "";
  const e = p.field_sources[f];
  return e ? SOURCE_LABEL[e.source] : "Source not recorded";
}
/** Where a daily measurement came from. Unknown stays unknown (never guessed). */
export function measuredSource(fieldSource: unknown, rowSource: unknown): Source | "unknown" {
  for (const c of [fieldSource, rowSource]) if (c === "manual" || c === "intervals" || c === "garmin") return c;
  return "unknown";
}

/** What other modules (Today, Race Hub, a future AI Coach) may use: explicit, non-empty values with their provenance.
 *  No name, no date of birth, no email: only age (derived). Nothing is estimated. */
export function coachContext(p: Profile, today: string) {
  const baseline = (f: SourceField, value: number | null, unit: string) => (value === null ? null : { value, unit, source: p.field_sources[f]?.source ?? "not_recorded" });
  const entries = {
    resting_hr: baseline("resting_hr", p.resting_hr, "bpm"), max_hr: baseline("max_hr", p.max_hr, "bpm"), vo2max: baseline("vo2max", p.vo2max, "ml/kg/min"),
    lthr: baseline("lthr", p.lthr, "bpm"), threshold_pace: baseline("threshold_pace_s_per_km", p.threshold_pace_s_per_km, "s/km"), ftp: baseline("ftp_watts", p.ftp_watts, "W"),
    weight: baseline("weight_kg", p.weight_kg, "kg"), height: baseline("height_cm", p.height_cm, "cm"), body_fat: baseline("body_fat_pct", p.body_fat_pct, "%"),
  };
  return {
    age: ageFromBirth(p.birth_date, today), units: p.units, timezone: p.timezone, preferred_sports: p.preferred_sports, primary_goal: p.primary_goal,
    experience_level: p.experience_level, sleep_goal_h: p.sleep_goal_h,
    baselines: Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== null)),
  };
}

// ------------------------------------------------------------------ data access (every call runs as the signed-in user, so RLS applies)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Db { from(table: string): any }
const fail = (e: { message?: string } | null | undefined): never => { throw new Error(e?.message ?? "Request failed"); };

export async function loadProfile(db: Db, uid: string, defaultTz?: string): Promise<{ profile: Profile; exists: boolean; migrated: boolean }> {
  let res = await db.from("profiles").select(FULL_COLUMNS).eq("id", uid).maybeSingle();
  let migrated = true;
  if (res.error) { migrated = false; res = await db.from("profiles").select(BASE_COLUMNS).eq("id", uid).maybeSingle(); }
  if (res.error) fail(res.error);
  const row = (res.data ?? null) as Record<string, unknown> | null;
  return { profile: profileFromRow(row, uid, defaultTz), exists: row !== null, migrated };
}

/** Only known columns are written (never id or created_at). Updates the existing row, or creates it for users who have none yet. */
export async function saveProfile(db: Db, uid: string, patch: Record<string, unknown>, exists: boolean): Promise<void> {
  const row: Record<string, unknown> = {};
  for (const k of WRITABLE) if (k in patch) row[k] = patch[k];
  if (Object.keys(row).length === 0) return;
  if (exists) {
    const { data, error } = await db.from("profiles").update(row).eq("id", uid).select("id");
    if (error) fail(error);
    if (!data || data.length === 0) throw new Error("Profile not found.");
  } else {
    const { error } = await db.from("profiles").insert({ id: uid, ...row }).select("id").single();
    if (error) fail(error);
  }
}

export interface Measured { value: number; day: string; source: Source | "unknown"; label: string }
export async function loadMeasured(db: Db): Promise<{ resting_hr: Measured | null; vo2max: Measured | null }> {
  const out: { resting_hr: Measured | null; vo2max: Measured | null } = { resting_hr: null, vo2max: null };
  try {
    let r = await db.from("daily_metrics").select("day,rhr_bpm,rhr_source,source").not("rhr_bpm", "is", null).order("day", { ascending: false }).limit(1);
    if (r.error) r = await db.from("daily_metrics").select("day,rhr_bpm,source").not("rhr_bpm", "is", null).order("day", { ascending: false }).limit(1);
    const row = r.data?.[0];
    if (row) out.resting_hr = { value: Number(row.rhr_bpm), day: String(row.day), source: measuredSource(row.rhr_source, row.source), label: "resting heart rate" };
  } catch { /* optional */ }
  try {
    const v = await db.from("daily_metrics").select("day,vo2max_run,vo2max_bike,source").or("vo2max_run.not.is.null,vo2max_bike.not.is.null").order("day", { ascending: false }).limit(1);
    const row = v.data?.[0];
    if (row) {
      const run = row.vo2max_run !== null && row.vo2max_run !== undefined;
      out.vo2max = { value: Number(run ? row.vo2max_run : row.vo2max_bike), day: String(row.day), source: measuredSource(null, row.source), label: run ? "running VO2 max" : "cycling VO2 max" };
    }
  } catch { /* optional */ }
  return out;
}

export interface Integrations {
  intervals: { connected: boolean; athlete_id: string | null; last_sync_at: string | null };
  garmin: { latest: string | null } | null; labs: { latest: string | null; count: number } | null;
}
/** Connection status only. Reads the non-secret columns; credentials are never selected. */
export async function loadIntegrations(db: Db): Promise<Integrations> {
  const out: Integrations = { intervals: { connected: false, athlete_id: null, last_sync_at: null }, garmin: null, labs: null };
  try {
    const c = await db.from("intervals_connections").select("athlete_id,last_sync_at").maybeSingle();
    if (c.data) out.intervals = { connected: true, athlete_id: c.data.athlete_id ?? null, last_sync_at: c.data.last_sync_at ?? null };
  } catch { /* optional */ }
  try {
    const g = await db.from("daily_metrics").select("day").eq("source", "garmin").order("day", { ascending: false }).limit(1);
    if (g.data?.[0]) out.garmin = { latest: String(g.data[0].day) };
  } catch { /* optional */ }
  try {
    const l = await db.from("blood_panels").select("collected_on", { count: "exact" }).order("collected_on", { ascending: false }).limit(1);
    if (!l.error && l.data?.[0]) out.labs = { latest: String(l.data[0].collected_on), count: l.count ?? l.data.length };
  } catch { /* optional */ }
  return out;
}