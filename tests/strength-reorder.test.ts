// Reordering exercises in the live workout by long-press and drag (or keyboard): ordering, data preservation, cancellation, accessibility, scope.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EDGE_PX, IDLE, LONG_PRESS_MS, MAX_SCROLL_PX, MOVE_TOLERANCE_PX, announce, indicatorBefore, keyMove, pressMoved, scrollSpeed, step, targetIndex,
  type DragEvent, type DragState,
} from "../lib/strength/reorder.ts";
import { MemoryStore, SyncEngine } from "../lib/strength/sync.ts";
import { addExercise, addSet, completeSet, moveExercise, setSuperset, startWorkout, updateSet, type Workout } from "../lib/strength/workout.ts";
import { FakeStrengthServer, T0, at, clock, ex, transportFor, uid, testOwner } from "./strength-fixtures.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const editor = read("components/strength/WorkoutEditor.tsx"), hook = read("components/strength/useExerciseDrag.ts"), css = read("app/globals.css");
const KEYS = ["barbell_bench_press", "barbell_row", "bulgarian_split_squat", "plank", "pull_up"];

/** A workout with real data in every exercise, so any loss or mix-up shows. */
function loaded(): Workout {
  let w = startWorkout({ id: uid(), now: T0, newId: uid, defaultUnit: "kg", timezone: "Europe/Lisbon" });
  KEYS.forEach((k, i) => {
    w = addExercise(w, ex(k), { id: uid(), unit: i % 2 ? "lb" : "kg", setId: uid() });
    const e = w.exercises[w.exercises.length - 1]; w = addSet(w, e.id, uid());
    const [s1, s2] = w.exercises[w.exercises.length - 1].sets;
    if (k === "plank") { w = updateSet(w, e.id, s1.id, { duration_s: 45 }); w = completeSet(w, e.id, s1.id, at(i)); }
    else { w = updateSet(w, e.id, s1.id, { weight: 20 + i * 5, reps: 8 + i, rpe: 8, notes: `note ${i}` }); w = completeSet(w, e.id, s1.id, at(i)); w = updateSet(w, e.id, s2.id, { weight: 22.5 + i, reps: 6 }); }
  });
  w = setSuperset(w, [w.exercises[1].id, w.exercises[2].id]);
  return { ...w, currentId: w.exercises[3].id };
}
const sorted = (w: Workout) => [...w.exercises].sort((a, b) => a.position - b.position);
const idsOf = (w: Workout) => sorted(w).map((e) => e.id);
/** Everything about the exercises EXCEPT their position, keyed by id: dragging must not change any of it. */
const content = (w: Workout) => JSON.stringify([...w.exercises].sort((a, b) => a.id.localeCompare(b.id)).map((e) => ({ ...e, position: 0 })));

// ------------------------------------------------------------------ the numbers
test("long press and tolerance: about 250 ms and 5 px", () => {
  assert.equal(LONG_PRESS_MS, 250); assert.equal(MOVE_TOLERANCE_PX, 5);
  assert.equal(pressMoved(0, 0, 3, 4), false, "exactly 5 px is still a press");
  assert.equal(pressMoved(0, 0, 0, 6), true); assert.equal(pressMoved(10, 10, 14, 14), true, "diagonal 5.66 px"); assert.equal(pressMoved(10, 10, 12, 12), false);
  assert.equal(pressMoved(0, 0, 0, 20, 30), false, "the tolerance can be tuned");
});

test("where a drop lands: the number of other exercises above the pointer, which is moveExercise's index", () => {
  const mids = [100, 300, 500];                                   // the middles of the OTHER exercises, top to bottom
  assert.equal(targetIndex(mids, 0), 0); assert.equal(targetIndex(mids, 99), 0); assert.equal(targetIndex(mids, 101), 1); assert.equal(targetIndex(mids, 301), 2); assert.equal(targetIndex(mids, 9999), 3);
  assert.equal(targetIndex(mids, 100), 0, "exactly on a middle: not past it"); assert.equal(targetIndex([], 50), 0, "a single exercise");
  assert.equal(indicatorBefore(["a", "b", "c", "d"], "b", 0), "a"); assert.equal(indicatorBefore(["a", "b", "c", "d"], "b", 1), "c", "in place: just after itself");
  assert.equal(indicatorBefore(["a", "b", "c", "d"], "b", 3), null, "after the last"); assert.equal(indicatorBefore(["a", "b", "c", "d"], "d", 3), null, "the last one dragged to the end"); assert.equal(indicatorBefore(["a", "b", "c", "d"], "d", 2), "c");
});

