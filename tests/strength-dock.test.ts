// Compact rest timer and one bottom dock (rest timer + keypad + bottom navigation): behaviour kept, layout compact, no overlap, safe areas, landscape.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const rest = read("components/strength/RestTimer.tsx"), pad = read("components/strength/NumKeypad.tsx"), editor = read("components/strength/WorkoutEditor.tsx"), css = read("app/globals.css"), page = read("app/(app)/strength/page.tsx");
/** The declarations of the first rule that starts with `sel{` (after whitespace or a closing brace). */
const rule = (sel: string): string => { const key = sel + "{"; for (let i = css.indexOf(key); i !== -1; i = css.indexOf(key, i + 1)) { const p = css[i - 1]; if (p === undefined || /[\s}]/.test(p)) return css.slice(i + key.length, css.indexOf("}", i)); } return ""; };
const px = (d: string, prop: string) => Number(d.match(new RegExp(`${prop}:(\\d+)px`))?.[1] ?? 0);
const phone = css.slice(css.indexOf("/* mobile bottom navigation"), css.indexOf("/* mobile bottom navigation") + 9000);

test("every timer behaviour is kept: persisted end time, pause and resume, +/-15, reset, skip, alerts and overrun", () => {
  assert.match(rest, /export const loadRest = \(userId: string \| null \| undefined\)/); assert.match(rest, /export const saveRest = \(userId: string \| null \| undefined, r: RestState \| null\)/);
  assert.match(rest, /const update = \(r: RestState \| null\) => \{ saveRest\(userId, r\); setRest\(r\); \};/, "every change is stored for this user");
  assert.match(rest, /const left = rest \? \(rest\.pausedLeft !== null \? rest\.pausedLeft : Math\.round\(\(\(rest\.endAt \?\? 0\) - now\) \/ 1000\)\) : 0;/, "time is derived from the stored end time, so a reload or a locked screen cannot drift it");
  assert.match(rest, /const add = \(s: number\) => update\(rest\.pausedLeft !== null \? \{ \.\.\.rest, pausedLeft: Math\.max\(0, rest\.pausedLeft \+ s\) \} : \{ \.\.\.rest, endAt: \(rest\.endAt \?\? Date\.now\(\)\) \+ s \* 1000 \}\)/);
  assert.match(rest, /onClick=\{\(\) => add\(-15\)\} aria-label="15 seconds less">−15</); assert.match(rest, /onClick=\{\(\) => add\(15\)\} aria-label="15 seconds more">\+15</);
  assert.match(rest, /update\(\{ \.\.\.rest, pausedLeft: left, endAt: null \}\)\} aria-label="Pause rest">❚❚/); assert.match(rest, /update\(\{ \.\.\.rest, endAt: Date\.now\(\) \+ rest\.pausedLeft! \* 1000, pausedLeft: null \}\)\} aria-label="Resume rest">▶/);
  assert.match(rest, /update\(\{ \.\.\.rest, endAt: Date\.now\(\) \+ rest\.total \* 1000, pausedLeft: null \}\)\} aria-label="Reset rest">↺/); assert.match(rest, /onClick=\{\(\) => update\(null\)\}>Skip</);
  assert.match(rest, /function alertDone\(label: string\)/); assert.match(rest, /navigator\.vibrate\?\.\(\[200, 100, 200\]\)/); assert.match(rest, /new Notification\("Rest finished"/);
  assert.match(rest, /if \(rest\?\.endAt && left <= 0 && fired\.current !== rest\.endAt\) \{ fired\.current = rest\.endAt; alertDone\(rest\.label\); \}/, "the alert fires once per rest");
  assert.match(rest, /\{left < 0 \? `\+\$\{fmtClock\(-left\)\}` : fmtClock\(left\)\}/, "it keeps counting past zero (overrun)"); assert.match(rest, /className=\{left < 0 \? "restbar over" : "restbar"\} role="timer"/);
  assert.match(rest, /aria-live=\{left <= 5 \? "assertive" : "off"\}/); assert.match(rest, /window\.setInterval\(\(\) => setNow\(Date\.now\(\)\), 250\)/);
  assert.match(rest, /if \(!rest \|\| rest\.pausedLeft !== null\) return;/, "no ticking while paused");
  assert.match(page, /const startRest = \(seconds: number, label: string\) => \{ const r = \{ endAt: Date\.now\(\) \+ seconds \* 1000, pausedLeft: null, total: seconds, label \}; saveRest\(/); assert.match(page, /setRest\(loadRest\(session\.user\.id\)\)/);
});

test("the timer is one compact row: clock and exercise, then -15, pause, +15, reset, Skip, all at least 44px", () => {
  const order = ['className="rest-clock"', 'aria-label="15 seconds less"', 'aria-label="Pause rest"', 'aria-label="15 seconds more"', 'aria-label="Reset rest"', ">Skip<"].map((s) => rest.indexOf(s));
  assert.ok(order.every((i) => i > 0) && [...order].sort((a, b) => a - b).join() === order.join(), "in this order");
  assert.match(rest, /<span className="rest-label">Rest · \{rest\.label\}<\/span>/, "the exercise it is resting for stays visible");
  assert.match(rule(".restbar"), /display:flex;gap:4px;align-items:center$/); assert.doesNotMatch(rule(".restbar"), /flex-wrap/, "no wrapping into a second row");
  assert.ok(px(rule(".restbar .iconbtn"), "min-width") >= 44 && px(rule(".restbar .iconbtn"), "min-height") >= 44, "round buttons"); assert.ok(px(rule(".restbar .btn.tiny"), "min-height") >= 44, "Skip");
  assert.match(rule(".restbar"), /padding:6px max\(10px,env\(safe-area-inset-right\)\)/, "a slim bar, about 57px tall (it was about 115px on a 360px phone)");
  assert.match(rule(".restbar b"), /font-size:24px/); assert.match(rule(".rest-label"), /text-overflow:ellipsis/, "a long exercise name never pushes the buttons off");
  assert.match(rule(".rest-fill"), /position:absolute;left:0;top:0;height:3px/); assert.match(css, /\.restbar\.over \.rest-fill\{background:var\(--amber\)\}/);
  assert.match(rest, /<i className="rest-fill" aria-hidden="true" style=\{\{ width: `\$\{left < 0 \? 100 : rest\.total > 0 \? Math\.max\(0, Math\.min\(100, \(left \/ rest\.total\) \* 100\)\) : 0\}%` \}\} \/>/, "the remaining share, full amber once over, never out of range");
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\.rest-fill\{transition:none\}\}/);
});

