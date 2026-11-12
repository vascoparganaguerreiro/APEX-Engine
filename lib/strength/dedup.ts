// Duplicate detection and canonical training sessions (Garmin / Intervals / Strava activities vs APEX or Hevy strength sessions).
// Pure (no I/O). Source records are never modified: a merge only links them to one canonical session (see 13_strength.sql).
import { localDay } from "../activities.ts";
import { durationSeconds } from "./analytics.ts";

export interface ActivitySource {
  kind: "activity"; id: number; startedAt: string; durationS: number | null; elapsedS: number | null; sport: string; title: string | null;
  origin: string | null; device: string | null; avgHr: number | null; maxHr: number | null; calories: number | null; load: number | null;
}
export interface StrengthSource {
  kind: "strength"; id: string; startedAt: string; endedAt: string | null; title: string; source: "apex" | "hevy_csv";
  /** Working exercises and working sets only (completed, not warm-up): see workingExercises / workingSetCount in analytics.ts. */
  exercises: number; sets: number; exerciseNames: string[];
  /** Seconds the workout was paused. Optional so older callers and fixtures keep working (treated as 0). */
  pausedS?: number;
}
export type Source = ActivitySource | StrengthSource;
export interface Link { trainingSessionId: string; activityId: number | null; strengthSessionId: string | null; role: "primary" | "secondary" }
export interface Decision { pairKey: string; decision: "merged" | "separate"; trainingSessionId: string | null; revertedAt: string | null }

export const sourceKey = (s: Pick<Source, "kind" | "id">) => `${s.kind}:${s.id}`;
/** Same ordering as the SQL (collate "C"): plain code-unit order of "kind:id". */
export const pairKey = (a: Pick<Source, "kind" | "id">, b: Pick<Source, "kind" | "id">) => [sourceKey(a), sourceKey(b)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)).join("|");

export function interval(s: Source): { start: number; end: number | null } {
  const start = Date.parse(s.startedAt);
  if (s.kind === "activity") { const d = s.elapsedS ?? s.durationS; return { start, end: d && d > 0 ? start + d * 1000 : null }; }
  return { start, end: s.endedAt ? Date.parse(s.endedAt) : null };
}
/** The duration to SHOW for a record. An activity keeps its own; a strength log shows the time actually worked (start to end minus paused
 *  seconds), computed by the same durationSeconds that Strength and Today use. interval() stays wall-clock: overlap matching needs that. */
export function displayDurationS(s: Source): number | null {
  if (s.kind === "strength") return durationSeconds({ startedAt: s.startedAt, endedAt: s.endedAt, pausedSeconds: s.pausedS ?? 0 });
  const i = interval(s);
  return i.end === null ? null : Math.round((i.end - i.start) / 1000);
}
const BRAND: Array<[string, string]> = [["GARMIN", "Garmin"], ["STRAVA", "Strava"], ["COROS", "COROS"], ["POLAR", "Polar"], ["SUUNTO", "Suunto"], ["ZEPP", "Amazfit/Zepp"], ["WHOOP", "WHOOP"], ["WAHOO", "Wahoo"], ["HUAWEI", "Huawei"]];
const originLabel = (o: string | null) => { const v = (o ?? "").toUpperCase(); return BRAND.find(([k]) => v.includes(k))?.[1] ?? (v ? v.toLowerCase() : "Intervals.icu"); };
export function sourceLabel(s: Source): string { return s.kind === "strength" ? (s.source === "hevy_csv" ? "Hevy import" : "APEX log") : `${originLabel(s.origin)} activity`; }

/** Can these two records be the same session? strength activities match strength logs; a generic "other" activity only weakly. */
function sportFit(a: Source, b: Source): "strong" | "weak" | "none" {
  const sp = (s: Source) => (s.kind === "strength" ? "strength" : s.sport);
  const x = sp(a), y = sp(b);
  if (x === y) return "strong";
  if ((x === "strength" && y === "other") || (x === "other" && y === "strength")) return "weak";
  return "none";
}

export type Confidence = "high" | "medium" | "low";
export interface Candidate { a: Source; b: Source; key: string; confidence: Confidence; overlap: number; startDiffMin: number; reasons: string[] }

/** Score one pair. Same calendar date alone is never enough: real time overlap (or near-identical start times when a duration is
 *  missing) is required. */
