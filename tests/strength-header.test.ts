// Simplified live workout header: compact row, secondary actions in an accessible menu, and every action, the save status, minimise and recovery kept.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contextLine, menuFocusIndex } from "../lib/strength/headerMenu.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const head = read("components/strength/WorkoutHeader.tsx"), page = read("app/(app)/strength/page.tsx"), css = read("app/globals.css");
const rule = (sel: string): string => {
  const key = sel + "{";
  for (let i = css.indexOf(key); i !== -1; i = css.indexOf(key, i + 1)) { const p = css[i - 1]; if (p === undefined || /[\s}]/.test(p)) return css.slice(i + key.length, css.indexOf("}", i)); }
  return "";
};
const px = (d: string, prop: string) => Number(d.match(new RegExp(`${prop}:(\\d+)px`))?.[1] ?? 0);

test("context line: progress, what you are on, what is next, nothing invented", () => {
  assert.equal(contextLine({ done: 3, total: 12, current: "Bench Press", next: "Squat" }), "3/12 sets · Now: Bench Press · Next: Squat");
  assert.equal(contextLine({ done: 0, total: 0, current: null, next: null }), "0/0 sets");
  assert.equal(contextLine({ done: 12, total: 12, current: "Plank", next: null }), "12/12 sets · Now: Plank");
  assert.equal(contextLine({ done: 1, total: 4, current: null, next: "Row" }), "1/4 sets · Next: Row");
});

test("menu keys: arrows move and wrap, Home and End jump, other keys are not menu keys", () => {
  assert.equal(menuFocusIndex(0, 4, "ArrowDown"), 1); assert.equal(menuFocusIndex(3, 4, "ArrowDown"), 0, "wraps to the first");
  assert.equal(menuFocusIndex(0, 4, "ArrowUp"), 3, "wraps to the last"); assert.equal(menuFocusIndex(2, 4, "ArrowUp"), 1);
  assert.equal(menuFocusIndex(2, 4, "Home"), 0); assert.equal(menuFocusIndex(0, 4, "End"), 3);
  assert.equal(menuFocusIndex(-1, 4, "ArrowDown"), 0, "nothing focused yet: Down starts at the first"); assert.equal(menuFocusIndex(-1, 4, "ArrowUp"), 2);
  for (const k of ["a", "Enter", " ", "Tab", "Escape"]) assert.equal(menuFocusIndex(1, 4, k), null, k);
  assert.equal(menuFocusIndex(0, 0, "ArrowDown"), null, "an empty menu");
});

test("the header keeps the essentials in view: Minimise, name, duration, Finish, menu, context and save status", () => {
  const top = head.slice(head.indexOf('<div className="wk-top">'), head.indexOf('<div className="wk-ctx">'));
  const order = ['aria-label="Minimise workout"', 'aria-label="Workout name"', 'aria-label="Workout duration"', ">Finish<", 'aria-label="Workout menu"'].map((s) => top.indexOf(s));
  assert.ok(order.every((i) => i > 0) && [...order].sort((a, b) => a - b).join() === order.join(), "in this order, in one row");
  assert.match(head, /<input className="wk-title" aria-label="Workout name" value=\{w\.title\} maxLength=\{120\} onChange=\{\(e\) => onRename\(e\.target\.value\)\} \/>/, "the name is still editable, with the same limit");
  assert.match(head, /\{fmtClock\(elapsedSeconds\(w, now\)\)\}/, "the duration is the engine's own elapsed time");
  const ctx = head.slice(head.indexOf('<div className="wk-ctx">'));
  assert.match(ctx, /\{line\}/); assert.match(ctx, /\{w\.pausedAt && <span className="wk-paused">Paused<\/span>\}/, "a paused workout is always visible"); assert.match(ctx, /\{sync\}/, "the save status is always visible");
  assert.match(head, /<div className="wk-progress" role="img" aria-label=\{`\$\{done\} of \$\{total\} sets done`\}>/);
  assert.match(page, /sync=\{<SyncPill \/>\}/);
});