test("auto-scroll near the screen edges, faster closer to the edge, none elsewhere", () => {
  assert.equal(scrollSpeed(400, 800), 0); assert.equal(scrollSpeed(EDGE_PX, 800), 0); assert.equal(scrollSpeed(800 - EDGE_PX, 800), 0);
  assert.equal(scrollSpeed(0, 800), -MAX_SCROLL_PX); assert.equal(scrollSpeed(-50, 800), -MAX_SCROLL_PX, "beyond the edge: the maximum, not more");
  assert.equal(scrollSpeed(800, 800), MAX_SCROLL_PX); assert.ok(scrollSpeed(EDGE_PX / 2, 800) > -MAX_SCROLL_PX && scrollSpeed(EDGE_PX / 2, 800) < 0);
  assert.ok(Math.abs(scrollSpeed(10, 800)) > Math.abs(scrollSpeed(60, 800)), "closer to the edge is faster");
});

test("keyboard moves and spoken messages", () => {
  assert.equal(keyMove(2, 5, "ArrowUp"), 1); assert.equal(keyMove(0, 5, "ArrowUp"), 0, "stops at the top"); assert.equal(keyMove(2, 5, "ArrowDown"), 3); assert.equal(keyMove(4, 5, "ArrowDown"), 4, "stops at the bottom");
  assert.equal(keyMove(2, 5, "Home"), 0); assert.equal(keyMove(2, 5, "End"), 4); for (const k of ["a", " ", "Enter", "Escape", "Tab"]) assert.equal(keyMove(2, 5, k), null, k);
  assert.match(announce.pickedUp("Bench", 2, 5), /Picked up Bench, position 2 of 5\. Use the arrow keys to move, Space to drop, Escape to cancel\./);
  assert.equal(announce.moved("Bench", 3, 5), "Bench, position 3 of 5."); assert.equal(announce.dropped("Bench", 3, 5), "Dropped Bench at position 3 of 5.");
  assert.equal(announce.unchanged("Bench", 2, 5), "Dropped Bench. It stays at position 2 of 5."); assert.equal(announce.cancelled("Bench", 2, 5), "Reorder cancelled. Bench is at position 2 of 5.");
});

// ------------------------------------------------------------------ the state machine (what the hook runs)
const run = (events: DragEvent[], from: DragState = IDLE) => { let s = from; const effects: Array<string | null> = []; let drop: unknown; for (const e of events) { const r = step(s, e); s = r.state; effects.push(r.effect); if (r.drop) drop = r.drop; } return { s, effects, drop }; };
const press: DragEvent = { type: "press", id: "b", index: 1, x: 100, y: 200 };

test("a long press becomes a drag; moving and releasing commits exactly one drop", () => {
  const r = run([press, { type: "activate" }, { type: "move", x: 100, y: 260, to: 2 }, { type: "move", x: 100, y: 300, to: 3 }, { type: "release" }]);
  assert.deepEqual(r.effects, [null, "activated", null, null, "commit"]); assert.deepEqual(r.drop, { id: "b", from: 1, to: 3 }); assert.equal(r.s, IDLE);
});

test("a tap, or a move beyond 5 px before the timer, never becomes a drag (so scrolling stays natural)", () => {
  assert.deepEqual(run([press, { type: "release" }]).effects, [null, "tap"], "a quick tap");
  const early = run([press, { type: "move", x: 100, y: 230 }, { type: "activate" }]);
  assert.deepEqual(early.effects, [null, "abort", null], "moved 30 px: it was a scroll; the timer firing afterwards does nothing"); assert.equal(early.s.phase, "idle");
  const wobble = run([press, { type: "move", x: 102, y: 203 }, { type: "activate" }]);
  assert.deepEqual(wobble.effects, [null, null, "activated"], "a 3 px wobble is tolerated"); assert.equal(wobble.s.phase, "dragging");
  assert.equal(run([{ type: "activate" }]).s.phase, "idle", "a timer with no press does nothing");
});

