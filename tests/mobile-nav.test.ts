// Mobile bottom navigation (UI/UX Phase 1): destinations, active-route behaviour, More menu, keyboard handling, CSS guarantees, desktop unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { DESKTOP_NAV, MORE_NAV, PRIMARY_NAV, activeTab, isActive, opensKeyboard } from "../lib/nav.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const css = read("app/globals.css");
const bar = read("components/nav/BottomNav.tsx");
const layout = read("app/(app)/layout.tsx");

test("bottom bar destinations (Design System 1.0): Today, Activities, Coach, then More", () => {
  assert.deepEqual(PRIMARY_NAV.map((n) => n.label), ["Today", "Activities", "Coach"]);
  assert.deepEqual(PRIMARY_NAV.map((n) => n.href), ["/today", "/activities", "/coach"]);
  assert.match(bar, /<span>More<\/span>|<span>More<\/span>/);
  assert.equal(PRIMARY_NAV.length + 1, 4);
  assert.match(css, /\.bnav\{[^}]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/, "four equal columns");
});

test("More contains every other destination (no route lost, none duplicated) and only existing routes", () => {
  const more = MORE_NAV.map((n) => n.href);
  for (const h of ["/training", "/biomarkers", "/timeline", "/races", "/integrations", "/supplements", "/profile", "/strength"]) assert.ok(more.includes(h), `${h} is in More`);
  assert.equal(new Set(more).size, more.length);
  const all = [...PRIMARY_NAV, ...MORE_NAV].map((n) => n.href).sort();
  assert.deepEqual(all, DESKTOP_NAV.map((n) => n.href).sort(), "primary + More covers exactly the desktop destinations");
  assert.equal(MORE_NAV.find((n) => n.href === "/integrations")!.label, "Connections");
  for (const n of [...PRIMARY_NAV, ...MORE_NAV]) assert.ok(existsSync(new URL(`../app/(app)${n.href}/page.tsx`, import.meta.url)), `${n.href} is an existing page`);
});

test("desktop navigation is unchanged: same items, same order, same labels", () => {
  assert.deepEqual(DESKTOP_NAV.map((n) => n.label), ["Today", "Activities", "Strength", "Connections", "Training", "Coach", "Supplements", "Biomarkers", "Timeline", "Races", "Profile"]);
  assert.match(layout, /DESKTOP_NAV\.map/); assert.match(layout, /className="side"/); assert.match(layout, /<BottomNav /);
  assert.match(layout, /signOut\(\{ scope: "local" \}\)/, "sign-out still signs out this device only");
  assert.match(css, /\.side\{background:var\(--card2\);border-right:1px solid var\(--line\);padding:24px 18px;display:flex;flex-direction:column;gap:14px;position:sticky;top:0;height:100vh\}/, "desktop sidebar rule untouched");
});

test("active route: exact and nested paths highlight their own tab", () => {
  assert.equal(activeTab("/today"), "today"); assert.equal(activeTab("/training"), "more", "Training now lives in More"); assert.equal(activeTab("/activities"), "activities"); assert.equal(activeTab("/coach"), "coach");
  assert.equal(activeTab("/training/anything"), "more");
  assert.equal(isActive("/races/12", "/races"), true); assert.equal(isActive("/todayx", "/today"), false, "a path that merely starts with the same letters is not active");
  assert.equal(activeTab("/todayx"), null); assert.equal(activeTab("/"), null); assert.equal(activeTab("/login"), null);
});

test("active route: every route inside More (including nested ones) makes More active, and no primary tab", () => {
  for (const p of ["/strength", "/strength/history/abc", "/strength/analytics", "/biomarkers", "/biomarkers/panels/3", "/biomarkers/ferritin", "/timeline", "/races", "/races/42", "/supplements", "/integrations", "/profile"]) {
    assert.equal(activeTab(p), "more", p);
  }
  for (const n of MORE_NAV) assert.equal(activeTab(n.href), "more");
  for (const n of PRIMARY_NAV) assert.notEqual(activeTab(n.href), "more");
  assert.match(bar, /tab === "more" \|\| open \? "bnav-item on"/, "More also looks active while its menu is open");
  assert.match(bar, /on = tab === key && !open/, "while More is open only More is highlighted");
  assert.match(bar, /aria-current=\{on \? "page" : undefined\}/); assert.match(bar, /aria-current=\{tab === "more" \? "page" : undefined\}/);
});

