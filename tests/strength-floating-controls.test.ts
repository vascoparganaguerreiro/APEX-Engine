// No floating controls during an active Strength workout: the Ask APEX pill is gone (Ask APEX is in the header menu) and the global Quick actions button steps
// aside for the whole workout; both stay everywhere else, including workout history editing.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const page = read("app/(app)/strength/page.tsx"), head = read("components/strength/WorkoutHeader.tsx"), css = read("app/globals.css"), omni = read("components/omni/OmniAction.tsx");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? (n === "node_modules" || n === ".next" ? [] : walk(p)) : /\.(tsx?|css)$/.test(n) ? [p] : []; });
const sources = ["app", "components", "lib"].flatMap((d) => walk(join(root, d)));
const phone = css.slice(css.indexOf("/* mobile bottom navigation"), css.indexOf("/* mobile bottom navigation") + 20000);

test("the floating Ask APEX pill is gone, with its styling", () => {
  assert.doesNotMatch(page, /className="btn fab"|💬 Ask APEX<\/button>/);
  assert.doesNotMatch(css, /(^|[\s,}])\.fab\b/m, "no rule is left for a button that no longer exists");
  const users = sources.filter((f) => /className="(?:[^"]*\s)?fab(?:\s[^"]*)?"/.test(readFileSync(f, "utf8")));
  assert.deepEqual(users, [], "no component renders it any more");
  assert.match(page, /<AskApex open=\{ask\} onClose=\{\(\) => setAsk\(false\)\}/, "the Ask APEX drawer itself is still part of the workout screen");
});

test("Ask APEX is reached from the workout header's menu, and opens the same drawer", () => {
  assert.match(head, /<button type="button" role="menuitem" className="wk-item" onClick=\{run\(onAsk\)\}>💬 Ask APEX<\/button>/);
  assert.match(page, /onAsk=\{\(\) => setAsk\(true\)\}/);
  const menu = head.slice(head.indexOf('role="menu"'));
  assert.ok(menu.indexOf("Ask APEX") > 0 && menu.indexOf("Ask APEX") < menu.indexOf("Cancel workout"), "in the menu, not the header row");
  assert.doesNotMatch(head.slice(head.indexOf('<div className="wk-top">'), head.indexOf('<div className="wk-menuwrap">')), /Ask APEX/);
});

test("Quick actions steps aside for the WHOLE active workout, from the page's own workout status", () => {
  assert.match(page, /const workoutLive = w\?\.status === "active";/, "derived from the workout the page already holds: no second copy of the state");
  assert.match(page, /useEffect\(\(\) => \{ document\.documentElement\.classList\.toggle\("workout-live", workoutLive\); return \(\) => document\.documentElement\.classList\.remove\("workout-live"\); \}, \[workoutLive\]\);/);
  assert.ok(page.indexOf('classList.toggle("workout-live"') < page.indexOf("if (!ready) return"), "set before any early return, so it holds from the first moment the workout is active, whatever the keypad, timer or menu are doing");
  assert.doesNotMatch(page, /useState[^;]*workout-?live|setWorkoutLive/i);
  assert.match(phone, /html\.kb-open \.omni-fab\{display:none\}\s*\/\*[^*]*\*\/\s*html\.workout-live \.omni-fab\{display:none\}/, "one rule, next to the existing 'hide while typing' one, inside the phone layout where the button exists");
  // it is hidden by display, so it is neither visible nor reachable by keyboard or screen reader
  assert.match(phone, /\.omni-fab\{display:grid;place-items:center;position:fixed;/, "the button's own rule is unchanged");
  // the class follows the status: it is removed when the workout ends, is cancelled, or the page is left
  assert.match(page, /return \(\) => document\.documentElement\.classList\.remove\("workout-live"\)/);
  assert.match(page, /\[workoutLive\]\);/, "re-runs whenever the status changes (finish, cancel, start)");
});

test("everything else keeps both controls: other pages, the Strength hub without a workout, and workout history editing", () => {
  const setters = sources.filter((f) => /workout-live/.test(readFileSync(f, "utf8"))).map((f) => f.replace(root, "").replace(/\\/g, "/")).sort();
  assert.deepEqual(setters, ["app/(app)/strength/page.tsx", "app/globals.css"], "only the Strength page sets it, and only the stylesheet reads it");
  assert.doesNotMatch(read("app/(app)/strength/history/[id]/page.tsx"), /workout-live/, "history editing never hides it");
  assert.match(page, /if \(w && w\.status === "active"\) \{/); const after = page.slice(page.indexOf("if (w && w.status === \"active\") {"));
  assert.match(after, /StrengthNav/, "the hub (no active workout) is rendered after the active branch, with the class already off");
  // the global control, its palette and its shortcut are untouched
  assert.match(omni, /className="omni-fab" aria-label="Quick actions" aria-haspopup="dialog"/); assert.match(omni, /isPaletteShortcut/); assert.doesNotMatch(omni, /workout-live/);
  assert.match(read("app/(app)/layout.tsx"), /<OmniActionHost \/>/); assert.match(css, /\.td-quickbtn\{bottom:calc\(var\(--bnav-h\) \+ 18px\)\}/, "Today's own quick button is unchanged");
});

test("scope: keypad, timer, dock, header and workout logic are unchanged", () => {
  assert.match(page, /<RestTimer rest=\{rest\} setRest=\{setRest\} userId=/); assert.match(page, /<WorkoutHeader w=\{w\}/); assert.match(page, /<WorkoutEditor w=\{w\} save=\{save\}[^>]*mode="live" onRest=\{startRest\} \/>/);
  assert.match(css, /html\.kp-open \.main\{padding-bottom:calc\(var\(--kp-h,0px\) \+ var\(--rest-h,0px\) \+ 24px\)\}/); assert.match(css, /:root\.kp-open\{--bnav-h:0px\}/);
  assert.match(css, /\.kp\{position:fixed;left:0;right:0;bottom:var\(--rest-h,0px\);z-index:42/); assert.match(css, /\.restbar\{bottom:var\(--bnav-h\);padding-bottom:6px\}/);
  assert.doesNotMatch(read("lib/strength/workout.ts"), /workout-live|omni/i, "the engine knows nothing about this");
  assert.match(page, /eng\.record\(next, o\)\.catch\(/);
});
