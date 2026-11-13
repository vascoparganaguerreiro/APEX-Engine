// Stage 3 of the premium workout logger: the APEX keypad in the live workout. Input, field switching and navigation, validation, per-keystroke autosave and
// recovery, the remembered keypad/phone-keyboard choice, and the wiring (live only, history keeps native inputs).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryStore, SyncEngine } from "../lib/strength/sync.ts";
import {
  CLOSED, actionFromKey, advance, applyKey, fieldValue, openField, showText, tapField, targetExists, type ActiveField, type KeypadAction, type KeypadKey, type KeypadState,
} from "../lib/strength/keypad.ts";
import {
  EMPTY_KEYPAD_PREF, keypadActive, keypadPrefKey, keypadPrefView, loadKeypadPrefState, parseKeypadPref, saveKeypadPrefState, type KeypadPrefStorage,
} from "../lib/strength/keypadPref.ts";
import { addExercise, addSet, completeSet, removeSet, startWorkout, updateSet, type Workout } from "../lib/strength/workout.ts";
import { FakeStrengthServer, T0, at, clock, ex, transportFor, uid, testOwner } from "./strength-fixtures.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const editor = read("components/strength/WorkoutEditor.tsx"), pad = read("components/strength/NumKeypad.tsx"), css = read("app/globals.css");
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const fresh = (): Workout => startWorkout({ id: uid(), now: T0, newId: uid, defaultUnit: "kg", timezone: "Europe/Lisbon" });
function bench(unit: "kg" | "lb" = "kg") {
  let w = addExercise(fresh(), ex("barbell_bench_press"), { id: uid(), unit, setId: uid() });
  const e = w.exercises[0]; w = addSet(w, e.id, uid());
  return { w, e, s1: w.exercises[0].sets[0].id, s2: w.exercises[0].sets[1].id };
}
const at_ = (e: string, s: string, field: ActiveField["field"]): ActiveField => ({ exerciseId: e, setId: s, field });
/** Press keys one by one, the way a person taps, keeping the workout and keypad state. */
function typeKeys(w: Workout, kp: KeypadState, keys: KeypadKey[]) { for (const k of keys) { const r = applyKey(w, kp, k); w = r.w; kp = r.kp; } return { w, kp }; }
const K = (s: string) => s.split("").map((c) => (c === "<" ? "backspace" : c === "C" ? "clear" : c)) as KeypadKey[];
const setOf = (w: Workout, i = 0) => w.exercises[0].sets[i];

test("typing: every key is saved into the set at once, partial decimals included, with the engine's own updateSet", () => {
  const { w, e, s1 } = bench();
  let r = { w, kp: tapField(w, at_(e.id, s1, "weight")) };
  const seen: Array<[string, number | null]> = [];
  for (const k of K("82.5")) { r = applyKey(r.w, r.kp, k); seen.push([r.kp.text, setOf(r.w).weight]); }
  assert.deepEqual(seen, [["8", 8], ["82", 82], ["82.", 82], ["82.5", 82.5]], "each key saved; '82.' saves 82 and keeps the point on screen");
  assert.equal(setOf(r.w).unit, "kg", "a weight is saved with the exercise's unit");
  assert.equal(setOf(r.w, 1).weight, null, "other sets are untouched");
  assert.equal(r.kp.target?.field, "weight", "still editing the same field");
});

test("a weight keeps the exercise's unit, whole-number fields reject the decimal point, and a point first reads 0.", () => {
  const lb = bench("lb"); let r = typeKeys(lb.w, tapField(lb.w, at_(lb.e.id, lb.s1, "weight")), K("135"));
  assert.deepEqual([setOf(r.w).weight, setOf(r.w).unit], [135, "lb"]);
  const reps = typeKeys(lb.w, tapField(lb.w, at_(lb.e.id, lb.s1, "reps")), K("1.2"));
  assert.deepEqual([reps.kp.text, setOf(reps.w).reps], ["12", 12], "reps are whole numbers: the point is ignored");
  const dec = typeKeys(lb.w, tapField(lb.w, at_(lb.e.id, lb.s1, "weight")), K(".5"));
  assert.deepEqual([dec.kp.text, setOf(dec.w).weight], ["0.5", 0.5]);
});