test("one dock, no overlap: the bottom bar, the rest timer and the keypad stack in a fixed order", () => {
  // phone, keypad closed: bottom bar, with the rest timer directly above it
  assert.match(phone, /\.restbar\{bottom:var\(--bnav-h\);padding-bottom:6px\}/); assert.match(phone, /:root\{--bnav-h:calc\(60px \+ env\(safe-area-inset-bottom\)\)\}/);
  // keypad open: the bottom bar steps aside (its height becomes 0), the rest timer drops to the screen edge, and the keypad sits directly above the rest timer
  assert.match(phone, /:root\.kp-open\{--bnav-h:0px\}/); assert.match(phone, /html\.kp-open \.bnav\{transform:translateY\(100%\);visibility:hidden\}/);
  assert.match(rule(".kp"), /position:fixed;left:0;right:0;bottom:var\(--rest-h,0px\);z-index:42/, "directly on top of the rest timer, or on the screen edge when there is none");
  const z = (sel: string) => Number(rule(sel).match(/z-index:(\d+)/)?.[1]);
  assert.ok(z(".restbar") < z(".kp"), "the keypad is above the timer in the stack as well"); assert.equal(z(".restbar"), 40); assert.equal(z(".kp"), 42);
  // what the page leaves free, and what is hidden while the dock is busy
  assert.match(phone, /\.main\{padding-bottom:calc\(var\(--bnav-h\) \+ 96px \+ var\(--rest-h,0px\)\)\}/); assert.match(phone, /html\.kp-open \.main\{padding-bottom:calc\(var\(--kp-h,0px\) \+ var\(--rest-h,0px\) \+ 24px\)\}/);
  // each piece publishes its own height; nothing is measured twice
  assert.match(rest, /setProperty\("--rest-h", `\$\{el\.offsetHeight\}px`\)/); assert.match(rest, /removeProperty\("--rest-h"\)/); assert.match(pad, /setProperty\("--kp-h", `\$\{el\.offsetHeight\}px`\)/); assert.match(pad, /removeProperty\("--kp-h"\)/);
  assert.match(rest, /classList\.add\("rest-on"\)[\s\S]*classList\.remove\("rest-on"\)/, "the page knows when the timer is there");
});