export function scorePair(a: Source, b: Source, tz?: string): Candidate {
  const ia = interval(a), ib = interval(b), reasons: string[] = [];
  const startDiffMin = Math.abs(ia.start - ib.start) / 60_000;
  const fit = sportFit(a, b);
  let overlap = 0;
  if (ia.end !== null && ib.end !== null) {
    const o = Math.min(ia.end, ib.end) - Math.max(ia.start, ib.start), d = Math.min(ia.end - ia.start, ib.end - ib.start);
    overlap = o <= 0 ? 0 : d <= 0 ? 1 : Math.min(1, o / d);
  }
  let confidence: Confidence = "low";
  if (fit === "none") reasons.push("different sports");
  else if (ia.end !== null && ib.end !== null) {
    if (overlap >= 0.6 && startDiffMin <= 20 && fit === "strong") confidence = "high";
    else if (overlap >= 0.3) confidence = "medium";
  } else if (startDiffMin <= 10) confidence = "medium";                 // one side has no end time: only near-identical starts qualify
  if (overlap > 0) reasons.push(`${Math.round(overlap * 100)}% of the shorter session overlaps`);
  reasons.push(`starts ${Math.round(startDiffMin)} min apart`);
  if (fit === "weak") reasons.push("activity type is generic, not strength");
  if (localDay(a.startedAt, tz) === localDay(b.startedAt, tz) && confidence === "low" && fit !== "none") reasons.push("same day but the times do not overlap");
  return { a, b, key: pairKey(a, b), confidence, overlap, startDiffMin, reasons };
}

/** Candidate duplicates worth showing (high and medium only), excluding pairs already decided and records already merged. */
export function findCandidates(sources: Source[], links: Link[], decisions: Decision[], tz?: string): Candidate[] {
  const linked = new Set(links.map((l) => (l.activityId !== null ? `activity:${l.activityId}` : `strength:${l.strengthSessionId}`)));
  const decided = new Set(decisions.filter((d) => !d.revertedAt).map((d) => d.pairKey));
  const list = sources.filter((s) => !linked.has(sourceKey(s))).sort((x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt));
  const out: Candidate[] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (Date.parse(list[j].startedAt) - Date.parse(list[i].startedAt) > 12 * 3_600_000) break;     // sorted: nothing later can overlap
      const a = list[i], b = list[j];
      if (a.kind === "strength" && b.kind === "strength" && a.source === b.source && a.source === "apex") continue;   // two APEX logs are two workouts
      const c = scorePair(a, b, tz);
      if (c.confidence !== "low" && !decided.has(c.key)) out.push(c);
    }
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((x, y) => rank[x.confidence] - rank[y.confidence] || Date.parse(y.a.startedAt) - Date.parse(x.a.startedAt));
}

// ------------------------------------------------------------------ the merged (canonical) view
export interface Provenanced<T> { value: T; source: string }
export interface MergedView {
  title: Provenanced<string>; startedAt: Provenanced<string>; durationS: Provenanced<number | null>; avgHr: Provenanced<number | null> | null; maxHr: Provenanced<number | null> | null;
  calories: Provenanced<number | null> | null; load: Provenanced<number | null> | null; exercises: Provenanced<string[]> | null; sets: Provenanced<number> | null; sourceIds: string[];
}
/** Garmin keeps the physiology (heart rate, calories, load); the strength log keeps exercises and sets; the primary decides title and time. */
export function mergedView(a: Source, b: Source, primary: Source): MergedView {
  const act = [a, b].find((s): s is ActivitySource => s.kind === "activity") ?? null;
  const str = [a, b].find((s): s is StrengthSource => s.kind === "strength") ?? null;
  const dur = displayDurationS;
  const lab = sourceLabel;
  return {
    title: { value: (primary.kind === "activity" ? primary.title : primary.title) ?? "Training session", source: lab(primary) },
    startedAt: { value: primary.startedAt, source: lab(primary) },
    durationS: { value: dur(primary) ?? dur(primary === a ? b : a), source: dur(primary) !== null ? lab(primary) : lab(primary === a ? b : a) },
    avgHr: act ? { value: act.avgHr, source: lab(act) } : null, maxHr: act ? { value: act.maxHr, source: lab(act) } : null,
    calories: act ? { value: act.calories, source: lab(act) } : null, load: act ? { value: act.load, source: lab(act) } : null,
    exercises: str ? { value: str.exerciseNames, source: lab(str) } : null, sets: str ? { value: str.sets, source: lab(str) } : null,
    sourceIds: [sourceKey(a), sourceKey(b)],
  };
}