test("cancelling never commits: pointercancel, Escape, blur, and a release back where it started", () => {
  for (const events of [[press, { type: "cancel" }], [press, { type: "activate" }, { type: "cancel" }], [press, { type: "activate" }, { type: "move", x: 1, y: 500, to: 4 }, { type: "cancel" }]] as DragEvent[][]) {
    const r = run(events); assert.equal(r.drop, undefined); assert.equal(r.s, IDLE);
  }
  assert.equal(run([press, { type: "activate" }, { type: "cancel" }]).effects.at(-1), "cancelled");
  assert.equal(run([{ type: "cancel" }]).effects[0], null, "nothing to cancel");
  const inPlace = run([press, { type: "activate" }, { type: "move", x: 100, y: 205, to: 1 }, { type: "release" }]);
  assert.deepEqual(inPlace.drop, { id: "b", from: 1, to: 1 }, "reported, and the editor moves nothing when from equals to");
});

test("one drag at a time, and pointer and keyboard do not mix", () => {
  const a = run([press, { type: "activate" }]); const second = step(a.s, { type: "press", id: "c", index: 2, x: 0, y: 0 });
  assert.equal(second.state, a.s, "a second press during a drag is ignored"); assert.equal(step(a.s, { type: "kbStart", id: "c", index: 2 }).state, a.s);
  const k = run([{ type: "kbStart", id: "c", index: 2 }, { type: "kbMove", to: 0 }, { type: "kbMove", to: 0 }]);
  assert.deepEqual([k.s.phase, k.s.mode, k.s.from, k.s.to], ["dragging", "keyboard", 2, 0]);
  assert.equal(step(k.s, { type: "release" }).state, k.s, "a pointer release does not drop a keyboard pick-up"); assert.equal(step(k.s, { type: "move", x: 0, y: 0, to: 4 }).state, k.s);
  assert.deepEqual(run([{ type: "kbStart", id: "c", index: 2 }, { type: "kbMove", to: 0 }, { type: "kbDrop" }]).drop, { id: "c", from: 2, to: 0 });
  assert.equal(run([{ type: "kbStart", id: "c", index: 2 }, { type: "kbMove", to: 0 }, { type: "cancel" }]).drop, undefined);
  assert.equal(run([{ type: "kbDrop" }]).drop, undefined, "dropping with nothing picked up does nothing");
});

// ------------------------------------------------------------------ ordering and data preservation
test("every drag from any position to any position is a clean reorder: nothing lost, duplicated or changed", () => {
  const w = loaded(), ids = idsOf(w), n = ids.length, before = content(w);
  for (let from = 0; from < n; from++) for (let to = 0; to < n; to++) {
    const dragged = ids[from], others = ids.filter((x) => x !== dragged);
    // a pointer placed so that exactly `to` of the other exercises are above it
    const mids = others.map((_, i) => (i + 1) * 100), y = to * 100 + 50;
    assert.equal(targetIndex(mids, y), to);
    const moved = moveExercise(w, dragged, targetIndex(mids, y));
    const expected = [...others]; expected.splice(to, 0, dragged);
    assert.deepEqual(idsOf(moved), expected, `${from} -> ${to}`);
    assert.equal(content(moved), before, "sets, values, RPE, notes, units, supersets, completion and timestamps are exactly as before");
    assert.equal(new Set(moved.exercises.map((e) => e.id)).size, n, "no duplicate"); assert.equal(moved.exercises.length, n, "none lost");
    assert.deepEqual(sorted(moved).map((e) => e.position), [...Array(n).keys()], "positions are 0 to n-1");
    assert.equal(moved.currentId, w.currentId, "the current exercise is unchanged"); assert.equal(moved.id, w.id); assert.equal(moved.startedAt, w.startedAt);
    assert.equal(moveExercise(moved, dragged, from).exercises.length, n);
  }
  const bench = w.exercises[0]; assert.equal(bench.sets[0].completed, true); assert.equal(bench.sets[0].completed_at, at(0));
});

test("a drop is saved like any change, and the new order comes back after a reload", async () => {
  const server = new FakeStrengthServer(), store = new MemoryStore(), t = transportFor(server);
  let engine = new SyncEngine(store, t, clock(), testOwner()); await engine.load();
  let w = loaded(); await engine.record(w, { active: true });
  const ids = idsOf(w), target = [ids[3], ids[0], ids[1], ids[2], ids[4]];
  w = moveExercise(w, ids[3], 0); await engine.record(w, { active: true });
  engine = new SyncEngine(store, t, clock(), testOwner()); await engine.load();
  const back = engine.local.workouts[engine.local.activeId!];
  assert.deepEqual(idsOf(back), target, "recovered in the new order"); assert.equal(content(back), content(w), "with every value intact");
  await engine.flush(); assert.equal(server.live("exercise").length, 5); assert.equal(server.live("set").length, 10, "everything uploads once");
});

