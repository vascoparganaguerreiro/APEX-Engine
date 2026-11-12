// Hevy CSV import (no Hevy Pro or API needed: uses the free "Export Workouts" CSV). Pure (no I/O).
// The file is treated as untrusted input: strict size limits, a real CSV parser, and nothing is assumed about columns that are not there.
// Flow: parse -> detect format -> group into workouts -> match exercises -> preview with duplicates -> user confirms -> RPC payload.
import { CATALOG, normalizeName } from "./library.ts";
import type { Exercise, LoadMode, SetType, WeightUnit } from "./types.ts";

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_ROWS = 200_000;

// ------------------------------------------------------------------ CSV (RFC 4180: quotes, escaped quotes, CRLF, BOM)
export function parseCsv(text: string, maxRows = MAX_ROWS): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQ = false, i = 0;
  while (i < s.length) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && field === "") { inQ = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r" || c === "\n") {
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      if (rows.length > maxRows) throw new ImportError(`The file has more than ${maxRows} rows.`);
      i += c === "\r" && s[i + 1] === "\n" ? 2 : 1; continue;
    }
    field += c; i++;
  }
  if (inQ) throw new ImportError("The file ends inside a quoted value. It may be cut off or not a CSV file.");
  if (field !== "" || row.length) { row.push(field); if (row.length > 1 || row[0] !== "") rows.push(row); }
  return rows;
}
export class ImportError extends Error {}

// ------------------------------------------------------------------ format detection
export interface HevyFormat {
  kind: "hevy"; columns: Record<string, number>; weightUnit: WeightUnit | null; distanceUnit: "km" | "mi" | "m" | null;
  has: { endTime: boolean; rpe: boolean; superset: boolean; notes: boolean; description: boolean; duration: boolean; distance: boolean; setType: boolean };
}
export type DetectResult = { ok: true; format: HevyFormat } | { ok: false; error: string; headers: string[] };

export function detectFormat(header: string[]): DetectResult {
  const h = header.map((x) => x.trim().toLowerCase());
  const col: Record<string, number> = {};
  h.forEach((name, i) => { if (!(name in col)) col[name] = i; });
  const need = ["title", "start_time", "exercise_title"];
  const missing = need.filter((n) => !(n in col));
  if (missing.length) {
    const strong = h.includes("exercise name") && h.includes("workout name");
    return { ok: false, headers: header, error: strong ? "This looks like a Strong export. Only Hevy's workout export is supported at the moment." : `This does not look like a Hevy workout export (missing: ${missing.join(", ")}).` };
  }
  const weightCol = ["weight_kg", "weight_lbs", "weight_lb"].find((n) => n in col) ?? null;
  const distCol = ["distance_km", "distance_miles", "distance_meters"].find((n) => n in col) ?? null;
  if (weightCol) col.weight = col[weightCol];
  if (distCol) col.distance = col[distCol];
  if (!("set_index" in col) && !("reps" in col)) return { ok: false, headers: header, error: "The file has no set or rep columns." };
  return {
    ok: true, format: {
      kind: "hevy", columns: col, weightUnit: weightCol === "weight_kg" ? "kg" : weightCol ? "lb" : null,
      distanceUnit: distCol === "distance_km" ? "km" : distCol === "distance_miles" ? "mi" : distCol === "distance_meters" ? "m" : null,
      has: { endTime: "end_time" in col, rpe: "rpe" in col, superset: "superset_id" in col, notes: "exercise_notes" in col, description: "description" in col, duration: "duration_seconds" in col, distance: Boolean(distCol), setType: "set_type" in col },
    },
  };
}