test("backspace, clear, and replacing a value that is already there", () => {
  let { w, e, s1 } = bench(); w = updateSet(w, e.id, s1, { weight: 80, reps: 8 });
  let kp = tapField(w, at_(e.id, s1, "weight"));
  assert.deepEqual([kp.text, kp.replace], ["80", true], "opens showing the saved value, ready to be replaced");
  let r = typeKeys(w, kp, K("9"));
  assert.deepEqual([r.kp.text, setOf(r.w).weight], ["9", 9], "the first key replaces it");
  r = typeKeys(r.w, r.kp, K("2<<"));
  assert.deepEqual([r.kp.text, setOf(r.w).weight], ["", null], "backspacing everything clears the value (no value, not zero)");
  r = typeKeys(w, tapField(w, at_(e.id, s1, "weight")), ["backspace"]);
  assert.equal(setOf(r.w).weight, null, "backspace on a replaceable value clears it, like select-all and delete in a native box");
  r = typeKeys(w, tapField(w, at_(e.id, s1, "weight")), K("1C"));
  assert.deepEqual([r.kp.text, setOf(r.w).weight], ["", null], "clear");
  r = typeKeys(r.w, r.kp, K("7"));
  assert.equal(setOf(r.w).weight, 7, "typing goes on after clear");
});

test("validation: keys that would break the engine's limits do nothing, and nothing is saved", () => {
  const { w, e, s1 } = bench();
  let r = typeKeys(w, tapField(w, at_(e.id, s1, "weight")), K("2000"));
  assert.equal(setOf(r.w).weight, 2000);
  const same = applyKey(r.w, r.kp, "5");
  assert.equal(same.w, r.w, "the same workout object: no save is triggered"); assert.equal(same.kp, r.kp, "and the buffer is unchanged");
  const reps = typeKeys(w, tapField(w, at_(e.id, s1, "reps")), K("1000"));
  assert.equal(setOf(reps.w).reps, 1000); assert.equal(applyKey(reps.w, reps.kp, "1").w, reps.w);
  assert.equal(applyKey(w, tapField(w, at_(e.id, s1, "reps")), ".").w, w, "a point on a whole-number field is ignored");
  assert.equal(applyKey(w, CLOSED, "5").w, w, "a closed keypad ignores keys");
  const gone = applyKey(w, openField(at_(e.id, "no-such-set", "weight"), null), "5");
  assert.equal(gone.kp, CLOSED, "a target that no longer exists closes the keypad instead of failing");
  assert.equal(targetExists(w, at_(e.id, s1, "weight")), true); assert.equal(targetExists(w, at_(e.id, "x", "weight")), false);
});

test("field switching and Next: Weight -> Reps -> next open set -> next exercise -> Done", () => {
  let w = bench().w; const b = w.exercises[0];
  w = addExercise(w, ex("plank"), { id: uid(), unit: "kg", setId: uid() });
  const [s1, s2] = b.sets.map((s) => s.id), plank = w.exercises[1];
  let kp = tapField(w, at_(b.id, s1, "weight"));
  const path: string[] = [];
  for (let i = 0; i < 6 && kp.target; i++) { path.push(`${kp.target.setId === s1 ? "b1" : kp.target.setId === s2 ? "b2" : "p1"}:${kp.target.field}`); kp = advance(w, kp); }
  assert.deepEqual(path, ["b1:weight", "b1:reps", "b2:weight", "b2:reps", "p1:duration_s"], "then the keypad closes");
  assert.equal(kp, CLOSED);
  // a finished set is skipped
  let d = updateSet(w, b.id, s2, { weight: 80, reps: 8 }); d = completeSet(d, b.id, s2, at(1));
  assert.deepEqual(advance(d, tapField(d, at_(b.id, s1, "reps"))).target, at_(plank.id, plank.sets[0].id, "duration_s"));
  // tapping another field mid-typing keeps what was typed and opens the other field
  const typed = typeKeys(w, tapField(w, at_(b.id, s1, "weight")), K("77"));
  const switched = tapField(typed.w, at_(b.id, s2, "reps"));
  assert.equal(setOf(typed.w).weight, 77, "the weight stays saved"); assert.deepEqual(switched.target, at_(b.id, s2, "reps")); assert.equal(switched.replace, true);
  assert.equal(fieldValue(typed.w, at_(b.id, s1, "weight")), 77); assert.equal(fieldValue(typed.w, at_(b.id, "nope", "weight")), null);
  // a set deleted while editing it
  assert.equal(targetExists(removeSet(w, b.id, s2), at_(b.id, s2, "reps")), false);
});