test("secondary actions are in a menu: Pause or Resume, Ask APEX, rest alerts, Cancel; Finish stays in the header", () => {
  const menu = head.slice(head.indexOf('role="menu"'));
  for (const k of ["Resume workout", "Pause workout", "Ask APEX", "Enable rest alerts", "Cancel workout"]) assert.ok(menu.includes(k), `menu: ${k}`);
  assert.match(menu, /\{alerts && <button[^>]*>🔔 Enable rest alerts<\/button>\}/, "offered only while the browser has not been asked");
  assert.match(menu, /className="wk-item danger" onClick=\{run\(onCancel\)\}>Cancel workout/, "Cancel is set apart as destructive");
  assert.doesNotMatch(head.slice(0, head.indexOf('<div className="wk-menuwrap">')), /Cancel workout|Pause workout|Enable rest alerts/, "none of them is in the header row itself");
  assert.equal((head.match(/>Finish</g) ?? []).length, 1);
  assert.doesNotMatch(page, /Cancel workout|Enable rest alerts|❚❚ Pause/, "the page no longer carries them");
});

test("the menu is accessible: button semantics, menu roles, focus in and back, Escape, Tab, outside tap, arrow keys", () => {
  assert.match(head, /aria-haspopup="menu" aria-expanded=\{open\} aria-controls="wk-menu"/); assert.match(head, /role="menu" aria-labelledby="wk-menu-btn"/);
  assert.equal((head.match(/<button type="button" role="menuitem"/g) ?? []).length, 5, "every action is a menu item (Pause and Resume are alternatives: four are shown at a time)");
  assert.match(head, /items\(\)\[0\]\?\.focus\(\)/, "opening moves focus into the menu");
  assert.match(head, /const close = \(refocus: boolean\) => \{ setOpen\(false\); if \(refocus\) button\.current\?\.focus\(\); \}/, "closing returns focus to its button");
  assert.match(head, /if \(e\.key === "Escape"\) \{ e\.preventDefault\(\); close\(true\); return; \}/); assert.match(head, /if \(e\.key === "Tab"\) \{ setOpen\(false\); return; \}/);
  assert.match(head, /menuFocusIndex\(list\.indexOf\(document\.activeElement as HTMLElement\), list\.length, e\.key\)/);
  assert.match(head, /document\.addEventListener\("pointerdown", away\)[\s\S]*document\.removeEventListener\("pointerdown", away\)/, "an outside tap closes it, and the listener is removed");
  assert.match(head, /const run = \(f: \(\) => void\) => \(\) => \{ close\(true\); f\(\); \}/, "choosing an item closes the menu and then does it");
  assert.match(head, /aria-label="Minimise workout" title=/);
});

