// Ask APEX: the workout snapshot sent with a question, and the allowlist of changes the assistant may PROPOSE. Pure (no I/O); used by
// both the server (validation) and the browser (confirmation and applying). Nothing here is ever applied without the user's confirmation.
import { CATALOG, resolveExercise, substitutesFor } from "./library.ts";
import { EQUIPMENT, LOAD_MODE_LABEL, SET_TYPES, SET_TYPE_LABEL, isCatalogKey, isUuid, type Equipment, type Exercise, type LoadMode, type SetType, type WeightUnit } from "./types.ts";
import { addExercise, addSet, findExercise, replaceExercise, setCurrent, setExerciseNote, setPatchError, setRest, updateSet, type Workout } from "./workout.ts";

// ------------------------------------------------------------------ snapshot (browser -> server)
export interface SnapSet { id: string; type: SetType; weight: number | null; unit: WeightUnit; reps: number | null; rpe: number | null; rir: number | null; duration_s: number | null; distance_m: number | null; completed: boolean }
export interface SnapExercise { id: string; key: string | null; name: string; loadMode: LoadMode; unit: WeightUnit; rest: number; superset: number | null; notes: string | null; sets: SnapSet[] }
export interface WorkoutSnapshot {
  workoutId: string; title: string; status: "active" | "completed"; routineName: string | null; elapsedMin: number; currentExerciseId: string | null;
  equipment: Equipment[]; objective: string; exercises: SnapExercise[];
}
export const SNAP_LIMITS = { exercises: 30, sets: 30, text: 300 } as const;

export function snapshotOf(w: Workout, o: { routineName?: string | null; elapsedMin: number; equipment: Equipment[]; objective: string; currentId: string | null }): WorkoutSnapshot {
  return {
    workoutId: w.id, title: w.title, status: w.status, routineName: o.routineName ?? null, elapsedMin: Math.round(o.elapsedMin), currentExerciseId: o.currentId, equipment: o.equipment, objective: o.objective.slice(0, SNAP_LIMITS.text),
    exercises: [...w.exercises].sort((a, b) => a.position - b.position).slice(0, SNAP_LIMITS.exercises).map((e) => ({
      id: e.id, key: e.key, name: e.name, loadMode: e.loadMode, unit: e.unit, rest: e.rest, superset: e.superset, notes: e.notes?.slice(0, SNAP_LIMITS.text) ?? null,
      sets: [...e.sets].sort((a, b) => a.position - b.position).slice(0, SNAP_LIMITS.sets).map((s) => ({ id: s.id, type: s.type, weight: s.weight, unit: s.unit, reps: s.reps, rpe: s.rpe, rir: s.rir, duration_s: s.duration_s, distance_m: s.distance_m, completed: s.completed })),
    })),
  };
}

/** Keep the request under the Coach route's 64 KB body limit. The current exercise stays complete; other exercises keep their last
 *  sets, then only their names. Set ids that remain are unchanged, so any proposal still refers to real sets. */
export function fitSnapshot(s: WorkoutSnapshot, maxBytes = 40_000): WorkoutSnapshot {
  const size = (x: WorkoutSnapshot) => new TextEncoder().encode(JSON.stringify(x)).length;
  if (size(s) <= maxBytes) return s;
  for (const keep of [5, 2, 0]) {
    const t = { ...s, exercises: s.exercises.map((e) => (e.id === s.currentExerciseId ? e : { ...e, notes: null, sets: e.sets.slice(-keep).slice(0, keep) })) };
    if (size(t) <= maxBytes) return t;
  }
  return { ...s, exercises: s.exercises.filter((e) => e.id === s.currentExerciseId).map((e) => ({ ...e, sets: e.sets.slice(-SNAP_LIMITS.sets) })) };
}

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/<\/?untrusted_user_text>/gi, "").trim().slice(0, max) : "");
const numOr = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

