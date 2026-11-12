// Training Calendar model (Phase 1). Pure functions: no imports from the browser client or the database.
//
// Three kinds of data are always kept apart:
//   * PLANNED   : rows the user wrote in planned_workouts (an intention).
//   * COMPLETED : real activities / finished strength sessions that already happened (measurements), shown as they are.
//   * PROJECTED : nothing in Phase 1. Planned load is NEVER added to CTL/ATL/TSB and no strength volume is converted to cardio load.
// A plan becomes "completed" only by an explicit user action (mark done, or confirm a suggested match). Date or sport alone never does.
import { isIsoDate } from "../races.ts";
import { addDaysIso, localDay, weekStart } from "../activities.ts";
import type { Race } from "../races.ts";
import { isUpcoming } from "../races.ts";

export { isIsoDate, addDaysIso, weekStart };

// ------------------------------------------------------------------ types
export const KINDS = ["endurance", "strength", "rest", "milestone"] as const;
export type PlannedKind = (typeof KINDS)[number];
export const KIND_LABEL: Record<PlannedKind, string> = { endurance: "Endurance", strength: "Strength", rest: "Rest", milestone: "Milestone" };
export const STATUSES = ["planned", "completed", "skipped"] as const;
export type PlannedStatus = (typeof STATUSES)[number];
/** Same values activities.sport uses. */
export const ENDURANCE_SPORTS = ["run", "bike", "swim", "other"] as const;
export const SPORT_NAME: Record<string, string> = { run: "Run", bike: "Bike", swim: "Swim", other: "Other", strength: "Strength" };

export const STEP_TYPES = ["warmup", "work", "recovery", "cooldown", "steady"] as const;
export type StepType = (typeof STEP_TYPES)[number];
/** Future structured workouts. Stored in planned_workouts.structure; the Phase 1 form does not write it. */
export interface WorkoutStep { type: StepType; duration_s?: number; distance_m?: number; repeat?: number; target?: string; notes?: string }

export interface PlannedWorkout {
  id: string;
  planned_date: string;
  kind: PlannedKind;
  sport: string | null;
  title: string;
  duration_min: number | null;
  distance_m: number | null;
  intensity: string | null;
  routine_id: string | null;
  structure: WorkoutStep[] | null;
  notes: string | null;
  status: PlannedStatus;
  completed_at: string | null;
  completed_activity_id: number | null;
  completed_strength_session_id: string | null;
  link_origin: "manual" | "confirmed_match" | null;
  source: "manual" | "import" | "intervals" | "ics";
}
/** What the form can write. Status, completion and link columns are changed only through the dedicated actions. */
export type PlannedInput = Pick<PlannedWorkout, "planned_date" | "kind" | "sport" | "title" | "duration_min" | "distance_m" | "intensity" | "routine_id" | "structure" | "notes">;

// ------------------------------------------------------------------ validation
const YEAR_MIN = 2000, YEAR_MAX = 2100;

export function validateStructure(steps: unknown): string | null {
  if (steps === null || steps === undefined) return null;
  if (!Array.isArray(steps)) return "The workout structure must be a list of steps.";
  if (steps.length > 100) return "A workout can have at most 100 steps.";
  for (const [i, s] of steps.entries()) {
    const n = i + 1;
    if (!s || typeof s !== "object") return `Step ${n} is not valid.`;
    const o = s as Record<string, unknown>;
    if (!(STEP_TYPES as readonly unknown[]).includes(o.type)) return `Step ${n} has an unknown type.`;
    for (const [k, max] of [["duration_s", 86400], ["distance_m", 1_000_000], ["repeat", 100]] as const) {
      const v = o[k];
      if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > max)) return `Step ${n}: ${k} must be a positive number up to ${max}.`;
    }
    for (const k of ["target", "notes"] as const) if (o[k] !== undefined && (typeof o[k] !== "string" || (o[k] as string).length > 200)) return `Step ${n}: ${k} is too long.`;
  }
  return null;
}

