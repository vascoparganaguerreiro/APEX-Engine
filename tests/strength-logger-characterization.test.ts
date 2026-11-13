// Stage 1 safety net for the premium workout logger. These tests pin down how logging behaves TODAY (number boxes, completion, autosave, recovery, history
// editing), so the upcoming keypad, table, header, timer and drag-and-drop changes can be checked against it. They describe existing behaviour; none changes it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryStore, SyncEngine } from "../lib/strength/sync.ts";
import { commitOf } from "../lib/strength/keypad.ts";
import {
  addExercise, addSet, afterSet, completeSet, currentExercise, moveExercise, progress, setCurrent, startWorkout, updateSet, WorkoutError, type Workout,
} from "../lib/strength/workout.ts";
import { FakeStrengthServer, T0, at, clock, ex, transportFor, uid, testOwner } from "./strength-fixtures.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const editor = read("components/strength/WorkoutEditor.tsx"), page = read("app/(app)/strength/page.tsx"), history = read("app/(app)/strength/history/[id]/page.tsx");
const fresh = (): Workout => startWorkout({ id: uid(), now: T0, newId: uid, defaultUnit: "kg", timezone: "Europe/Lisbon" });
const lift = (w: Workout, key: string, sets = 1) => {
  let x = addExercise(w, ex(key), { id: uid(), unit: "kg", setId: uid() });
  const e = x.exercises[x.exercises.length - 1];
  for (let i = 1; i < sets; i++) x = addSet(x, e.id, uid());
  return x;
};

