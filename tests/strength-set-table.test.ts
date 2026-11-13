// Stage 2 of the premium workout logger: the compact set table (Set | Previous | KG | Reps | Done), previous performance per set, warm-up and done styling,
// and the expandable details. Layout only: the native number boxes, the engine and history editing are unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { previousLabel, previousPerSet } from "../lib/strength/previous.ts";
import { fmtHSet, lastPerformance, type HSet, type HSession } from "../lib/strength/analytics.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const editor = read("components/strength/WorkoutEditor.tsx"), css = read("app/globals.css"), history = read("app/(app)/strength/history/[id]/page.tsx");
const hs = (type: HSet["type"], weight: number | null, reps: number | null, extra: Partial<HSet> = {}): HSet => ({ type, weight, unit: "kg", reps, duration_s: null, distance_m: null, rpe: null, completed: true, ...extra });
const rule = (sel: string): string => { const m = css.match(new RegExp(`(?:^|\\n|\\})${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\{([^}]*)\\}`)); return m ? m[1] : ""; };

test("previous per set: working sets line up with working sets, warm-ups with warm-ups, in order", () => {
  const prev = [hs("warmup", 40, 10), hs("warmup", 60, 5), hs("working", 80, 8, { rpe: 8 }), hs("working", 80, 7), hs("working", 77.5, 6)];
  const now = [{ type: "warmup" as const }, { type: "warmup" as const }, { type: "working" as const }, { type: "working" as const }, { type: "working" as const }];
  assert.deepEqual(previousPerSet(prev, now), prev);
  const mixed = previousPerSet(prev, [{ type: "working" }, { type: "warmup" }, { type: "working" }]);
  assert.deepEqual(mixed, [prev[2], prev[0], prev[3]], "a set is compared with the same kind of set, never with a different one");
});

test("previous per set: nothing is invented when there is nothing to compare with", () => {
  const sets = [{ type: "warmup" as const }, { type: "working" as const }, { type: "working" as const }];
  assert.deepEqual(previousPerSet(null, sets), [null, null, null]); assert.deepEqual(previousPerSet(undefined, sets), [null, null, null]); assert.deepEqual(previousPerSet([], sets), [null, null, null]);
  const some = previousPerSet([hs("working", 80, 8)], sets);
  assert.deepEqual(some, [null, hs("working", 80, 8), null], "no warm-up last time and only one working set: the rest stay empty");
  assert.deepEqual(previousPerSet([hs("working", 80, 8), hs("working", 80, 8)], [{ type: "working" }]), [hs("working", 80, 8)], "extra previous sets are simply not shown");
  assert.equal(previousLabel(null, "total"), "");
});

test("previous label: compact text for the column, effort rating left to the details", () => {
  assert.equal(previousLabel(hs("working", 80, 8, { rpe: 8 }), "total"), "80×8");
  assert.equal(previousLabel(hs("working", 82.5, 5), "total"), "82.5×5");
  assert.equal(previousLabel(hs("working", 60, 10, { unit: "lb" }), "total"), "60 lb×10");
  assert.equal(previousLabel(hs("working", 20, 8), "added"), "20+×8");
  assert.equal(previousLabel(hs("working", 15, 8), "assisted"), "15 assist×8");
  assert.equal(previousLabel(hs("working", null, 12), "none"), "BW×12");
  assert.equal(previousLabel(hs("working", null, null, { duration_s: 45 }), "none"), "45s");
  assert.equal(previousLabel(hs("working", 80, 8, { rpe: 7.5 }), "total"), fmtHSet(hs("working", 80, 8, { rpe: 7.5 }), "total").replace("@7.5", ""));
});

test("previous per set uses what lastPerformance returns: the last session that had the exercise, completed sets only", () => {
  const session = (id: string, day: string, sets: HSet[]): HSession => ({ id, title: "t", startedAt: `${day}T08:00:00.000Z`, endedAt: `${day}T09:00:00.000Z`, pausedSeconds: 0, source: "apex", exercises: [{ key: "barbell_bench_press", name: "Bench Press", loadMode: "total", sets }] });
  const history_ = [session("a", "2026-11-01", [hs("working", 70, 8)]), session("b", "2026-11-05", [hs("warmup", 40, 10), hs("working", 75, 8), hs("working", 75, 7, { completed: false })])];
  const last = lastPerformance(history_, "barbell_bench_press", "2026-11-10T00:00:00.000Z", "now");
  assert.ok(last);
  assert.deepEqual(previousPerSet(last!.sets, [{ type: "warmup" }, { type: "working" }, { type: "working" }]).map((x) => (x ? previousLabel(x, "total") : null)), ["40×10", "75×8", null], "the unfinished set is not a previous performance");
});