test("More menu behaviour: toggle, Escape, scrim click, route change and desktop resize close it; focus moves in and returns; links are the existing routes", () => {
  assert.match(bar, /onClick=\{\(\) => setOpen\(\(v\) => !v\)\}/); assert.match(bar, /aria-expanded=\{open\}/); assert.match(bar, /aria-controls="bnav-more"/);
  assert.match(bar, /e\.key === "Escape"/); assert.match(bar, /className="bnav-scrim" onClick=\{\(\) => setOpen\(false\)\}/);
  assert.match(bar, /useEffect\(\(\) => \{ setOpen\(false\); \}, \[path\]\)/);
  assert.match(bar, /\(min-width: 801px\)/);
  assert.match(bar, /querySelector<HTMLElement>\("a,button"\)\?\.focus\(\)/); assert.match(bar, /btn\?\.focus\(\)/);
  assert.match(bar, /document\.body\.style\.overflow = "hidden"/); assert.match(bar, /document\.body\.style\.overflow = prev/, "page scroll lock is always released");
  assert.match(bar, /MORE_NAV\.map/); assert.match(bar, /role="dialog" aria-label="More destinations"/);
  assert.match(bar, /onClick=\{onSignOut\}/);
  assert.doesNotMatch(bar, /supabase|from\("|auth\./, "presentation only: no queries or auth logic in the bar");
});

test("keyboard: the bar hides while a text field has focus, never for buttons, checkboxes or links", () => {
  for (const el of [{ tagName: "INPUT", type: "text" }, { tagName: "INPUT" }, { tagName: "INPUT", type: "email" }, { tagName: "INPUT", type: "number" }, { tagName: "INPUT", type: "date" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }]) {
    assert.equal(opensKeyboard(el), true, JSON.stringify(el));
  }
  for (const el of [{ tagName: "BUTTON" }, { tagName: "A" }, { tagName: "INPUT", type: "checkbox" }, { tagName: "INPUT", type: "radio" }, { tagName: "INPUT", type: "submit" }, { tagName: "DIV" }, null, undefined]) {
    assert.equal(opensKeyboard(el as never), false, JSON.stringify(el));
  }
  assert.match(bar, /focusin/); assert.match(bar, /focusout/); assert.match(bar, /bnav\$\{typing \? " typing" : ""\}/);
  assert.match(css, /\.bnav\.typing\{transform:translateY\(100%\);visibility:hidden\}/);
});

/** The CSS inside the mobile media query that holds the bar, or "" . */
const mobileBlock = (() => { const i = css.indexOf("/* mobile bottom navigation"); return i < 0 ? "" : css.slice(i); })();

test("CSS: the bar exists only on mobile; the desktop sidebar is hidden only inside the mobile query", () => {
  assert.match(mobileBlock, /^\/\* mobile bottom navigation[^\n]*\r?\n\.bnav,\.bnav-scrim,\.bnav-panel\{display:none\}\r?\n@media \(max-width:800px\)\{/, "hidden by default, shown only at <= 800px (the existing breakpoint)");
  const outside = css.slice(0, css.indexOf("/* mobile bottom navigation"));
  assert.doesNotMatch(outside, /\.bnav/); assert.doesNotMatch(outside, /\.side\{display:none\}/);
  assert.match(mobileBlock, /\.side\{display:none\}/);
  assert.match(mobileBlock, /\.bnav\{[^}]*display:grid/);
});

test("CSS: safe areas, content clearance, floating elements, focus, reduced motion", () => {
  assert.match(mobileBlock, /--bnav-h:calc\(60px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(mobileBlock, /\.bnav\{[^}]*padding:0 env\(safe-area-inset-right\) env\(safe-area-inset-bottom\) env\(safe-area-inset-left\)/);
  assert.match(mobileBlock, /\.main\{padding-bottom:calc\(var\(--bnav-h\) \+ 96px \+ var\(--rest-h,0px\)\)\}/, "page content is never hidden behind the bar");
  assert.match(mobileBlock, /\.restbar\{bottom:var\(--bnav-h\)/); assert.match(mobileBlock, /\.fab\{bottom:calc\(var\(--bnav-h\) \+ 84px \+ var\(--rest-h,0px\)\)\}/); assert.match(mobileBlock, /\.td-quickbtn\{bottom:calc\(var\(--bnav-h\) \+ 18px\)\}/);
  // sheets and drawers (z-index 50) stay above the bar (z-index 35)
  assert.match(css, /\.sheet-bg\{position:fixed;inset:0;z-index:50/); assert.match(mobileBlock, /\.bnav\{[^}]*z-index:35/);
  assert.match(mobileBlock, /\.bnav-item:focus-visible,\.bnav-row:focus-visible\{outline:2px solid var\(--cyan\)/);
  assert.match(mobileBlock, /@media \(prefers-reduced-motion:reduce\)\{[^@]*transition:none[^@]*animation:none/);
  assert.match(mobileBlock, /min-height:56px/); assert.match(mobileBlock, /min-height:52px/, "touch targets are at least 44px");
  assert.doesNotMatch(mobileBlock, /box-shadow:[^;}]*(rgba\(56,212,208|#38d4d0)/, "restrained: no glow");
});

test("accessibility: labelled nav landmark, icons hidden from assistive tech, labels are real text", () => {
  assert.match(bar, /<nav className=\{`bnav[^`]*`\} aria-label="Primary">/);
  assert.equal((bar.match(/aria-hidden="true" focusable="false"/g) ?? []).length >= 2, true);
  assert.doesNotMatch(bar, /\bimport .* from "(lucide|react-icons|@heroicons|framer-motion)/, "no new UI library");
});