// ------------------------------------------------------------------ counting each workout once
/** Records that must not be counted on their own because they are the secondary side of a merge. */
export function secondaryIds(links: Link[]): { activities: Set<number>; strength: Set<string> } {
  const activities = new Set<number>(), strength = new Set<string>();
  for (const l of links) if (l.role === "secondary") { if (l.activityId !== null) activities.add(l.activityId); if (l.strengthSessionId) strength.add(l.strengthSessionId); }
  return { activities, strength };
}
/** Activity ids whose training load must be ignored: an activity that duplicates ANOTHER activity (e.g. a Strava copy of a Garmin
 *  recording). An activity merged with a strength log keeps its load: strength logs carry no load, so it is still counted once. */
export function loadExcludedActivityIds(links: Link[]): Set<number> {
  const groups = new Map<string, Link[]>();
  for (const l of links) groups.set(l.trainingSessionId, [...(groups.get(l.trainingSessionId) ?? []), l]);
  const out = new Set<number>();
  for (const g of groups.values()) {
    const acts = g.filter((l) => l.activityId !== null);
    if (acts.length < 2) continue;
    const keep = acts.find((l) => l.role === "primary") ?? acts[0];
    for (const l of acts) if (l !== keep) out.add(l.activityId as number);
  }
  return out;
}
/** Strength sessions to leave out of strength analytics: a secondary that duplicates another strength log (APEX + Hevy of one workout). */
export function strengthExcludedIds(links: Link[]): Set<string> {
  const groups = new Map<string, Link[]>();
  for (const l of links) groups.set(l.trainingSessionId, [...(groups.get(l.trainingSessionId) ?? []), l]);
  const out = new Set<string>();
  for (const g of groups.values()) {
    const str = g.filter((l) => l.strengthSessionId);
    if (str.length < 2) continue;
    const keep = str.find((l) => l.role === "primary") ?? str[0];
    for (const l of str) if (l !== keep) out.add(l.strengthSessionId as string);
  }
  return out;
}

export interface TrainingItem { key: string; startedAt: string; title: string; sport: string; durationS: number | null; sources: string[]; merged: boolean; href: string | null; detail: string }
/** One entry per real workout for the unified Timeline and for cross-sport frequency counts. */
export function trainingItems(sources: Source[], links: Link[]): TrainingItem[] {
  const bySource = new Map(sources.map((s) => [sourceKey(s), s]));
  const groups = new Map<string, Link[]>();
  for (const l of links) groups.set(l.trainingSessionId, [...(groups.get(l.trainingSessionId) ?? []), l]);
  const used = new Set<string>(), out: TrainingItem[] = [];
  for (const [tid, g] of groups) {
    const members = g.map((l) => bySource.get(l.activityId !== null ? `activity:${l.activityId}` : `strength:${l.strengthSessionId}`)).filter((s): s is Source => Boolean(s));
    if (members.length === 0) continue;
    members.forEach((m) => used.add(sourceKey(m)));
    const primaryLink = g.find((l) => l.role === "primary");
    const primary = members.find((m) => primaryLink && sourceKey(m) === (primaryLink.activityId !== null ? `activity:${primaryLink.activityId}` : `strength:${primaryLink.strengthSessionId}`)) ?? members[0];
    out.push(itemOf(primary, members, `ts:${tid}`));
  }
  for (const s of sources) if (!used.has(sourceKey(s))) out.push(itemOf(s, [s], sourceKey(s)));
  return out.sort((x, y) => Date.parse(y.startedAt) - Date.parse(x.startedAt));
}
function itemOf(primary: Source, members: Source[], key: string): TrainingItem {
  const str = members.find((m): m is StrengthSource => m.kind === "strength");
  const act = members.find((m): m is ActivitySource => m.kind === "activity");
  const detail = [str ? `${str.exercises} exercises, ${str.sets} sets` : null, act?.avgHr ? `avg HR ${act.avgHr}` : null, act?.load ? `load ${act.load}` : null].filter(Boolean).join(" · ");
  return {
    key, startedAt: primary.startedAt, title: (primary.kind === "activity" ? primary.title : primary.title) ?? "Training", sport: primary.kind === "strength" ? "strength" : primary.sport,
    durationS: displayDurationS(primary), sources: members.map(sourceLabel), merged: members.length > 1,
    href: str ? `/strength/history/${str.id}` : act ? "/activities" : null, detail,
  };
}