test("safe areas: only the lowest piece of the dock pads for the home bar, so there is no wasted gap in the middle", () => {
  assert.match(rule(".restbar"), /calc\(6px \+ env\(safe-area-inset-bottom\)\)/, "alone at the screen edge (desktop, or nothing below it): pads for it");
  assert.match(phone, /\.restbar\{bottom:var\(--bnav-h\);padding-bottom:6px\}/, "above the bottom bar: the bar already covers it");
  assert.match(phone, /html\.kp-open \.restbar\{padding-bottom:calc\(6px \+ env\(safe-area-inset-bottom\)\);border-top-color:#16283a\}/, "bar hidden, keypad open: the timer is the lowest piece, so it pads");
  assert.match(rule(".kp"), /calc\(8px \+ env\(safe-area-inset-bottom\)\)/, "keypad alone at the edge: pads"); assert.match(css, /html\.rest-on \.kp\{padding-bottom:8px;box-shadow:none\}/, "keypad above the timer: no second gap, and one shadow, not two");
  assert.match(rule(".kp"), /padding:0 max\(10px,env\(safe-area-inset-right\)\)[^}]*max\(10px,env\(safe-area-inset-left\)\)/, "both side insets, for a notch in landscape");
  assert.match(css, /@media \(min-width:801px\)\{\.restbar\{left:240px\}\}/, "desktop: beside the sidebar, as before");
  for (const [bg, el] of [[/background:#0b1622/, ".restbar"], [/background:#0b1622/, ".kp"]] as const) assert.match(rule(el), bg, `${el} shares the dock colour`);
});

test("the field and the next set stay visible above the dock", () => {
  assert.match(css, /\.numcell\{[^}]*scroll-margin-bottom:calc\(var\(--kp-h,0px\) \+ var\(--rest-h,0px\) \+ 16px\)/, "a field being edited stops above the keypad and the timer");
  assert.match(css, /\.setrow\{scroll-margin-bottom:calc\(var\(--kp-h,0px\) \+ var\(--rest-h,0px\) \+ var\(--bnav-h,0px\) \+ 16px\)\}/, "any set scrolled into view stops above the whole dock");
  assert.match(editor, /el\?\.focus\(\{ preventScroll: true \}\);\s*el\?\.scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\);/);
  assert.match(editor, /<div key=\{s\.id\} data-set=\{s\.id\} className=\{`setrow/);
  assert.match(editor, /if \(mode === "live"\) \{ const nextOpen = next\.exercises\.find\(\(x\) => x\.id === a\.goTo\)\?\.sets\.find\(\(x\) => !x\.completed\); if \(nextOpen\) window\.setTimeout\(\(\) => document\.querySelector\(`\[data-set="\$\{nextOpen\.id\}"\]`\)\?\.scrollIntoView\(\{ block: "nearest" \}\), 80\); \}/, "after a set is done, the next one to do comes into view above the timer, in live workouts only");
  assert.match(editor, /const complete = \(e: WExercise, s: WSet\) => \{\s*setKp\(CLOSED\);/, "completing a set closes the keypad so the timer has the bottom");
});

test("landscape: a short screen gets a keypad two rows tall, and everything still stacks", () => {
  const land = css.slice(css.indexOf("/* a phone held sideways is short: the keys sit in two rows of seven"));
  assert.match(land, /@media \(orientation:landscape\) and \(max-height:500px\)\{/); assert.match(land, /\.kp-keys\{grid-template-columns:repeat\(7,minmax\(0,1fr\)\);grid-auto-rows:44px\}/, "44px keys, seven across, two rows");
  assert.match(land, /\.kp-next\{grid-column:auto;grid-row:auto\}\.kp-zero\{grid-column:auto\}/); assert.match(land, /\.kp-head\{min-height:36px\}/);
  const order = [...land.matchAll(/\.kp-key\[data-k="([^"]+)"\]\{order:(\d+)\}/g)].map((m) => [m[1], Number(m[2])] as const).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
  assert.deepEqual(order, ["1", "2", "3", "4", "5", "6", "backspace", "7", "8", "9", "0", ".", "clear", "next"], "1-6 and delete; 7-0, the point, clear and Next");
  // every key carries the attribute the order relies on
  assert.match(pad, /<button type="button" key=\{k\} data-k=\{k\} className=\{`kp-key \$\{cls\}`\}/); assert.match(pad, /<button type="button" data-k="next" className="kp-key kp-next"/);
  assert.match(css, /\.kp-key\{[^}]*font-size:20px/); assert.ok(px(rule(".kp-keys"), "grid-auto-rows") >= 44);
  assert.match(css, /@media \(max-width:800px\),\(orientation:landscape\) and \(pointer:coarse\) and \(max-height:500px\) and \(max-width:1000px\)\{\.restbar\{left:0\}\}/, "no sidebar column: the dock spans the screen");
});

test("scope: workout data, calculations, storage format and the other components are untouched", () => {
  assert.match(rest, /export interface RestState \{ endAt: number \| null; pausedLeft: number \| null; total: number; label: string \}/, "the stored shape is unchanged");
  assert.match(read("lib/strength/scope.ts"), /REST_KEY/); assert.doesNotMatch(rest, /updateSet|completeSet|moveExercise|fetch\(|supabase/);
  assert.doesNotMatch(read("lib/strength/workout.ts"), /rest-on|data-set|--rest-h/, "the workout engine knows nothing about the dock");
  assert.match(read("components/strength/WorkoutHeader.tsx"), /aria-label="Workout menu"/); assert.match(editor, /className="setgrid hdr"/); assert.match(pad, /aria-label="Number keypad"/);
  assert.match(read("app/(app)/strength/history/[id]/page.tsx"), /mode="edit"/);
});