test("hardware keyboard and locale: digits, point or comma, Backspace, Delete, Enter, Escape; the comma is only for display", () => {
  const expect: Array<[string, KeypadAction | null]> = [["0", "0"], ["7", "7"], [".", "."], [",", "."], ["Backspace", "backspace"], ["Delete", "clear"], ["Enter", "next"], ["Escape", "close"], ["a", null], ["Tab", null], ["10", null], ["", null], [" ", null]];
  for (const [k, a] of expect) assert.equal(actionFromKey(k), a, JSON.stringify(k));
  assert.equal(showText("82.5", ","), "82,5"); assert.equal(showText("82.5", "."), "82.5"); assert.equal(showText("82.", ","), "82,"); assert.equal(showText("", ","), "");
  const { w, e, s1 } = bench();
  const viaComma = typeKeys(w, tapField(w, at_(e.id, s1, "weight")), ["8", "2", actionFromKey(",") as KeypadKey, "5"]);
  assert.equal(setOf(viaComma.w).weight, 82.5, "a comma typed on a hardware keyboard enters a decimal");
});

test("autosave per keystroke and recovery: every key is on the device at once, an unfinished '82.' comes back as 82, and it uploads", async () => {
  const server = new FakeStrengthServer(), store = new MemoryStore(), t = transportFor(server);
  let engine = new SyncEngine(store, t, clock(), testOwner()); await engine.load();
  let { w, e, s1 } = bench(); await engine.record(w, { active: true });
  let kp = tapField(w, at_(e.id, s1, "weight"));
  const onDevice: Array<number | null> = [];
  for (const k of K("82.")) {
    const r = applyKey(w, kp, k); w = r.w; kp = r.kp;
    await engine.record(w, { active: true });
    onDevice.push(engine.local.workouts[engine.local.activeId!].exercises[0].sets[0].weight);
  }
  assert.deepEqual(onDevice, [8, 82, 82], "each key was written to the device before the next one");
  // "the app is closed" in the middle of typing "82."
  engine = new SyncEngine(store, t, clock(), testOwner()); await engine.load();
  const back = engine.local.workouts[engine.local.activeId!];
  assert.equal(back.exercises[0].sets[0].weight, 82, "the unfinished input is recovered as the number typed so far");
  assert.equal(back.exercises[0].sets[1].weight, null);
  await engine.flush(); assert.equal(server.live("set").length, 2);
});