test("number boxes: show typed text, select on focus, commit each valid value at once, restore on blur", () => {
  const nf = editor.slice(editor.indexOf("function NumField"), editor.indexOf("const nextType"));
  assert.match(nf, /const \[text, setText\] = useState\(value === null \? "" : String\(value\)\)/);
  assert.match(nf, /useEffect\(\(\) => \{ if \(!focused\.current\) setText\(/, "outside changes never overwrite what is being typed");
  assert.match(nf, /onFocus=\{\(e\) => \{ focused\.current = true; e\.currentTarget\.select\(\); \}\}/, "focus selects the value, so the first key replaces it");
  assert.match(nf, /onBlur=\{\(\) => \{ focused\.current = false; setText\(value === null \? "" : String\(value\)\); \}\}/, "blur shows the saved value again");
  assert.match(nf, /inputMode=\{integer \? "numeric" : "decimal"\}/);
  // the values it commits, for what a person types
  for (const [typed, saved] of [["82", 82], ["82.", 82], ["82,5", 82.5], ["", null], [".", undefined], ["x", undefined]] as const) assert.equal(commitOf(typed), saved, JSON.stringify(typed));
  // which boxes are whole-number and what they write into the set
  assert.match(editor, /integer=\{f\.key === "reps" \|\| f\.key === "duration_s"\}/);
  assert.match(editor, /onCommit=\{\(v\) => patch\(\{ \[f\.key!\]: v, \.\.\.\(f\.key === "weight" \? \{ unit: e\.unit \} : \{\}\) \}\)\}/, "a weight is saved together with the exercise's unit");
  assert.match(editor, /const patch = \(p: SetPatch\) => act\(\(\) => updateSet\(w, e\.id, s\.id, p\)\)/, "every edit goes through the pure updateSet");
});

test("a rejected value leaves the workout untouched and reports why", () => {
  let w = lift(fresh(), "barbell_bench_press"); const e = w.exercises[0], before = JSON.stringify(w);
  assert.throws(() => updateSet(w, e.id, e.sets[0].id, { weight: 2001 }), WorkoutError);
  assert.throws(() => updateSet(w, e.id, e.sets[0].id, { reps: 8.5 }), WorkoutError);
  assert.equal(JSON.stringify(w), before, "nothing changed");
  assert.match(editor, /const act = \(f: \(\) => Workout\) => \{ try \{ save\(f\(\)\); setError\(null\); \} catch \(e\) \{ setError\(/, "the editor shows the engine's message");
  w = updateSet(w, e.id, e.sets[0].id, { weight: 82.5, reps: 8 });
  assert.deepEqual([w.exercises[0].sets[0].weight, w.exercises[0].sets[0].reps], [82.5, 8]);
});

test("completing a set: needs its values, prefills the next set, picks what is current next, and starts rest only in a live workout", () => {
  let w = lift(fresh(), "barbell_bench_press", 2); const e = w.exercises[0], [s1, s2] = e.sets;
  assert.throws(() => completeSet(w, e.id, s1.id, at(1)), /reps/, "reps are required first");
  w = updateSet(w, e.id, s1.id, { weight: 80, reps: 8 }); w = updateSet(w, e.id, s2.id, { weight: null, reps: null });
  w = completeSet(w, e.id, s1.id, at(2));
  const sets = w.exercises[0].sets;
  assert.equal(sets[0].completed, true); assert.equal(sets[0].completed_at, at(2));
  assert.deepEqual([sets[1].weight, sets[1].reps], [80, 8], "the next empty set is prefilled, and stays editable");
  assert.deepEqual(progress(w), { done: 1, total: 2, exercisesDone: 0, exercises: 1 });
  const a = afterSet(w, e.id);
  assert.equal(a.goTo, e.id); assert.equal(a.restSeconds, e.rest);
  // the editor: complete -> afterSet -> setCurrent -> save -> rest (live mode only)
  assert.match(editor, /let next = completeSet\(w, e\.id, s\.id, new Date\(\)\.toISOString\(\)\);\s*const a = afterSet\(next, e\.id\);\s*next = setCurrent\(next, a\.goTo\);\s*save\(next\); setError\(null\);\s*if \(mode === "live" && a\.restSeconds > 0\) onRest\?\.\(a\.restSeconds, e\.name\);/);
  assert.equal(currentExercise(setCurrent(w, e.id))?.id, e.id);
});

test("autosave: every committed value is on the device straight away, and a reload brings the active workout back exactly", async () => {
  const server = new FakeStrengthServer(), store = new MemoryStore(), t = transportFor(server);
  let engine = new SyncEngine(store, t, clock(), testOwner()); await engine.load();
  let w = lift(fresh(), "barbell_bench_press", 2); const e = w.exercises[0];
  await engine.record(w, { active: true });
  // typing "82.5" into the weight box commits 8, 82, 82 (for "82."), 82.5 in turn, each one saved
  for (const text of ["8", "82", "82.", "82.5"]) { const v = commitOf(text); if (v !== undefined) { w = updateSet(w, e.id, e.sets[0].id, { weight: v, unit: "kg" }); await engine.record(w, { active: true }); } }
  w = updateSet(w, e.id, e.sets[0].id, { reps: 8 }); w = completeSet(w, e.id, e.sets[0].id, at(3)); w = setCurrent(w, e.id);
  await engine.record(w, { active: true });
  // "the app is closed": a new engine over the same device store
  engine = new SyncEngine(store, t, clock(), testOwner()); await engine.load();
  const back = engine.local.activeId ? engine.local.workouts[engine.local.activeId] : null;
  assert.ok(back, "the active workout is recovered");
  assert.equal(back!.id, w.id);
  assert.deepEqual(back!.exercises.map((x) => x.id), [e.id]);
  const [a, b] = back!.exercises[0].sets;
  assert.deepEqual([a.weight, a.reps, a.completed, a.completed_at], [82.5, 8, true, at(3)]);
  assert.deepEqual([b.weight, b.reps, b.completed], [82.5, 8, false], "the prefilled next set came back too");
  await engine.flush();
  assert.equal(server.live("set").length, 2, "and it uploads");
});

test("the page saves every change to the device first and uploads shortly after; the workout and the rest timer are restored on load", () => {
  assert.match(page, /const save = useCallback\(\(next: Workout, o: \{ active\?: boolean \} = \{ active: true \}\) => \{\s*setW\(next\);/);
  assert.match(page, /eng\.record\(next, o\)\.catch\(\(e\) => setError\(`Could not save on this device: /);
  assert.match(page, /flushTimer\.current = window\.setTimeout\(\(\) => \{ void eng\.flush\(\); \}, 1200\)/);
  assert.match(page, /setW\(local\.activeId \? local\.workouts\[local\.activeId\] \?\? null : null\)/, "recovery on load");
  assert.match(page, /setRest\(loadRest\(session\.user\.id\)\)/, "the rest timer is restored for this user");
  assert.match(page, /const startRest = \(seconds: number, label: string\) => \{ const r = \{ endAt: Date\.now\(\) \+ seconds \* 1000, pausedLeft: null, total: seconds, label \}; saveRest\(/);
  assert.match(page, /await engineRef\.current\?\.record\(done, \{ active: false \}\);\s*void engineRef\.current\?\.flush\(\);\s*router\.push\(/, "finishing records first, then leaves");
  assert.match(page, /<WorkoutEditor w=\{w\} save=\{save\}[^>]*mode="live" onRest=\{startRest\} \/>/);
});

test("history editing is separate: native boxes, no rest timer, no current-exercise highlight", () => {
  assert.match(history, /<WorkoutEditor w=\{w\} save=\{save\}[^>]*mode="edit" \/>/); assert.doesNotMatch(history, /onRest/);
  assert.match(editor, /const isCur = mode === "live" && cur\?\.id === e\.id;/);
  assert.match(editor, /if \(mode === "live" && a\.restSeconds > 0\) onRest\?\.\(/);
  assert.match(editor, /const historical = w\.status === "completed";/, "finished workouts ask before deleting data");
  assert.match(editor, /window\.confirm\(historical \? "This workout is finished\./);
});

test("exercise order: moveExercise keeps every exercise, set, value and completion exactly", () => {
  let w = lift(lift(lift(fresh(), "barbell_bench_press", 2), "barbell_row", 2), "dumbbell_lateral_raise", 1);
  const [a, b] = w.exercises;
  w = updateSet(w, a.id, a.sets[0].id, { weight: 80, reps: 8, rpe: 8 }); w = completeSet(w, a.id, a.sets[0].id, at(1));
  w = updateSet(w, b.id, b.sets[1].id, { weight: 60, reps: 10, rir: 2 });
  const sig = (x: Workout) => JSON.stringify([...x.exercises].sort((p, q) => p.id.localeCompare(q.id)).map((e) => ({ ...e, position: 0 })));
  const before = sig(w), ids = new Set(w.exercises.map((e) => e.id)), setIds = new Set(w.exercises.flatMap((e) => e.sets.map((s) => s.id)));
  for (const [id, to] of [[a.id, 2], [w.exercises[2].id, 0], [b.id, 0], [a.id, 99], [b.id, -5]] as const) {
    const moved = moveExercise(w, id, to);
    assert.equal(sig(moved), before, "all data identical apart from order");
    assert.deepEqual(new Set(moved.exercises.map((e) => e.id)), ids); assert.deepEqual(new Set(moved.exercises.flatMap((e) => e.sets.map((s) => s.id))), setIds);
    assert.deepEqual([...moved.exercises].sort((p, q) => p.position - q.position).map((e) => e.position), [0, 1, 2], "positions are 0..n-1, no gaps or duplicates");
    assert.equal(moved.currentId, w.currentId, "the current exercise is unchanged");
  }
  assert.throws(() => moveExercise(w, "nope", 0), WorkoutError);
});

test("baseline of the live screen that later stages change on purpose (so each change is deliberate, not accidental)", () => {
  // header controls and floating buttons that exist today
  for (const s of ['className="wk-head"', 'aria-label="Workout name"', 'aria-label="Workout duration"', "▶ Resume", "❚❚ Pause", "Cancel workout", "Enable rest alerts", "💬 Ask APEX", "<RestTimer rest={rest}"]) assert.ok((page + read("components/strength/WorkoutHeader.tsx")).includes(s), `today (page or header, since Stage 4 moved the header into its own component): ${s}`);
  // the editor's per-set row (compact table since Stage 2: Set | Previous | KG | Reps | Done; extras open from the set number)
  for (const s of ['className="setgrid hdr"', "<span>Previous</span>", "<span>Done</span>", 'className={`setrow${s.completed ? " done" : ""}${warm ? " warmup" : ""}`}', 'className={s.completed ? "donebtn on" : "donebtn"}', 'aria-pressed={s.completed}', 'className="setextra setdetails"']) assert.ok(editor.includes(s), `editor: ${s}`);
  // exercise reorder today: buttons in the options menu
  assert.match(editor, /↑ Move up/); assert.match(editor, /↓ Move down/); assert.match(editor, /moveExercise\(w, e\.id, ei - 1\)/);
  // no drag-and-drop exists yet, and no dependency was added for it
  assert.doesNotMatch(editor + page, /onPointerDown|draggable|dragstart|@dnd-kit/);
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["@supabase/supabase-js", "next", "react", "react-dom"], "no drag-and-drop or UI library is installed");
});