/** Strict validation of the snapshot the browser sends. Anything malformed is rejected, never "fixed" into something else. */
export function validateSnapshot(raw: unknown): { ok: true; snap: WorkoutSnapshot } | { ok: false; error: string } {
  const r = (raw && typeof raw === "object" ? raw : null) as Record<string, unknown> | null;
  if (!r) return { ok: false, error: "Invalid workout." };
  if (!isUuid(r.workoutId)) return { ok: false, error: "Invalid workout." };
  const exs = Array.isArray(r.exercises) ? r.exercises : null;
  if (!exs || exs.length > SNAP_LIMITS.exercises) return { ok: false, error: "Too many exercises in the workout." };
  const exercises: SnapExercise[] = [];
  for (const x of exs) {
    const e = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    if (!isUuid(e.id)) return { ok: false, error: "Invalid exercise in the workout." };
    const key = e.key === null || e.key === undefined ? null : typeof e.key === "string" && (isCatalogKey(e.key) || /^custom:[0-9a-f-]{36}$/i.test(e.key)) ? e.key : undefined;
    if (key === undefined) return { ok: false, error: "Invalid exercise in the workout." };
    const sets = Array.isArray(e.sets) ? e.sets : [];
    if (sets.length > SNAP_LIMITS.sets) return { ok: false, error: "Too many sets in one exercise." };
    const out: SnapSet[] = [];
    for (const y of sets) {
      const s = (y && typeof y === "object" ? y : {}) as Record<string, unknown>;
      if (!isUuid(s.id) || !SET_TYPES.includes(s.type as SetType)) return { ok: false, error: "Invalid set in the workout." };
      out.push({ id: s.id, type: s.type as SetType, weight: numOr(s.weight, 0, 2000), unit: s.unit === "lb" ? "lb" : "kg", reps: numOr(s.reps, 0, 1000), rpe: numOr(s.rpe, 1, 10), rir: numOr(s.rir, 0, 10), duration_s: numOr(s.duration_s, 0, 86400), distance_m: numOr(s.distance_m, 0, 1e6), completed: s.completed === true });
    }
    const mode = ["total", "per_hand", "added", "assisted", "none"].includes(e.loadMode as string) ? (e.loadMode as LoadMode) : "total";
    exercises.push({ id: e.id, key, name: clean(e.name, 120) || "Exercise", loadMode: mode, unit: e.unit === "lb" ? "lb" : "kg", rest: numOr(e.rest, 0, 1800) ?? 90, superset: numOr(e.superset, 1, 20), notes: clean(e.notes, SNAP_LIMITS.text) || null, sets: out });
  }
  const cur = r.currentExerciseId === null || r.currentExerciseId === undefined ? null : r.currentExerciseId;
  if (cur !== null && !exercises.some((e) => e.id === cur)) return { ok: false, error: "Invalid current exercise." };
  const equipment = Array.isArray(r.equipment) ? (r.equipment.filter((q) => EQUIPMENT.includes(q as Equipment)) as Equipment[]).slice(0, EQUIPMENT.length) : [];
  return { ok: true, snap: {
    workoutId: r.workoutId, title: clean(r.title, 120) || "Workout", status: r.status === "completed" ? "completed" : "active", routineName: clean(r.routineName, 80) || null,
    elapsedMin: numOr(r.elapsedMin, 0, 1440) ?? 0, currentExerciseId: cur as string | null, equipment: [...new Set(equipment)], objective: clean(r.objective, SNAP_LIMITS.text), exercises,
  } };
}