test("the table: columns, per-set previous, compact labels, and everything still reachable", () => {
  assert.match(editor, /<div className="setgrid hdr" aria-hidden><span>Set<\/span><span>Previous<\/span><span>\{shortLabel\(f1, e\.unit\)\}<\/span><span>\{shortLabel\(f2, e\.unit\)\}<\/span><span>Done<\/span><\/div>/);
  assert.match(editor, /const previous = previousPerSet\(prev\?\.sets, sortedSets\);/);
  assert.match(editor, /<span className="setprev" aria-label=\{pvText \? `Previous: \$\{pvText\}` : "No previous set"\}>\{pvText \|\| "–"\}<\/span>/);
  assert.match(editor, /const shortLabel = .*unit\.toUpperCase\(\).*"Reps".*"Sec".*"BW"/s, "KG (or LB), Reps, Sec, m, BW");
  // the inputs keep their full accessible names and the same native boxes
  assert.match(editor, /<NumField label=\{`Set \$\{si \+ 1\} \$\{f\.label\}`\}/); assert.match(editor, /inputMode=\{integer \? "numeric" : "decimal"\}/);
  // the one-line "Last time" keeps its date and the Use these values action (the sets themselves are now in the Previous column)
  assert.match(editor, /Last time \(\{prev\.date\}\)\. <button className="linkbtn" onClick=\{\(\) => useLast\(e, prev\)\}>Use these values<\/button>/);
  assert.doesNotMatch(editor, /prev\.sets\.map\(\(s\) => fmtHSet/);
});

test("RPE, RIR, set type, side, note, weight steps, target and delete are in the expandable details of each set", () => {
  const row = editor.slice(editor.indexOf("{sortedSets.map((s, si) => {"), editor.indexOf('<div className="row" style={{ marginTop: 8 }}>\n              <button className="btn ghost tiny" onClick={() => act(() => addSet'));
  const grid = row.slice(row.indexOf('<div className="setgrid">'), row.indexOf("</div>", row.indexOf('<div className="setgrid">')));
  const details = row.slice(row.indexOf('<div className="setextra setdetails"'));
  assert.doesNotMatch(grid, /rpesel|RIR|Delete set|Set note|Less weight/, "none of the extras is in the compact row");
  for (const k of ["aria-label={`Set ${si + 1} RPE`}", ">RIR<", ">Type<select", ">Side<select", 'aria-label="Less weight"', 'aria-label="More weight"', 'aria-label="Set note"', "Delete set", "Target: {tgt}"]) assert.ok(details.includes(k), `details: ${k}`);
  assert.match(row, /const warm = s\.type === "warmup", open = openSet === s\.id, detailsId = `set-details-\$\{s\.id\}`;/);
  assert.match(row, /\{open && \(\s*<div className="setextra setdetails" id=\{detailsId\}>/);
  // the set number opens them: a real button with expanded state and the controlled region
  assert.match(row, /<button className=\{`settype \$\{s\.type\}`\} aria-expanded=\{open\} aria-controls=\{detailsId\}/);
  assert.match(row, /aria-label=\{`Set \$\{si \+ 1\}, \$\{SET_TYPE_LABEL\[s\.type\]\}\$\{s\.completed \? ", done" : ""\}\. \$\{open \? "Hide" : "Show"\} details`\}/);
  assert.match(row, /onClick=\{\(\) => setOpenSet\(open \? null : s\.id\)\}/);
  // two warnings stay visible without opening anything, because they matter at a glance
  assert.match(row, /rpeRirMismatch\(s\.rpe, s\.rir\)\) && \(\s*<div className="setextra setwarn">/); assert.match(row, /entered in \{s\.unit\}/);
  // behaviour that was already there is untouched: add set / warm-up, make current, remove/replace/move, unit and rest
  for (const k of ["＋ Add set", "＋ Warm-up", "Make current", "↑ Move up", "↓ Move down", "Superset with next", ">Replace<", ">Remove<", "setExerciseUnit(", "setRest(", "setLoadMode(", "How to do it"]) assert.ok(editor.includes(k), `still there: ${k}`);
});

test("warm-up and completed sets are clearly distinct", () => {
  assert.match(editor, /`setrow\$\{s\.completed \? " done" : ""\}\$\{warm \? " warmup" : ""\}`/);
  assert.match(editor, /SET_TYPE_SHORT\[s\.type\] \|\| si \+ 1 - sortedSets\.slice\(0, si\)\.filter\(\(x\) => x\.type === "warmup"\)\.length/, "warm-ups carry their letter and do not use up a set number");
  const done = rule(".setrow.done"), warm = rule(".setrow.warmup"), on = rule(".donebtn.on");
  assert.match(done, /background:rgba\(46,230,166,\.2\)/); assert.match(done, /border-left-color:var\(--green\)/);
  assert.match(warm, /border-left-color:var\(--amber\)/); assert.match(warm, /background:rgba\(240,180,41,\.07\)/);
  assert.match(css, /\.setrow\.warmup\.done\{background:rgba\(46,230,166,\.2\);border-left-color:var\(--green\)\}/, "a finished warm-up looks finished");
  assert.match(on, /background:var\(--green\)/); assert.match(on, /color:#031210/);
  assert.match(editor, /aria-pressed=\{s\.completed\}.*✓<\/button>/s, "the check mark is on the Done button");
  assert.match(css, /\.settype\.warmup\{color:var\(--amber\)\}/);
});

test("touch targets and responsive layout of the compact table", () => {
  const h = (sel: string) => Number(rule(sel).match(/min-height:(\d+)px/)?.[1] ?? 0);
  assert.ok(h(".settype") >= 44, "the set number button"); assert.ok(h(".donebtn") >= 44, "the Done button"); assert.ok(h(".setrow input") >= 44, "the number boxes");
  const det = css.slice(css.indexOf(".setextra.setdetails{"), css.indexOf(".setextra select,.setextra input"));
  assert.match(det, /\.setdetails \.iconbtn\.tiny\{min-height:44px;min-width:44px\}/); assert.match(det, /\.setdetails \.chip\{min-height:44px\}/); assert.match(det, /\.setdetails select\{min-height:44px\}/);
  assert.match(css, /\.setgrid\{display:grid;grid-template-columns:44px minmax\(52px,\.8fr\) minmax\(0,1fr\) minmax\(0,1fr\) 48px;/, "five columns, the inputs shrink instead of overflowing");
  assert.match(css, /\.setgrid\{grid-template-columns:44px minmax\(48px,\.8fr\) minmax\(0,1fr\) minmax\(0,1fr\) 48px\}/, "tablet and phone");
  // every width: the set number and Done columns are never narrower than 44px
  const cols = [...css.matchAll(/\.setgrid\{(?:display:grid;)?grid-template-columns:(\d+)px [^;}]* (\d+)px[;}]/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.ok(cols.length >= 3, "the base, tablet and narrow-phone rules"); for (const [a, b] of cols) assert.ok(a >= 44 && b >= 44, `columns ${a}px / ${b}px`);
  assert.match(css, /\.setgrid\{grid-template-columns:44px minmax\(44px,\.8fr\) minmax\(0,1fr\) minmax\(0,1fr\) 44px;gap:4px\}/, "narrow phones keep 44px for both the set number and the Done button");
  assert.match(rule(".setprev"), /overflow:hidden;text-overflow:ellipsis;white-space:nowrap/, "a long previous value never breaks the row");
  assert.match(css, /input,select,textarea,\.setextra select,\.setextra input,\.rpesel,\.srcsel\{font-size:16px\}/, "no iOS zoom on focus");
  assert.match(css, /\.settype:focus-visible,\.donebtn:focus-visible\{outline:2px solid var\(--focus\)/);
  assert.match(rule(".setgrid.hdr"), /padding-left:3px/, "the header lines up with the rows");
});

test("scope: native inputs, history editing, the engine and the other stages are untouched", () => {
  assert.match(history, /<WorkoutEditor w=\{w\} save=\{save\}[^>]*mode="edit" \/>/);
  assert.match(editor, /function NumField/); assert.doesNotMatch(editor, /onPointerDown|draggable/i, "no drag-and-drop yet (Stage 4)");
  const page = read("app/(app)/strength/page.tsx");
  for (const k of ['className="wk-head"', "Cancel workout", "<RestTimer rest={rest}"]) assert.ok((page + read("components/strength/WorkoutHeader.tsx")).includes(k), `header, FAB and timer unchanged: ${k}`);
  assert.doesNotMatch(read("lib/strength/previous.ts"), /localStorage|fetch\(|supabase|import .* from "react"/, "pure");
  assert.equal(read("lib/strength/workout.ts").includes("previous"), false, "the workout engine knows nothing about this");
});

test("previous per set never crosses sides: left with left, right with right, and unknown sides are not guessed", () => {
  const L = (w: number, r: number, extra: Partial<HSet> = {}) => hs("working", w, r, { side: "left", ...extra }), R = (w: number, r: number, extra: Partial<HSet> = {}) => hs("working", w, r, { side: "right", ...extra });
  const now = [{ type: "working" as const, side: "left" as const }, { type: "working" as const, side: "right" as const }, { type: "working" as const, side: "left" as const }, { type: "working" as const, side: "right" as const }];
  assert.deepEqual(previousPerSet([L(20, 10), R(20, 9), L(22, 8), R(22, 8)], now), [L(20, 10), R(20, 9), L(22, 8), R(22, 8)], "in step");
  // last time the first right set was never finished (so it is not in the list): the second left set must not be shown against the right slot
  const skipped = previousPerSet([L(20, 10), L(22, 8), R(22, 8)], now);
  assert.deepEqual(skipped, [L(20, 10), R(22, 8), L(22, 8), null], "each side only ever sees its own side's sets; the missing right set stays empty");
  for (let i = 0; i < now.length; i++) if (skipped[i]) assert.equal(skipped[i]!.side, now[i].side, `set ${i + 1}: same side`);
  // sides unknown in old history, or an exercise that was not one-sided before: no value, never an assumed match
  assert.deepEqual(previousPerSet([hs("working", 20, 10), hs("working", 20, 9)], now), [null, null, null, null], "history without sides");
  assert.deepEqual(previousPerSet([L(20, 10)], [{ type: "working" }]), [null], "a set with no side is not compared with a left set");
  assert.deepEqual(previousPerSet([hs("working", 20, 10, { side: null })], [{ type: "working", side: null }]).map((x) => x?.reps), [10], "no side on both: compared as before");
  // warm-ups and sides together
  assert.deepEqual(previousPerSet([hs("warmup", 10, 10, { side: "left" }), L(20, 8)], [{ type: "warmup", side: "left" }, { type: "working", side: "left" }, { type: "working", side: "right" }]).map((x) => x?.weight ?? null), [10, 20, null]);
});

test("sides are kept in history, and a different exercise is never compared", () => {
  const analytics = read("lib/strength/analytics.ts"), data = read("lib/strength/data.ts");
  assert.match(analytics, /side\?: "left" \| "right" \| null/); assert.match(analytics, /completed: s\.completed, side: s\.side \}/); assert.match(data, /sets: e\.sets\.map\(\(s\) => \(\{ side: s\.side, type: s\.type/);
  const session = (id: string, key: string | null, sets: HSet[]): HSession => ({ id, title: "t", startedAt: "2026-11-05T08:00:00.000Z", endedAt: null, pausedSeconds: 0, source: "apex", exercises: [{ key, name: "x", loadMode: "total", sets }] });
  assert.equal(lastPerformance([session("a", "barbell_row", [hs("working", 60, 8)])], "barbell_bench_press", undefined, "now"), null, "another exercise's sets are not returned");
  assert.match(editor, /const prev = e\.key \? lastPerformance\(history, e\.key, w\.startedAt, w\.id\) : null;/, "an imported name with no exercise key has no previous at all");
});