/** Null when valid, otherwise a message that is safe to show. Mirrors the database checks in 15_training_calendar.sql. */
export function validatePlanned(i: PlannedInput): string | null {
  if (!isIsoDate(i.planned_date)) return "Choose a valid date.";
  const y = Number(i.planned_date.slice(0, 4));
  if (y < YEAR_MIN || y > YEAR_MAX) return `The date must be between ${YEAR_MIN} and ${YEAR_MAX}.`;
  if (!(KINDS as readonly string[]).includes(i.kind)) return "Choose a type.";
  const title = (i.title ?? "").trim();
  if (!title) return "Give the entry a title.";
  if (title.length > 120) return "The title can have at most 120 characters.";
  if (i.kind === "endurance" && !(ENDURANCE_SPORTS as readonly string[]).includes(i.sport ?? "")) return "Choose a sport for an endurance session.";
  if (i.kind === "strength" && i.sport !== null && i.sport !== "strength") return "A strength session uses the strength sport.";
  if ((i.kind === "rest" || i.kind === "milestone") && (i.duration_min !== null || i.distance_m !== null)) return "A rest day or milestone has no duration or distance.";
  if (i.duration_min !== null && (!Number.isInteger(i.duration_min) || i.duration_min < 1 || i.duration_min > 1440)) return "Duration must be a whole number of minutes between 1 and 1440.";
  if (i.distance_m !== null && (!Number.isFinite(i.distance_m) || i.distance_m <= 0 || i.distance_m > 1_000_000)) return "Distance must be greater than 0.";
  if (i.kind !== "endurance" && i.distance_m !== null) return "Distance only applies to endurance sessions.";
  if (i.intensity !== null && i.intensity.length > 200) return "The intensity note is too long (200 characters).";
  if (i.notes !== null && i.notes.length > 2000) return "Notes can have at most 2000 characters.";
  if (i.routine_id !== null && i.kind !== "strength") return "A routine can only be attached to a strength session.";
  return validateStructure(i.structure);
}

/** Cleans form values into a PlannedInput (trims text, empty strings become null, sport matches the kind). */
export function normalizePlanned(i: PlannedInput): PlannedInput {
  const t = (s: string | null) => (s && s.trim() ? s.trim() : null);
  const kind = i.kind;
  return {
    planned_date: i.planned_date, kind, title: (i.title ?? "").trim(),
    sport: kind === "endurance" ? i.sport : kind === "strength" ? "strength" : null,
    duration_min: kind === "rest" || kind === "milestone" ? null : i.duration_min,
    distance_m: kind === "endurance" ? i.distance_m : null,
    intensity: t(i.intensity), routine_id: kind === "strength" ? i.routine_id : null, notes: t(i.notes), structure: i.structure ?? null,
  };
}