// ------------------------------------------------------------------ prompt facts (short labels E1, E1.S2 instead of ids, so the model cannot invent ids)
const fmtSet = (s: SnapSet, mode: LoadMode) => {
  const w = s.weight === null ? (mode === "none" ? "bodyweight" : "no weight") : `${s.weight} ${s.unit}${mode === "per_hand" ? " per hand" : mode === "added" ? " added" : mode === "assisted" ? " assistance" : ""}`;
  const body = s.duration_s ? `${s.duration_s}s` : s.distance_m ? `${s.distance_m} m` : `${w} × ${s.reps ?? "?"}`;
  return `${SET_TYPE_LABEL[s.type]}: ${body}${s.rpe !== null ? `, RPE ${s.rpe}` : ""}${s.rir !== null ? `, RIR ${s.rir}` : ""}, ${s.completed ? "done" : "planned"}`;
};
export interface StrengthFacts { lines: Array<{ label: string; value: string }>; current: SnapExercise | null; guide: Exercise | null; substitutes: Array<{ key: string; name: string; note: string }> }
/** `wrap` marks text the user typed (titles, notes, objective, custom names) so the model treats it as data, never as instructions. */
export function snapshotFacts(snap: WorkoutSnapshot, custom: readonly Exercise[] = [], wrap: (t: string) => string = (t) => t): StrengthFacts {
  const lines: Array<{ label: string; value: string }> = [];
  lines.push({ label: "Workout", value: `${wrap(snap.title)} (${snap.status === "active" ? `in progress, ${snap.elapsedMin} min` : "finished, historical"})${snap.routineName ? `, routine ${wrap(snap.routineName)}` : ""}` });
  if (snap.objective) lines.push({ label: "Objective (user)", value: wrap(snap.objective) });
  if (snap.equipment.length) lines.push({ label: "Equipment available", value: snap.equipment.join(", ") });
  const current = snap.exercises.find((e) => e.id === snap.currentExerciseId) ?? null;
  snap.exercises.forEach((e, i) => {
    const tag = `E${i + 1}${e.id === current?.id ? " (current)" : ""}`;
    const name = e.key && isCatalogKey(e.key) ? e.name : wrap(e.name);
    lines.push({ label: tag, value: `${name}; ${LOAD_MODE_LABEL[e.loadMode].toLowerCase()}; rest ${e.rest}s${e.superset ? `; superset ${e.superset}` : ""}${e.notes ? `; note: ${wrap(e.notes)}` : ""}` });
    e.sets.forEach((s, j) => lines.push({ label: `E${i + 1}.S${j + 1}`, value: fmtSet(s, e.loadMode) }));
  });
  const guide = current?.key ? resolveExercise(current.key, custom) : null;
  const substitutes = guide ? substitutesFor(guide, CATALOG, snap.equipment.length ? snap.equipment : undefined, 6).map((s) => ({ key: s.exercise.key, name: s.exercise.name, note: s.note })) : [];
  return { lines, current, guide, substitutes };
}

// ------------------------------------------------------------------ proposed actions (allowlist)
export type ProposedAction =
  | { type: "add_set"; exerciseId: string; weight: number | null; unit: WeightUnit; reps: number | null; rpe: number | null; rir: number | null; setType: SetType }
  | { type: "update_set"; exerciseId: string; setId: string; patch: { weight?: number | null; reps?: number | null; rpe?: number | null; rir?: number | null; type?: SetType } }
  | { type: "replace_exercise"; exerciseId: string; newKey: string }
  | { type: "add_exercise"; newKey: string; afterExerciseId: string | null }
  | { type: "set_rest"; exerciseId: string; seconds: number }
  | { type: "add_note"; exerciseId: string; text: string }
  | { type: "show_next"; exerciseId: string };
export const ACTION_TYPES = ["add_set", "update_set", "replace_exercise", "add_exercise", "set_rest", "add_note", "show_next"] as const;
export interface Proposal { action: ProposedAction; summary: string; extraConfirm: boolean; reason: string | null }
export const MAX_ACTIONS = 3;