test("the choice between the APEX keypad and the phone keyboard is remembered per account", () => {
  const mem = () => { const d = new Map<string, string>(); return { d, getItem: (k: string) => d.get(k) ?? null, setItem: (k: string, v: string) => void d.set(k, v), removeItem: (k: string) => void d.delete(k) } as KeypadPrefStorage & { d: Map<string, string> }; };
  const s = mem(); let st = loadKeypadPrefState(s, A);
  assert.deepEqual(st, { uid: A, native: false }, "default: the APEX keypad");
  st = saveKeypadPrefState(s, st, A, true)!;
  assert.equal(s.d.get(keypadPrefKey(A)), JSON.stringify({ uid: A, native: true })); assert.equal(loadKeypadPrefState(s, A).native, true, "remembered");
  assert.equal(loadKeypadPrefState(s, B).native, false, "another account on this browser is not affected"); assert.equal(s.d.has(keypadPrefKey(B)), false);
  st = saveKeypadPrefState(s, st, A, false)!;
  assert.equal(s.d.has(keypadPrefKey(A)), false, "going back to the default removes the stored value"); assert.equal(st.native, false);
  // account switch, signed out and not yet loaded
  const a = saveKeypadPrefState(s, loadKeypadPrefState(s, A), A, true)!;
  assert.deepEqual(keypadPrefView(a, A), { native: true, ready: true }); assert.deepEqual(keypadPrefView(a, B), { native: false, ready: false }); assert.deepEqual(keypadPrefView(a, null), { native: false, ready: false });
  assert.equal(saveKeypadPrefState(s, a, B, false), null, "a change cannot be written under the wrong account"); assert.equal(saveKeypadPrefState(s, EMPTY_KEYPAD_PREF, null, true), null);
  assert.equal(loadKeypadPrefState(s, "not-a-uid"), EMPTY_KEYPAD_PREF);
  // bad stored data and unavailable storage mean the default, never a crash
  for (const raw of [null, "", "{", "[]", JSON.stringify({ uid: B, native: true }), JSON.stringify({ uid: A, native: "yes" }), JSON.stringify({ uid: A })]) assert.equal(parseKeypadPref(raw, A), false, String(raw));
  const broken: KeypadPrefStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("full"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(loadKeypadPrefState(broken, A).native, false); assert.equal(saveKeypadPrefState(broken, loadKeypadPrefState(broken, A), A, true)!.native, true, "kept for this page when storage fails");
});

test("when the keypad is used: live workout, phone layout, account loaded, not switched off; never in history editing or on desktop", () => {
  const base = { live: true, phone: true, ready: true, native: false };
  assert.equal(keypadActive(base), true);
  for (const off of [{ live: false }, { phone: false }, { ready: false }, { native: true }]) assert.equal(keypadActive({ ...base, ...off }), false, JSON.stringify(off));
  assert.match(editor, /const keypadMode = useKeypadMode\(mode === "live"\);/, "history editing (mode edit) never uses it");
  const hook = read("lib/strength/useKeypadPref.ts");
  assert.match(hook, /const uid = live && !loading \? validUid\(session\?\.user\?\.id\) : null;/, "history editing never reads the preference");
  assert.match(hook, /window\.matchMedia\(PHONE_MEDIA\)/, "the same phone breakpoint as the bottom bar");
  assert.match(hook, /const \[phone, setPhone\] = useState\(false\)/, "desktop and the first render: native");
  assert.match(read("app/(app)/strength/history/[id]/page.tsx"), /mode="edit"/);
});

test("the editor uses the Stage 1 logic and does not repeat it", () => {
  assert.match(editor, /from "@\/lib\/strength\/keypad"/); assert.match(editor, /applyKey\(w, kp, a as KeypadKey\)/); assert.match(editor, /advance\(w, kp\)/); assert.match(editor, /tapField\(w, \{ exerciseId: e\.id, setId: s\.id, field: f\.key! \}\)/);
  assert.doesNotMatch(editor.slice(editor.indexOf("const onKeypad"), editor.indexOf("const kpInfo")), /replace\(|Number\(|isFinite|includes\("\."\)/, "no digit, decimal or parsing logic in the component");
  assert.doesNotMatch(pad, /Number\(|isFinite|parseFloat|\.replace\(/, "the keypad component only draws keys and forwards them");
  assert.match(pad, /actionFromKey\(e\.key\)/); assert.match(pad, /isIntegerField\(target\.field\)/);
  // native inputs stay for desktop, history editing and the phone-keyboard choice
  assert.match(editor, /: custom \? <KeyCell[\s\S]*?: <NumField label=/); assert.match(editor, /function NumField/); assert.match(editor, /inputMode=\{integer \? "numeric" : "decimal"\}/);
});

test("the keypad is a real control: labelled keys, readout, no focus stolen, safe areas, 44px+ keys, bottom stack", () => {
  assert.match(pad, /role="group" aria-label="Number keypad"/); assert.match(pad, /<output className="kp-value" aria-live="polite" aria-atomic="true">/);
  for (const k of ['"Backspace"', '"Clear"', '"Next field"', "Done, close keypad", '"Close keypad"', "Decimal comma", "Decimal point"]) assert.ok(pad.includes(k), `aria: ${k}`);
  assert.equal((pad.match(/onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/g) ?? []).length >= 4, true, "keys never take focus from the field being edited");
  assert.match(pad, /disabled=\{disabled\}/); assert.match(pad, /key\("\.", sep, .*"kp-dec", integer\)/s, "the point is disabled for whole-number fields");
  assert.match(editor, /aria-pressed=\{active\} aria-label=|aria-pressed=\{active\}/); assert.match(editor, /<button type="button" className=\{`numcell/, "a button, not an input: no phone keyboard");
  assert.match(editor, /el\?\.focus\(\{ preventScroll: true \}\);\s*el\?\.scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\);/, "the field in use stays focused and in view");
  const h = (sel: string) => Number(css.match(new RegExp(`${sel.replace(/[.]/g, "\\.")}\\{[^}]*?(?:grid-auto-rows|min-height):(\\d+)px`))?.[1] ?? 0);
  assert.ok(h(".kp-keys") >= 44, "key rows"); assert.ok(h(".kp-link") >= 44); assert.ok(h(".kp-x") >= 44); assert.ok(h(".numcell") >= 44);
  assert.match(css, /\.kp\{position:fixed;left:0;right:0;bottom:var\(--rest-h,0px\);z-index:42;[^}]*padding:0 max\(10px,env\(safe-area-inset-right\)\) calc\(8px \+ env\(safe-area-inset-bottom\)\) max\(10px,env\(safe-area-inset-left\)\)\}/, "above the rest timer, inside the safe areas");
  assert.match(css, /\.numcell\{[^}]*scroll-margin-bottom:calc\(var\(--kp-h,0px\) \+ var\(--rest-h,0px\) \+ 16px\)/, "a field scrolled into view stops above the keypad and the timer");
  assert.match(css, /:root\.kp-open\{--bnav-h:0px\}/); assert.match(css, /html\.kp-open \.bnav\{transform:translateY\(100%\);visibility:hidden\}/);
  assert.match(css, /html\.kp-open \.main\{padding-bottom:calc\(var\(--kp-h,0px\) \+ var\(--rest-h,0px\) \+ 24px\)\}/, "the page keeps room, so the last sets can be scrolled above it");
  assert.match(pad, /root\.classList\.add\("kp-open"\)/); assert.match(pad, /root\.style\.setProperty\("--kp-h"/); assert.match(pad, /root\.classList\.remove\("kp-open"\); root\.style\.removeProperty\("--kp-h"\)/, "everything is released when it closes");
  assert.match(css, /\.kp-next\{grid-column:4;grid-row:3 \/ span 2;/);
});

test("a clear switch to the phone keyboard, in two places, only where the keypad can be used", () => {
  assert.match(editor, /\{keypadMode\.phone && \(\s*<p className="kp-pref muted small">\{custom \? "APEX keypad on\." : "Using the phone keyboard\."\}/);
  assert.match(editor, /onClick=\{\(\) => keypadMode\.setNative\(custom\)\}>\{custom \? "Use the phone keyboard" : "Use the APEX keypad"\}/);
  assert.match(editor, /onUseNative=\{\(\) => \{ setKp\(CLOSED\); keypadMode\.setNative\(true\); \}\}/); assert.match(pad, /className="kp-link"[\s\S]*?onClick=\{onUseNative\}>Phone keyboard<\/button>/);
  assert.match(editor, /useEffect\(\(\) => \{ if \(!custom\) setKp\(CLOSED\); \}, \[custom\]\);/, "switching to the phone keyboard closes the keypad");
  assert.match(editor, /const complete = \(e: WExercise, s: WSet\) => \{\s*setKp\(CLOSED\);/, "marking a set done closes the keypad");
});

test("scope: engine, calculations, autosave path, schema and the other stages are untouched", () => {
  const files = [read("lib/strength/keypad.ts"), read("lib/strength/keypadPref.ts"), pad].join("\n");
  assert.doesNotMatch(files, /fetch\(|supabase|\.rpc\(|\.from\(|alter table/i, "no network, database or schema");
  assert.doesNotMatch(read("lib/strength/workout.ts"), /keypad/i, "the workout engine knows nothing about the keypad");
  const page = read("app/(app)/strength/page.tsx");
  for (const k of ['className="wk-head"', "Cancel workout", "<RestTimer rest={rest}"]) assert.ok((page + read("components/strength/WorkoutHeader.tsx")).includes(k), `header, Ask APEX and timer unchanged: ${k}`);
  assert.doesNotMatch(editor, /onPointerDown|draggable|@dnd-kit/, "no drag-and-drop yet (Stage 4)");
  assert.match(read("components/strength/RestTimer.tsx"), /-15/, "the rest timer is as it was");
});