// ------------------------------------------------------------------ dates (Hevy writes local wall-clock times without a zone)
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function tzOffsetMinutes(utcMs: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(utcMs)).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - utcMs) / 60_000;
}
/** Wall-clock time in a time zone -> UTC ISO string (DST-aware). */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): string {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off1 = tzOffsetMinutes(guess, tz);
  let utc = guess - off1 * 60_000;
  const off2 = tzOffsetMinutes(utc, tz);
  if (off2 !== off1) utc = guess - off2 * 60_000;
  return new Date(utc).toISOString();
}
/** Parses "26 Mar 2024, 07:43", "Mar 26, 2024 7:43 AM" and ISO forms. Returns null when unsure; never guesses a date. */
export function parseHevyDate(raw: string, tz: string): string | null {
  const v = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(v);
  if (m) {
    const [, y, mo, d, h, mi, s, z] = m;
    if (z) { const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}${z.length === 5 ? `${z.slice(0, 3)}:${z.slice(3)}` : z}`); return Number.isNaN(t) ? null : new Date(t).toISOString(); }
    return valid(+y, +mo, +d, +h, +mi, +(s ?? 0)) ? zonedToUtc(+y, +mo, +d, +h, +mi, +(s ?? 0), tz) : null;
  }
  m = /^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4}),? (\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(v);
  let y: number, mo: number, d: number, h: number, mi: number, s: number, ap: string | undefined;
  if (m) { [d, mo, y, h, mi, s, ap] = [+m[1], MONTHS[m[2].toLowerCase()], +m[3], +m[4], +m[5], +(m[6] ?? 0), m[7]]; }
  else {
    m = /^([A-Za-z]{3})[a-z]* (\d{1,2}),? (\d{4}),? (\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(v);
    if (!m) return null;
    [mo, d, y, h, mi, s, ap] = [MONTHS[m[1].toLowerCase()], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0), m[7]];
  }
  if (!mo) return null;
  if (ap) { if (h < 1 || h > 12) return null; h = (h % 12) + (ap.toUpperCase() === "PM" ? 12 : 0); }
  return valid(y, mo, d, h, mi, s) ? zonedToUtc(y, mo, d, h, mi, s, tz) : null;
}
function valid(y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
  const t = new Date(Date.UTC(y, mo - 1, d));
  return y >= 2000 && y <= 2100 && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && h >= 0 && h < 24 && mi >= 0 && mi < 60 && s >= 0 && s < 60;
}

// ------------------------------------------------------------------ exercise matching
export type MatchHow = "exact" | "alias" | "words" | "none";
export interface ExerciseMatch { importedName: string; exercise: Exercise | null; how: MatchHow }
const wordKey = (s: string) => normalizeName(s).split(" ").map((t) => t.replace(/s$/, "")).filter(Boolean).sort().join(" ");
/** Match an imported exercise name to the library. Only confident matches are made; anything else is left for the user to map. */
export function matchExercise(name: string, library: readonly Exercise[] = CATALOG): ExerciseMatch {
  const n = normalizeName(name), wk = wordKey(name);
  const exact = library.find((e) => normalizeName(e.name) === n);
  if (exact) return { importedName: name, exercise: exact, how: "exact" };
  const alias = library.find((e) => e.aliases.some((a) => normalizeName(a) === n));
  if (alias) return { importedName: name, exercise: alias, how: "alias" };
  const words = library.filter((e) => wordKey(e.name) === wk);
  if (words.length === 1) return { importedName: name, exercise: words[0], how: "words" };
  return { importedName: name, exercise: null, how: "none" };
}

// ------------------------------------------------------------------ grouping into workouts
export interface ImportSet { position: number; type: SetType; weight: number | null; unit: WeightUnit; reps: number | null; duration_s: number | null; distance_m: number | null; rpe: number | null }
export interface ImportExercise { position: number; name: string; superset: number | null; notes: string | null; sets: ImportSet[] }
export interface ImportWorkout { ref: string; title: string; rawStart: string; startedAt: string; endedAt: string | null; notes: string | null; exercises: ImportExercise[] }
export interface ParseIssue { line: number; message: string }
export interface Parsed { format: HevyFormat; workouts: ImportWorkout[]; issues: ParseIssue[]; rowCount: number }

const SET_TYPE_MAP: Record<string, SetType> = { normal: "working", working: "working", warmup: "warmup", "warm up": "warmup", "warm-up": "warmup", dropset: "drop", drop: "drop", "drop set": "drop", failure: "failure" };
const numOrNull = (v: string | undefined): number | null => { if (v === undefined) return null; const t = v.trim(); if (!t) return null; const n = Number(t.replace(",", ".")); return Number.isFinite(n) ? n : NaN; };

export function parseHevy(text: string, tz: string): Parsed {
  if (text.length > MAX_FILE_BYTES) throw new ImportError("The file is larger than 8 MB.");
  const rows = parseCsv(text);
  if (rows.length < 2) throw new ImportError("The file has no workout rows.");
  const det = detectFormat(rows[0]);
  if (!det.ok) throw new ImportError(det.error);
  const f = det.format, c = f.columns, issues: ParseIssue[] = [];
  const get = (r: string[], k: string) => (k in c ? (r[c[k]] ?? "").trim() : undefined);
  const byKey = new Map<string, ImportWorkout>();
  let unknownTypes = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], line = i + 1;
    const title = get(r, "title") ?? "", rawStart = get(r, "start_time") ?? "", exName = get(r, "exercise_title") ?? "";
    if (!rawStart || !exName) { issues.push({ line, message: "Missing start time or exercise name; row skipped." }); continue; }
    const startedAt = parseHevyDate(rawStart, tz);
    if (!startedAt) { issues.push({ line, message: `Unrecognised date "${rawStart.slice(0, 40)}"; row skipped.` }); continue; }
    const rawEnd = get(r, "end_time") ?? "";
    const endedAt = rawEnd ? parseHevyDate(rawEnd, tz) : null;
    const ref = `hevy|${rawStart}|${title}`.slice(0, 200);
    let w = byKey.get(ref);
    if (!w) {
      w = { ref, title: title.slice(0, 120) || "Imported workout", rawStart, startedAt, endedAt: endedAt && Date.parse(endedAt) >= Date.parse(startedAt) ? endedAt : null, notes: (get(r, "description") ?? "").slice(0, 4000) || null, exercises: [] };
      byKey.set(ref, w);
    }
    const ss = numOrNull(get(r, "superset_id"));
    const superset = ss !== null && Number.isInteger(ss) && ss >= 0 ? ss + 1 : null;
    const exNotes = (get(r, "exercise_notes") ?? "").slice(0, 1000) || null;
    let ex = w.exercises[w.exercises.length - 1];
    const setIdx = numOrNull(get(r, "set_index"));
    // A new exercise block starts when the name changes, or the same name restarts at set 0 (the exercise was done twice).
    if (!ex || ex.name !== exName.slice(0, 120) || setIdx === 0 && ex.sets.length > 0) {
      ex = { position: w.exercises.length, name: exName.slice(0, 120), superset, notes: exNotes, sets: [] };
      w.exercises.push(ex);
    }
    const rawType = (get(r, "set_type") ?? "normal").toLowerCase();
    const type = SET_TYPE_MAP[rawType] ?? (unknownTypes++, "working");
    const weight = numOrNull(get(r, "weight")), reps = numOrNull(get(r, "reps")), dur = numOrNull(get(r, "duration_seconds")), dist = numOrNull(get(r, "distance")), rpe = numOrNull(get(r, "rpe"));
    const bad = [weight, reps, dur, dist, rpe].some((v) => Number.isNaN(v));
    if (bad) { issues.push({ line, message: "A number in this row could not be read; the set was skipped." }); continue; }
    const distM = dist === null ? null : f.distanceUnit === "km" ? dist * 1000 : f.distanceUnit === "mi" ? dist * 1609.344 : dist;
    const set: ImportSet = {
      position: ex.sets.length, type, weight: weight !== null && weight >= 0 && weight <= 2000 ? Math.round(weight * 100) / 100 : null, unit: f.weightUnit ?? "kg",
      reps: reps !== null && Number.isInteger(reps) && reps >= 0 && reps <= 1000 ? reps : null, duration_s: dur !== null && dur >= 0 && dur <= 86400 ? Math.round(dur) : null,
      distance_m: distM !== null && distM >= 0 && distM <= 1_000_000 ? Math.round(distM * 100) / 100 : null,
      rpe: rpe !== null && rpe >= 1 && rpe <= 10 ? Math.round(rpe * 2) / 2 : null,
    };
    if ((weight !== null && set.weight === null) || (reps !== null && set.reps === null)) issues.push({ line, message: "A value was outside the accepted range and was left empty." });
    if (ex.sets.length >= 50) { issues.push({ line, message: "More than 50 sets for one exercise; extra sets skipped." }); continue; }
    ex.sets.push(set);
  }
  if (unknownTypes) issues.push({ line: 0, message: `${unknownTypes} set(s) had an unknown set type and were imported as working sets.` });
  const workouts = [...byKey.values()].filter((w) => w.exercises.some((e) => e.sets.length)).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  return { format: f, workouts, issues, rowCount: rows.length - 1 };
}

// ------------------------------------------------------------------ preview with duplicate detection
export interface ExistingSession { id: string; source: string; sourceRef: string | null; startedAt: string; endedAt: string | null; title: string }
export interface PreviewWorkout extends ImportWorkout { status: "new" | "already_imported" | "overlaps_apex"; overlapWith: string | null; include: boolean }
export interface Preview {
  workouts: PreviewWorkout[]; names: ExerciseMatch[]; from: string | null; to: string | null; sets: number;
  counts: { new: number; already: number; overlaps: number }; weightUnit: WeightUnit | null; missing: string[];
}
const overlapRatio = (a0: number, a1: number, b0: number, b1: number) => { const o = Math.min(a1, b1) - Math.max(a0, b0); const d = Math.min(a1 - a0, b1 - b0); return o <= 0 ? 0 : d <= 0 ? 1 : o / d; };

export function buildPreview(p: Parsed, existing: ExistingSession[], library: readonly Exercise[]): Preview {
  const refs = new Set(existing.filter((e) => e.source === "hevy_csv" && e.sourceRef).map((e) => e.sourceRef as string));
  const apex = existing.filter((e) => e.source === "apex");
  const workouts: PreviewWorkout[] = p.workouts.map((w) => {
    if (refs.has(w.ref)) return { ...w, status: "already_imported", overlapWith: null, include: false };
    const s0 = Date.parse(w.startedAt), s1 = w.endedAt ? Date.parse(w.endedAt) : s0 + 60 * 60_000;
    const hit = apex.find((a) => { const a0 = Date.parse(a.startedAt), a1 = a.endedAt ? Date.parse(a.endedAt) : a0 + 60 * 60_000; return overlapRatio(s0, s1, a0, a1) >= 0.5; });
    return hit ? { ...w, status: "overlaps_apex", overlapWith: hit.title, include: false } : { ...w, status: "new", overlapWith: null, include: true };
  });
  const names = [...new Set(p.workouts.flatMap((w) => w.exercises.map((e) => e.name)))].sort().map((n) => matchExercise(n, library));
  const missing: string[] = [];
  if (!p.format.has.endTime) missing.push("end times (durations will be unknown)");
  if (!p.format.has.rpe) missing.push("RPE");
  if (!p.format.weightUnit) missing.push("weights");
  return {
    workouts, names, from: p.workouts[0]?.startedAt ?? null, to: p.workouts[p.workouts.length - 1]?.startedAt ?? null,
    sets: p.workouts.reduce((n, w) => n + w.exercises.reduce((m, e) => m + e.sets.length, 0), 0),
    counts: { new: workouts.filter((w) => w.status === "new").length, already: workouts.filter((w) => w.status === "already_imported").length, overlaps: workouts.filter((w) => w.status === "overlaps_apex").length },
    weightUnit: p.format.weightUnit, missing,
  };
}

/** The user's mapping for each imported name: a library key, or null to keep it under its imported name (not attributed to muscles). */
export type NameMap = Record<string, string | null>;
export interface ImportOptions { dumbbellWeights: "per_hand" | "combined" }

/** Build the RPC payload for the confirmed workouts, in chunks the database function accepts. */
export function buildPayload(pv: Preview, map: NameMap, library: readonly Exercise[], o: ImportOptions, chunk = 50): Array<Array<Record<string, unknown>>> {
  const byKey = new Map(library.map((e) => [e.key, e]));
  const sessions = pv.workouts.filter((w) => w.include && w.status !== "already_imported").map((w) => ({
    source_ref: w.ref, title: w.title, started_at: w.startedAt, ended_at: w.endedAt, notes: w.notes,
    exercises: w.exercises.filter((e) => e.sets.length).map((e, i) => {
      const key = map[e.name] ?? null, ex = key ? byKey.get(key) ?? null : null;
      let loadMode: LoadMode = ex?.loadMode ?? "total";
      if (loadMode === "per_hand" && o.dumbbellWeights === "combined") loadMode = "total";
      const custom = ex?.custom ? ex.key.slice("custom:".length) : null;
      return {
        position: i, exercise_key: ex && !custom ? ex.key : null, custom_exercise_id: custom, exercise_name: e.name, superset_group: e.superset !== null && e.superset <= 20 ? e.superset : null,
        notes: e.notes, weight_unit: e.sets[0]?.unit ?? "kg", load_mode: loadMode,
        sets: e.sets.map((s) => ({ position: s.position, set_type: s.type, weight: s.weight, weight_unit: s.unit, reps: s.reps, duration_s: s.duration_s, distance_m: s.distance_m, rpe: s.rpe })),
      };
    }),
  }));
  const out: Array<Array<Record<string, unknown>>> = [];
  for (let i = 0; i < sessions.length; i += chunk) out.push(sessions.slice(i, i + chunk));
  return out;
}
