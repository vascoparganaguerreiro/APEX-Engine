// Ask APEX context: turns the validated workout snapshot and the user's real logged history into prompt blocks. Pure (no I/O).
// Only strength data is used here; nothing from biomarkers, supplements or wellness.
import { snapshotFacts, type WorkoutSnapshot } from "../strength/actions.ts";
import { E1RM_FORMULA, PR_LABEL, exerciseHistory, personalRecords, type HSession } from "../strength/analytics.ts";
import { CATALOG, normalizeName } from "../strength/library.ts";
import { MUSCLE_LABEL, type Exercise } from "../strength/types.ts";
import { untrusted } from "./schema.ts";
import type { Block, Fact } from "./context.ts";

const round = (n: number) => Math.round(n * 10) / 10;
const base = (name: string) => normalizeName(name.replace(/\(.*?\)/g, "")).split(" ").map((t) => t.replace(/s$/, "")).filter(Boolean);

/** Library exercises the question names ("add lateral raises" -> the lateral raise variants), so the model can only pick real keys. */
export function mentionedExercises(question: string, limit = 8): Exercise[] {
  const q = new Set(normalizeName(question).split(" ").map((t) => t.replace(/s$/, "")));
  return CATALOG.filter((e) => { const t = base(e.name); return t.length > 0 && t.every((w) => q.has(w)); }).slice(0, limit);
}

/** The snapshot as an analytics session (completed sets only), to check records against real history. */
export function snapshotSession(s: WorkoutSnapshot, startedAt: string): HSession {
  return {
    id: s.workoutId, title: s.title, startedAt, endedAt: null, pausedSeconds: 0, source: "apex",
    exercises: s.exercises.map((e) => ({ key: e.key, name: e.name, loadMode: e.loadMode, sets: e.sets.map((x) => ({ type: x.type, weight: x.weight, unit: x.unit, reps: x.reps, duration_s: x.duration_s, distance_m: x.distance_m, rpe: x.rpe, completed: x.completed })) })),
  };
}

export interface StrengthContext { blocks: Block[]; hasWorkout: boolean; historical: boolean; historySessions: number }
export function strengthBlocks(a: { snap: WorkoutSnapshot | null; history: HSession[]; question: string; now: string; tz?: string }): StrengthContext {
  const blocks: Block[] = [];
  const s = a.snap;
  const history = s ? a.history.filter((h) => h.id !== s.workoutId) : a.history;
  if (s) {
    const f = snapshotFacts(s, [], untrusted);
    blocks.push({ category: "strength", title: "Current workout (logged by the user; E = exercise, S = set)", facts: f.lines, priority: 0 });
    if (f.guide) {
      const g = f.guide;
      blocks.push({ category: "strength", title: `Exercise guide: ${g.name} (APEX library)`, priority: 1, facts: [
        { label: "Primary muscles", value: g.primary.map((m) => MUSCLE_LABEL[m]).join(", ") },
        { label: "Secondary muscles", value: g.secondary.map((m) => MUSCLE_LABEL[m]).join(", ") || "none listed" },
        { label: "How to", value: g.instructions.join(" / ") }, { label: "Cues", value: g.cues.join(" / ") }, { label: "Common mistakes", value: g.mistakes.join(" / ") },
        { label: "Default rest", value: `${g.rest} s` },
      ] });
    }
    if (f.substitutes.length) blocks.push({ category: "strength", title: "SUBSTITUTE OPTIONS (key: name - how it differs)", priority: 3, facts: f.substitutes.map((x) => ({ label: x.key, value: `${x.name} - ${x.note}` })) });
  }
  const mentioned = mentionedExercises(a.question);
  if (mentioned.length) blocks.push({ category: "strength", title: "EXERCISE KEYS named in the question", priority: 4, facts: mentioned.map((e) => ({ label: e.key, value: e.name })) });

  // History: only the exercises in this workout (or, without a workout, the most recent sessions), never invented.
  const keys = s ? [...new Set(s.exercises.map((e) => e.key).filter((k): k is string => Boolean(k)))] : [];
  const lines: Fact[] = [];
  if (s) {
    for (const k of keys.slice(0, 8)) {
      const h = exerciseHistory(history, { key: k }, a.tz).slice(-3);
      const name = s.exercises.find((e) => e.key === k)?.name ?? k;
      lines.push({ label: name, value: h.length ? h.map((x) => `${x.date}: best ${x.best ? `${round(x.best.weight)} ${x.best.unit} × ${x.best.reps}` : "-"}, ${x.workingSets} working sets${x.e1rmKg ? `, est. 1RM ${round(x.e1rmKg)} kg` : ""}`).join("; ") : "no earlier sessions logged" });
    }
    const pr = personalRecords(snapshotSession(s, a.now), [...history, snapshotSession(s, a.now)]);
    lines.push({ label: "Records in this workout so far", value: pr.prs.length ? pr.prs.map((p) => `${p.exerciseName}: ${PR_LABEL[p.kind]} ${round(p.value)} ${p.unit} (previous best ${round(p.previous)} ${p.unit})`).join("; ") : "none" });
    if (pr.baselines.length) lines.push({ label: "First time logged (no comparison possible)", value: pr.baselines.join(", ") });
  } else {
    for (const h of [...history].sort((x, y) => Date.parse(y.startedAt) - Date.parse(x.startedAt)).slice(0, 6)) lines.push({ label: h.startedAt.slice(0, 10), value: `${h.title}: ${h.exercises.map((e) => e.name).slice(0, 8).join(", ")}` });
  }
  lines.push({ label: "Estimated 1RM method", value: E1RM_FORMULA });
  blocks.push({ category: "strength", title: `Logged strength history (${history.length} sessions available)`, priority: 2, facts: lines });
  return { blocks, hasWorkout: Boolean(s), historical: s?.status === "completed", historySessions: history.length };
}