// ------------------------------------------------------------------ calendar grids (calendar dates only: DST can never shift a day)
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const weekDays = (anchor: string): string[] => Array.from({ length: 7 }, (_, i) => addDaysIso(weekStart(anchor), i));
export const monthStart = (day: string) => `${day.slice(0, 7)}-01`;
/** First day of the month `n` months from the month of `day`. */
export function shiftMonth(day: string, n: number): string {
  const [y, m] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-01`;
}
export interface GridDay { day: string; inMonth: boolean }
/** Whole weeks (Monday first) covering the month of `anchor`: 5 or 6 rows of 7. */
export function monthGrid(anchor: string): GridDay[][] {
  const first = monthStart(anchor), next = shiftMonth(first, 1);
  const last = addDaysIso(next, -1);
  const rows: GridDay[][] = [];
  for (let s = weekStart(first); s <= last; s = addDaysIso(s, 7)) rows.push(weekDays(s).map((day) => ({ day, inMonth: day.slice(0, 7) === first.slice(0, 7) })));
  return rows;
}
const MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthLabel = (day: string) => `${MON[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
export function weekLabel(anchor: string): string {
  const d = weekDays(anchor), f = (s: string) => `${Number(s.slice(8))} ${MON[Number(s.slice(5, 7)) - 1].slice(0, 3)}`;
  return `${f(d[0])} – ${f(d[6])} ${d[6].slice(0, 4)}`;
}
/** Inclusive [from, to] day range the data loader needs for a view (month view includes the leading/trailing days of the grid). */
export function viewRange(view: "week" | "month", anchor: string): { from: string; to: string } {
  if (view === "week") { const d = weekDays(anchor); return { from: d[0], to: d[6] }; }
  const g = monthGrid(anchor);
  return { from: g[0][0].day, to: g[g.length - 1][6].day };
}

// ------------------------------------------------------------------ completed records (real data, never inferred from plans)
export interface DoneActivity { id: number; started_at: string; sport: string; title: string | null; duration_s: number | null; distance_m: number | null }
export interface DoneStrength { id: string; title: string; startedAt: string; endedAt: string | null; pausedSeconds: number; sets?: number }
export const strengthDurationS = (s: Pick<DoneStrength, "startedAt" | "endedAt" | "pausedSeconds">): number | null =>
  s.endedAt ? Math.max(0, Math.round((Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 1000) - (s.pausedSeconds || 0)) : null;

export interface CompletedItem {
  kind: "activity" | "strength"; id: string; title: string; sport: string; durationS: number | null; distanceM: number | null;
  /** Id of the plan this record is linked to, if any (display only). */
  plannedId: string | null; href: string;
}
export interface CalendarDay { day: string; planned: PlannedWorkout[]; completed: CompletedItem[]; races: Race[] }

export function linkedActivityIds(planned: PlannedWorkout[]): Map<number, string> {
  const m = new Map<number, string>();
  for (const p of planned) if (p.completed_activity_id !== null) m.set(Number(p.completed_activity_id), p.id);
  return m;
}
export function linkedStrengthIds(planned: PlannedWorkout[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of planned) if (p.completed_strength_session_id) m.set(p.completed_strength_session_id, p.id);
  return m;
}

const KIND_ORDER: Record<PlannedKind, number> = { milestone: 0, endurance: 1, strength: 2, rest: 3 };

/** One entry per calendar day in [from, to]. Planned, completed and race items are separate lists on purpose. Completed records are
 *  bucketed by the user's own time zone; planned dates and race dates are plain calendar dates and never shift. Finished strength
 *  sessions only (a workout still in progress is not "completed"). */
export function buildDays(a: {
  from: string; to: string; tz: string; planned: PlannedWorkout[]; races: Race[]; acts: DoneActivity[]; strength: DoneStrength[]; today: string;
}): CalendarDay[] {
  const days = new Map<string, CalendarDay>();
  for (let d = a.from, n = 0; d <= a.to && n < 400; d = addDaysIso(d, 1), n++) days.set(d, { day: d, planned: [], completed: [], races: [] });
  const la = linkedActivityIds(a.planned), ls = linkedStrengthIds(a.planned);
  for (const p of a.planned) days.get(p.planned_date)?.planned.push(p);
  for (const r of a.races) if (isUpcoming(r, a.today) || r.status === "completed" || r.status === "dnf") days.get(r.race_date)?.races.push(r);
  for (const x of a.acts) {
    days.get(localDay(x.started_at, a.tz))?.completed.push({
      kind: "activity", id: String(x.id), title: x.title || SPORT_NAME[x.sport] || "Activity", sport: x.sport, durationS: x.duration_s, distanceM: x.distance_m,
      plannedId: la.get(Number(x.id)) ?? null, href: "/activities",
    });
  }
  for (const s of a.strength) {
    if (!s.endedAt) continue;
    days.get(localDay(s.startedAt, a.tz))?.completed.push({
      kind: "strength", id: s.id, title: s.title, sport: "strength", durationS: strengthDurationS(s), distanceM: null, plannedId: ls.get(s.id) ?? null, href: `/strength/history/${s.id}`,
    });
  }
  for (const d of days.values()) {
    d.planned.sort((x, y) => KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || x.title.localeCompare(y.title));
    d.races.sort((x, y) => x.priority.localeCompare(y.priority));
  }
  return [...days.values()];
}

// ------------------------------------------------------------------ linking
/** Why a plan cannot be linked to a record (null = allowed). The database enforces the same rules; this gives a clear message first. */
export function linkProblem(plan: PlannedWorkout, rec: { kind: "activity" | "strength"; id: string }, all: PlannedWorkout[]): string | null {
  if (plan.kind !== "endurance" && plan.kind !== "strength") return "Only endurance and strength plans can be linked to a recorded session.";
  if (plan.kind === "endurance" && rec.kind !== "activity") return "An endurance plan can only be linked to an activity.";
  if (plan.kind === "strength" && rec.kind !== "strength") return "A strength plan can only be linked to a strength workout.";
  if (plan.completed_activity_id !== null || plan.completed_strength_session_id !== null) return "This plan is already linked to a recorded session.";
  const other = rec.kind === "activity" ? linkedActivityIds(all).get(Number(rec.id)) : linkedStrengthIds(all).get(rec.id);
  if (other) return "That session is already linked to a planned workout.";
  return null;
}

/** Out-of-order protection for async loads: take a ticket before each request, apply the result only if its ticket is still the latest. */
export function latestGate() {
  let n = 0;
  return { ticket: (): number => ++n, isLatest: (t: number): boolean => t === n };
}

/** A plan that is linked to a recorded session keeps its type: the database refuses a kind that no longer matches the link. To change it,
 *  the user reopens the plan first, which removes the link. */
export const kindLocked = (p: Pick<PlannedWorkout, "completed_activity_id" | "completed_strength_session_id">): boolean =>
  p.completed_activity_id !== null || p.completed_strength_session_id !== null;

export interface MatchSuggestion {
  plannedId: string; kind: "activity" | "strength"; recordId: string; recordTitle: string;
  /** Human-readable signals that support the suggestion. A suggestion is NEVER applied without the user's confirmation. */
  reasons: string[];
}

const SPORT_GROUP: Record<string, string> = { run: "run", running: "run", bike: "bike", cycling: "bike", ride: "bike", swim: "swim", swimming: "swim" };
const sportGroup = (s: string | null) => (s ? SPORT_GROUP[s.toLowerCase()] ?? "other" : "other");
const words = (s: string) => new Set(s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
const near = (a: number, b: number, tol: number) => a > 0 && b > 0 && Math.abs(a - b) / Math.max(a, b) <= tol;
export const DURATION_TOLERANCE = 0.35, DISTANCE_TOLERANCE = 0.25;

/** Candidate matches for plans still open. A candidate needs the same local day AND a compatible sport AND at least one independent
 *  second signal (similar duration, similar distance, or a shared title word): day and sport alone never produce a suggestion. Each
 *  record is offered to at most one plan and each plan gets at most one suggestion; records that are already linked are skipped. */
export function suggestMatches(a: { planned: PlannedWorkout[]; acts: DoneActivity[]; strength: DoneStrength[]; tz: string }): MatchSuggestion[] {
  const la = linkedActivityIds(a.planned), ls = linkedStrengthIds(a.planned);
  const open = a.planned.filter((p) => p.status === "planned" && (p.kind === "endurance" || p.kind === "strength"))
    .sort((x, y) => x.planned_date.localeCompare(y.planned_date) || x.id.localeCompare(y.id));
  const out: MatchSuggestion[] = [], used = new Set<string>();
  for (const p of open) {
    let best: { s: MatchSuggestion; score: number } | null = null;
    const consider = (kind: "activity" | "strength", id: string, title: string, durS: number | null, distM: number | null) => {
      if (used.has(`${kind}:${id}`)) return;
      const reasons = ["same day", p.kind === "endurance" ? `same sport (${SPORT_NAME[sportGroup(p.sport)] ?? "other"})` : "strength workout"];
      let signals = 0;
      if (p.duration_min && durS && near(p.duration_min * 60, durS, DURATION_TOLERANCE)) { signals++; reasons.push(`similar duration (${p.duration_min} min planned, ${Math.round(durS / 60)} min done)`); }
      if (p.distance_m && distM && near(p.distance_m, distM, DISTANCE_TOLERANCE)) { signals++; reasons.push("similar distance"); }
      const pw = words(p.title), shared = [...words(title)].filter((w) => pw.has(w));
      if (shared.length) { signals++; reasons.push(`title shares “${shared[0]}”`); }
      if (signals === 0) return;
      if (!best || signals > best.score) best = { s: { plannedId: p.id, kind, recordId: id, recordTitle: title, reasons }, score: signals };
    };
    if (p.kind === "endurance") {
      for (const x of a.acts) {
        if (x.sport === "strength" || la.has(Number(x.id)) || localDay(x.started_at, a.tz) !== p.planned_date) continue;
        if (sportGroup(x.sport) !== sportGroup(p.sport)) continue;
        consider("activity", String(x.id), x.title || SPORT_NAME[x.sport] || "Activity", x.duration_s, x.distance_m);
      }
    } else {
      for (const s of a.strength) {
        if (!s.endedAt || ls.has(s.id) || localDay(s.startedAt, a.tz) !== p.planned_date) continue;
        consider("strength", s.id, s.title, strengthDurationS(s), null);
      }
    }
    if (best) { const b = best as { s: MatchSuggestion }; out.push(b.s); used.add(`${b.s.kind}:${b.s.recordId}`); }
  }
  return out;
}

// ------------------------------------------------------------------ Today / summaries
export interface PlannedLite { id: string; planned_date: string; kind: PlannedKind; sport: string | null; title: string; duration_min: number | null; status: PlannedStatus }
/** Counts only. No load number is derived from plans: planned load never enters CTL/ATL/TSB. */
export function plannedCounts(planned: PlannedWorkout[], days: string[]) {
  const set = new Set(days), p = planned.filter((x) => set.has(x.planned_date));
  const sessions = p.filter((x) => x.kind === "endurance" || x.kind === "strength");
  return {
    planned: sessions.filter((x) => x.status === "planned").length,
    completed: sessions.filter((x) => x.status === "completed").length,
    skipped: sessions.filter((x) => x.status === "skipped").length,
    plannedMinutes: sessions.filter((x) => x.status === "planned").reduce((n, x) => n + (x.duration_min ?? 0), 0),
  };
}
export const detailOf = (p: Pick<PlannedWorkout, "kind" | "sport" | "duration_min" | "distance_m" | "intensity">): string => {
  const bits: string[] = [p.kind === "endurance" ? SPORT_NAME[p.sport ?? "other"] ?? "Endurance" : KIND_LABEL[p.kind]];
  if (p.duration_min) bits.push(p.duration_min >= 60 ? `${Math.floor(p.duration_min / 60)} h ${p.duration_min % 60 ? `${p.duration_min % 60} min` : ""}`.trim() : `${p.duration_min} min`);
  if (p.distance_m) bits.push(`${Number((p.distance_m / 1000).toFixed(1))} km`);
  if (p.intensity) bits.push(p.intensity);
  return bits.join(" · ");
};