test("nothing moves unless a drag was committed with a real change", () => {
  const w = loaded(), ids = idsOf(w);
  const apply = (events: DragEvent[]) => { const r = run(events); let x = w; if (r.drop) { const d = r.drop as { id: string; from: number; to: number }; if (d.to !== d.from) x = moveExercise(w, d.id, d.to); } return x; };
  const start: DragEvent = { type: "press", id: ids[1], index: 1, x: 0, y: 0 };
  assert.equal(apply([start, { type: "release" }]), w, "a tap");
  assert.equal(apply([start, { type: "move", x: 0, y: 40 }, { type: "activate" }, { type: "release" }]), w, "a scroll");
  assert.equal(apply([start, { type: "activate" }, { type: "move", x: 0, y: 300, to: 4 }, { type: "cancel" }]), w, "cancelled");
  assert.equal(apply([start, { type: "activate" }, { type: "move", x: 0, y: 10, to: 1 }, { type: "release" }]), w, "dropped where it was");
  assert.deepEqual(idsOf(apply([start, { type: "activate" }, { type: "move", x: 0, y: 300, to: 4 }, { type: "release" }])), [ids[0], ids[2], ids[3], ids[4], ids[1]], "a real drop");
});

// ------------------------------------------------------------------ the editor and hook: wiring, accessibility, scope
test("only live workouts can be dragged; history editing is unchanged; the existing move buttons stay", () => {
  assert.match(editor, /const reorderable = mode === "live" && list\.length > 1;/);
  assert.match(editor, /\{\.\.\.\(reorderable \? drag\.headProps\(e\.id, ei\) : \{\}\)\}/); assert.match(editor, /\{reorderable && \(\s*<button type="button" data-grip/);
  assert.match(read("app/(app)/strength/history/[id]/page.tsx"), /mode="edit"/);
  assert.match(editor, /↑ Move up/); assert.match(editor, /↓ Move down/); assert.match(editor, /moveExercise\(w, e\.id, ei - 1\)/); assert.match(editor, /moveExercise\(w, e\.id, ei \+ 1\)/);
  assert.match(editor, /onDrop: \(id, to\) => act\(\(\) => moveExercise\(w, id, to\)\)/, "the existing moveExercise, through act and the normal save");
  assert.doesNotMatch(editor.slice(editor.indexOf("const drag = useExerciseDrag")), /\.sort\(\(a, b\) => b|splice\(|\.reverse\(/, "the editor never reorders by itself");
  assert.match(editor, /onStart: \(\) => \{ setKp\(CLOSED\); setMenu\(null\); \}/, "the keypad and open options step aside");
});

test("accessible alternatives: a labelled grip button, keyboard pick-up, spoken messages, and nothing hijacked inside the header", () => {
  assert.match(editor, /aria-label=\{`Reorder \$\{e\.name\}`\} aria-describedby="reorder-help"/); assert.match(editor, /<p id="reorder-help" className="sr-only">Press and hold an exercise title to drag it, or focus its Reorder button and press Space/);
  assert.match(editor, /<div className="sr-only" role="status" aria-live="assertive">\{drag\.message\}<\/div>/);
  assert.match(hook, /"aria-pressed": drag\.phase === "dragging" && drag\.mode === "keyboard" && drag\.id === id/);
  assert.match(hook, /\(e\.key === " " \|\| e\.key === "Enter"\)/); assert.match(hook, /e\.key === "Escape"\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); cancel\(\)/); assert.match(hook, /keyMove\(s\.to, total\(\), e\.key\)/);
  assert.match(hook, /onBlur: \(\) => \{ if \(state\.current\.phase === "dragging" && state\.current\.mode === "keyboard"\) cancel\(\); \}/, "leaving the grip cancels a keyboard pick-up");
  assert.match(hook, /onClick: \(e: React\.MouseEvent\) => \{ e\.preventDefault\(\); \}/, "a tap on the grip does not toggle anything");
  assert.match(hook, /t\.closest\("button,input,select,textarea,a,summary"\) && !t\.closest\("\[data-grip\]"\)/, "buttons and fields in the header keep working");
  assert.match(hook, /e\.pointerType === "mouse" && e\.button !== 0/, "only the main mouse button");
  assert.match(hook, /announce\.pickedUp/); assert.match(hook, /announce\.dropped/); assert.match(hook, /announce\.cancelled/);
  assert.match(editor, /\{drag\.marker === e\.id && <div className="exc-drop" aria-hidden="true" \/>\}/); assert.match(editor, /<div className="exc-ghost" aria-hidden="true"/, "the visual aids are hidden from screen readers; the live region speaks instead");
});

test("touch and mouse safety: scrolling stays natural, optional haptics, listeners removed, reduced motion respected", () => {
  assert.match(hook, /window\.addEventListener\("touchmove", block, \{ passive: false \}\)/); assert.match(hook, /const block = \(ev: TouchEvent\) => \{ if \(state\.current\.phase === "dragging"\) ev\.preventDefault\(\); \}/, "the page is only held still once it IS a drag");
  assert.match(hook, /try \{ navigator\.vibrate\?\.\(15\); \} catch \{ \/\* optional/, "haptics are optional and can never fail");
  assert.match(hook, /window\.removeEventListener\("pointermove", move\)[\s\S]*window\.removeEventListener\("touchmove", block\)/); assert.match(hook, /useEffect\(\(\) => \(\) => stop\(\), \[\]\)/, "cleaned up when the workout screen goes away");
  assert.match(hook, /window\.addEventListener\("pointercancel", abort\)/); assert.match(hook, /window\.addEventListener\("blur", abort\)/); assert.match(hook, /ev\.key === "Escape"\) cancel\(\)/);
  assert.match(hook, /window\.setTimeout\(\(\) => \{[\s\S]*LONG_PRESS_MS\)/); assert.match(hook, /window\.addEventListener\("contextmenu", menu\)/, "no context menu from the long press");
  assert.match(hook, /if \(timer\.current !== null\) \{ window\.clearTimeout\(timer\.current\)/, "a release before the timer cancels it");
  assert.match(editor, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches/); assert.match(editor, /prev\.key !== key/, "the glide only runs when the order changed, never on ordinary edits");
});

test("look and size: 44px grip, floating preview below the modal layers, a no-shift insertion line, dimmed original", () => {
  const rule = (sel: string): string => { const key = sel + "{"; for (let i = css.indexOf(key); i !== -1; i = css.indexOf(key, i + 1)) { const p = css[i - 1]; if (p === undefined || /[\s}]/.test(p)) return css.slice(i + key.length, css.indexOf("}", i)); } return ""; };
  assert.match(rule(".exc-grip"), /min-width:44px;min-height:44px/); assert.match(rule(".exc-head.sortable"), /-webkit-touch-callout:none/); assert.match(rule(".exc-head.sortable"), /user-select:none/);
  assert.match(rule(".exc-ghost"), /position:fixed;z-index:44;pointer-events:none/, "never catches the pointer, and stays under the More sheet and dialogs");
  assert.match(rule(".exc-drop"), /position:relative;height:0/, "the line takes no space, so the cards never jump while dragging"); assert.match(css, /\.exc-drop::before\{[^}]*position:absolute[^}]*height:4px[^}]*background:var\(--green\)/);
  assert.match(rule(".exc.dragging"), /opacity:\.35/);  assert.match(rule(".exc-head>div"), /flex:1;min-width:0/);
});

test("scope: no new package, no change to the workout engine, header, keypad or timer", () => {
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["@supabase/supabase-js", "next", "react", "react-dom"], "no drag-and-drop library was added");
  assert.doesNotMatch(read("lib/strength/reorder.ts"), /document\.|window\.|from "react"|localStorage|fetch\(/, "pure logic");
  assert.doesNotMatch(read("lib/strength/workout.ts"), /reorder|drag/i, "the engine knows nothing about dragging");
  assert.match(read("lib/strength/workout.ts"), /export function moveExercise\(w: Workout, exId: string, toIndex: number\): Workout \{/);
  assert.match(read("components/strength/WorkoutHeader.tsx"), /aria-label="Workout menu"/); assert.match(read("components/strength/NumKeypad.tsx"), /aria-label="Number keypad"/); assert.match(read("components/strength/RestTimer.tsx"), /aria-label="15 seconds less"/);
});