/** Turn the model's raw action list into validated proposals. Unknown types, unknown references and out-of-range values are dropped. */
export function parseProposals(raw: unknown, snap: WorkoutSnapshot, custom: readonly Exercise[] = []): Proposal[] {
  if (!Array.isArray(raw)) return [];
  const out: Proposal[] = [];
  const exRef = (v: unknown) => { const m = typeof v === "string" ? /^E(\d{1,2})$/.exec(v.trim()) : null; return m ? snap.exercises[Number(m[1]) - 1] ?? null : null; };
  const setRef = (e: SnapExercise, v: unknown) => { const m = typeof v === "string" ? /^(?:E\d{1,2}\.)?S(\d{1,2})$/.exec(v.trim()) : null; return m ? e.sets[Number(m[1]) - 1] ?? null : null; };
  for (const item of raw.slice(0, MAX_ACTIONS)) {
    const a = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const p = toProposal(a, snap, custom, exRef, setRef);
    if (p) out.push(p);
  }
  return out;
}
function toProposal(a: Record<string, unknown>, snap: WorkoutSnapshot, custom: readonly Exercise[], exRef: (v: unknown) => SnapExercise | null, setRef: (e: SnapExercise, v: unknown) => SnapSet | null): Proposal | null {
  const historical = snap.status === "completed";
  const num = (v: unknown) => (v === null || v === undefined ? null : typeof v === "number" ? v : Number.NaN);
  switch (a.type) {
    case "add_set": {
      const e = exRef(a.exercise); if (!e) return null;
      const patch = { weight: num(a.weight), reps: num(a.reps), rpe: num(a.rpe), rir: num(a.rir) };
      if (setPatchError(patch)) return null;
      const setType = SET_TYPES.includes(a.set_type as SetType) ? (a.set_type as SetType) : "working";
      const unit: WeightUnit = a.unit === "lb" ? "lb" : a.unit === "kg" ? "kg" : e.unit;
      const action: ProposedAction = { type: "add_set", exerciseId: e.id, weight: patch.weight, unit, reps: patch.reps, rpe: patch.rpe, rir: patch.rir, setType };
      const w = patch.weight === null ? "" : `${patch.weight} ${unit}${e.loadMode === "per_hand" ? " per hand" : ""} × `;
      return { action, summary: `Add a ${SET_TYPE_LABEL[setType].toLowerCase()} set to ${e.name}: ${w}${patch.reps ?? "?"} reps${patch.rpe !== null ? ` @ RPE ${patch.rpe}` : ""}`, extraConfirm: historical, reason: historical ? "This changes a finished workout." : null };
    }
    case "update_set": {
      const e = exRef(a.exercise); if (!e) return null;
      const s = setRef(e, a.set); if (!s) return null;
      const patch: { weight?: number | null; reps?: number | null; rpe?: number | null; rir?: number | null; type?: SetType } = {};
      for (const k of ["weight", "reps", "rpe", "rir"] as const) if (k in a) patch[k] = num(a[k]);
      if ("set_type" in a) { if (!SET_TYPES.includes(a.set_type as SetType)) return null; patch.type = a.set_type as SetType; }
      if (Object.keys(patch).length === 0 || setPatchError(patch)) return null;
      const idx = e.sets.indexOf(s) + 1;
      const what = Object.entries(patch).map(([k, v]) => `${k === "type" ? "type" : k} ${k === "type" ? SET_TYPE_LABEL[v as SetType] : v}`).join(", ");
      const extra = historical || s.completed;
      return { action: { type: "update_set", exerciseId: e.id, setId: s.id, patch }, summary: `Change ${e.name} set ${idx}: ${what}`, extraConfirm: extra, reason: extra ? (historical ? "This changes a finished workout." : "This changes a set you already completed.") : null };
    }
    case "replace_exercise": {
      const e = exRef(a.exercise); if (!e) return null;
      const key = typeof a.new_exercise === "string" ? a.new_exercise : "";
      const ex = resolveExercise(key, custom); if (!ex || ex.key === e.key) return null;
      const done = e.sets.filter((s) => s.completed).length;
      return { action: { type: "replace_exercise", exerciseId: e.id, newKey: ex.key }, summary: `Replace ${e.name} with ${ex.name}${done ? ` (your ${done} completed set${done > 1 ? "s stay" : " stays"} recorded under ${e.name})` : ""}`, extraConfirm: historical, reason: historical ? "This changes a finished workout." : null };
    }
    case "add_exercise": {
      const key = typeof a.new_exercise === "string" ? a.new_exercise : "";
      const ex = resolveExercise(key, custom); if (!ex) return null;
      const after = a.after === null || a.after === undefined ? null : exRef(a.after);
      if (a.after !== null && a.after !== undefined && !after) return null;
      return { action: { type: "add_exercise", newKey: ex.key, afterExerciseId: after?.id ?? null }, summary: `Add ${ex.name}${after ? ` after ${after.name}` : " at the end"}`, extraConfirm: historical, reason: historical ? "This changes a finished workout." : null };
    }
    case "set_rest": {
      const e = exRef(a.exercise); if (!e) return null;
      const s = num(a.seconds);
      if (s === null || !Number.isInteger(s) || s < 0 || s > 1800) return null;
      return { action: { type: "set_rest", exerciseId: e.id, seconds: s }, summary: `Set rest for ${e.name} to ${s >= 60 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}` : `${s} s`}`, extraConfirm: false, reason: null };
    }
    case "add_note": {
      const e = exRef(a.exercise); if (!e) return null;
      const text = clean(a.text, 300); if (!text) return null;
      return { action: { type: "add_note", exerciseId: e.id, text }, summary: `Add a note to ${e.name}: "${text}"`, extraConfirm: historical, reason: historical ? "This changes a finished workout." : null };
    }
    case "show_next": {
      const cur = snap.exercises.findIndex((e) => e.id === snap.currentExerciseId);
      const next = snap.exercises.slice(cur + 1).find((e) => e.sets.some((s) => !s.completed));
      if (!next) return null;
      return { action: { type: "show_next", exerciseId: next.id }, summary: `Go to the next exercise: ${next.name}`, extraConfirm: false, reason: null };
    }
    default: return null;
  }
}

/** Apply a CONFIRMED proposal to the live workout (browser). Uses the same rules as manual edits. */
export function applyProposal(w: Workout, a: ProposedAction, o: { newId: () => string; custom: readonly Exercise[] }): Workout {
  switch (a.type) {
    case "add_set": {
      if (!findExercise(w, a.exerciseId)) throw new Error("That exercise is no longer in the workout.");
      const id = o.newId();
      let x = addSet(w, a.exerciseId, id, { type: a.setType });
      x = updateSet(x, a.exerciseId, id, { weight: a.weight, unit: a.unit, reps: a.reps, rpe: a.rpe, rir: a.rir });
      return x;
    }
    case "update_set": return updateSet(w, a.exerciseId, a.setId, a.patch);
    case "replace_exercise": {
      const ex = resolveExercise(a.newKey, o.custom); if (!ex) throw new Error("That exercise is not in the library.");
      return replaceExercise(w, a.exerciseId, ex, { newId: o.newId(), unit: findExercise(w, a.exerciseId)?.unit ?? "kg" });
    }
    case "add_exercise": {
      const ex = resolveExercise(a.newKey, o.custom); if (!ex) throw new Error("That exercise is not in the library.");
      const unit = w.exercises[0]?.unit ?? "kg";
      return addExercise(w, ex, { id: o.newId(), afterId: a.afterExerciseId, unit, setId: o.newId() });
    }
    case "set_rest": return setRest(w, a.exerciseId, a.seconds);
    case "add_note": { const e = findExercise(w, a.exerciseId); if (!e) throw new Error("That exercise is no longer in the workout."); return setExerciseNote(w, a.exerciseId, [e.notes, a.text].filter(Boolean).join(" · ")); }
    case "show_next": return setCurrent(w, a.exerciseId);
  }
}