test("minimise leaves the screen but keeps the workout; finish, cancel, pause, resume and rest alerts do what they did", () => {
  const min = page.slice(page.indexOf("const minimise"), page.indexOf("const toggleEq"));
  assert.match(min, /void engineRef\.current\?\.flush\(\); router\.push\("\/today"\);/, "saved on this device already; upload nudged; then Today (which offers 'Continue your workout')");
  assert.doesNotMatch(min, /discard|finish\(|record\(|setW\(null\)|saveRest\(/, "nothing is discarded, finished or cleared");
  assert.match(page, /onFinish=\{\(\) => setFinishing\(true\)\}/); assert.match(page, /async function doFinish\(discardIncomplete: boolean\)/); assert.match(page, /role="dialog" aria-label="Finish workout"/);
  assert.match(page, /window\.confirm\("Cancel this workout\? Everything logged in it will be deleted\."\)[\s\S]*engineRef\.current\?\.discard\(w\)/, "cancelling still asks first");
  assert.match(page, /onCancel=\{\(\) => void cancel\(\)\}/);
  assert.match(page, /onPause=\{\(\) => save\(pause\(w, new Date\(\)\.toISOString\(\)\)\)\} onResume=\{\(\) => save\(resume\(w, new Date\(\)\.toISOString\(\)\)\)\}/, "the same engine functions, saved the same way");
  assert.match(page, /onRename=\{\(title\) => save\(setDetails\(w, \{ title: title \|\| "Workout" \}\)\)\}/);
  assert.match(page, /alerts=\{typeof Notification !== "undefined" && Notification\.permission === "default"\}/); assert.match(page, /onEnableAlerts=\{\(\) => void Notification\.requestPermission\(\)\}/);
  assert.match(page, /onAsk=\{\(\) => setAsk\(true\)\}/, "Ask APEX opens the same drawer");
});

test("size, sticky and responsive layout: 44px targets, two compact rows, one row in landscape, menu inside the screen", () => {
  assert.match(rule(".wk-head"), /position:sticky;top:0;z-index:20/);
  assert.ok(px(rule(".wk-icon"), "min-width") >= 44 && px(rule(".wk-icon"), "min-height") >= 44, "Minimise and the menu button");
  assert.ok(px(rule(".wk-title"), "min-height") >= 44, "the name field"); assert.ok(px(rule(".wk-item"), "min-height") >= 48, "menu items");
  assert.match(css, /\.wk-head \.btn\.tiny,\.exc \.btn\.tiny\{min-height:44px;font-size:14px;padding:10px 14px\}/, "Finish keeps its 44px height");
  assert.match(rule(".wk-title"), /flex:1 1 0;min-width:0/, "the name shrinks instead of pushing the buttons off-screen");
  assert.match(rule(".wk-menu"), /position:absolute;right:0;top:calc\(100% \+ 4px\)/); assert.match(rule(".wk-menu"), /max-width:calc\(100vw - 24px\)/);
  assert.match(rule(".wk-progress"), /position:absolute;left:0;right:0;bottom:3px;height:3px/, "progress is a thin line, not a row");
  assert.match(css, /\.wk-ctx-text\{[^}]*-webkit-line-clamp:2/, "the context takes up to two lines before it is cut off");
  assert.match(css, /\.wk-ctx>\.syncwrap,\.wk-ctx>\.syncpill\{flex:0 1 auto;min-width:0;max-width:44%\}/, "the save status shortens before it squeezes the context");
  assert.match(css, /@media \(orientation:landscape\) and \(max-height:500px\)\{\s*\.wk-head\{flex-direction:row;/, "a phone held sideways: one row");
  assert.doesNotMatch(css, /\.wk-now\{|\.wk-top\{[^}]*flex-wrap:wrap/, "the old four-row header styling is gone");
});

test("scope: keypad, set table, rest timer, autosave and workout data are untouched; the floating Ask APEX stays until Stage 7", () => {
  assert.doesNotMatch(head, /localStorage|indexedDB|fetch\(|supabase|engine|record\(|updateSet|completeSet/i, "the header holds no persistence or workout logic");
  assert.match(page, /eng\.record\(next, o\)\.catch\(/); assert.match(page, /flushTimer\.current = window\.setTimeout\(\(\) => \{ void eng\.flush\(\); \}, 1200\)/);
  assert.match(page, /<WorkoutEditor w=\{w\} save=\{save\}[^>]*mode="live" onRest=\{startRest\} \/>/);
  assert.match(page, /<RestTimer rest=\{rest\} setRest=\{setRest\} userId=/); assert.doesNotMatch(page, /className="btn fab"/, "the floating Ask APEX pill is gone: Ask APEX is in the header menu");
  assert.match(read("components/strength/RestTimer.tsx"), /aria-label="15 seconds less"/);
  assert.match(read("components/strength/NumKeypad.tsx"), /aria-label="Number keypad"/); assert.match(read("components/strength/WorkoutEditor.tsx"), /className="setgrid hdr"/);
  assert.match(read("app/(app)/strength/history/[id]/page.tsx"), /mode="edit"/);
});
