// Global Omni-Action (UI/UX Phase 2, part A): shortcuts, action routing, dialog accessibility, no duplicate floating buttons, real workflows only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COACH_TABS, OMNI_ACTIONS, OMNI_RUN_EVENT, addFromSearch, coachTabFromSearch, emitRun, filterActions, isPaletteShortcut, moveIndex, quickFromSearch, resolveTarget, shortcutLabel,
} from "../lib/omni.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const host = read("components/omni/OmniAction.tsx");
const css = read("app/globals.css");
const byId = (id: string) => OMNI_ACTIONS.find((a) => a.id === id)!;

// ------------------------------------------------------------------ shortcuts
test("palette shortcut: Ctrl+K and Cmd+K only, in either case, never with Alt or Shift or alone", () => {
  assert.equal(isPaletteShortcut({ key: "k", ctrlKey: true }), true);
  assert.equal(isPaletteShortcut({ key: "K", ctrlKey: true }), true);
  assert.equal(isPaletteShortcut({ key: "k", metaKey: true }), true);
  assert.equal(isPaletteShortcut({ key: "k" }), false);
  assert.equal(isPaletteShortcut({ key: "k", ctrlKey: true, altKey: true }), false);
  assert.equal(isPaletteShortcut({ key: "k", ctrlKey: true, shiftKey: true }), false);
  assert.equal(isPaletteShortcut({ key: "j", ctrlKey: true }), false);
  assert.equal(isPaletteShortcut({ key: "Enter", metaKey: true }), false);
  assert.equal(shortcutLabel("MacIntel"), "⌘K"); assert.equal(shortcutLabel("iPhone"), "⌘K"); assert.equal(shortcutLabel("Win32"), "Ctrl K"); assert.equal(shortcutLabel("Linux x86_64"), "Ctrl K"); assert.equal(shortcutLabel(""), "Ctrl K");
});

test("keyboard navigation wraps around in both directions and survives an empty list", () => {
  assert.equal(moveIndex(0, 1, 3), 1); assert.equal(moveIndex(2, 1, 3), 0); assert.equal(moveIndex(0, -1, 3), 2); assert.equal(moveIndex(1, -1, 3), 0);
  assert.equal(moveIndex(0, 1, 0), -1); assert.equal(moveIndex(0, 1, 1), 0);
});

test("the host listens for the shortcut, toggles, and does not stack on top of a page's own dialog", () => {
  assert.match(host, /isPaletteShortcut\(e\)/); assert.match(host, /e\.preventDefault\(\);\s*\n\s*if \(open\) \{ close\(\); return; \}/);
  assert.match(host, /\[role="dialog"\]\[aria-modal="true"\]:not\(\[data-omni\]\)/); assert.match(host, /if \(!otherModalOpen\(\)\) show\(\)/);
  assert.match(host, /document\.addEventListener\("keydown", key\)/); assert.match(host, /document\.removeEventListener\("keydown", key\)/);
});

// ------------------------------------------------------------------ the actions: only real workflows
test("every action opens an existing page; none is a placeholder", () => {
  const ids = OMNI_ACTIONS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const a of OMNI_ACTIONS) {
    const path = a.href.split("?")[0];
    const file = path === "/biomarkers/panels/new" ? "app/(app)/biomarkers/panels/[id]/page.tsx" : `app/(app)${path}/page.tsx`;
    assert.ok(existsSync(join(root, file)), `${a.id}: ${a.href} -> ${file} exists`);
    assert.ok(a.label.length > 2 && a.hint.length > 2 && a.keywords.length > 0, `${a.id} is fully described`);
    if (a.page) assert.ok(a.href.startsWith(a.page), `${a.id}: the in-page target matches its route`);
  }
  for (const need of ["log-wellness", "log-supplements", "add-blood-test", "start-workout", "plan-session"]) assert.ok(ids.includes(need as never), need);
});

test("no fake actions: logging an activity by hand and notes/symptoms have no existing workflow, so they are not offered", () => {
  const text = OMNI_ACTIONS.map((a) => `${a.label} ${a.hint}`).join(" ").toLowerCase();
  assert.doesNotMatch(text, /symptom|journal|training note/);
  assert.equal(OMNI_ACTIONS.some((a) => /^log (an )?activity/i.test(a.label)), false);
  assert.match(byId("sync-activities").hint, /Connections|Intervals/);          // honest: activities arrive by sync/import
  assert.equal(byId("import-strength").label, "Import strength history");        // honest: strength sessions are imported or recorded live
});

test("search: empty shows all, label matches first, keywords and accents work, nonsense finds nothing", () => {
  assert.equal(filterActions("").length, OMNI_ACTIONS.length);
  assert.equal(filterActions("blood")[0].id, "add-blood-test");
  assert.equal(filterActions("hrv")[0].id, "log-wellness");
  assert.equal(filterActions("sleep")[0].id, "log-wellness");
  assert.equal(filterActions("vitamin")[0].id, "log-supplements");
  assert.equal(filterActions("log sup")[0].id, "log-supplements");
  assert.equal(filterActions("calendar")[0]?.id, "plan-session");
  assert.equal(filterActions("plán")[0]?.id, "plan-session", "accents are ignored");
  assert.deepEqual(filterActions("zzzzqq"), []);
  assert.ok(filterActions("workout").some((a) => a.id === "start-workout"));
  assert.equal(filterActions("  ").length, OMNI_ACTIONS.length);
});

// ------------------------------------------------------------------ routing
test("routing: on the action's own page it is an event, elsewhere it navigates to the real route", () => {
  assert.deepEqual(resolveTarget(byId("log-wellness"), "/today"), { kind: "event", id: "log-wellness" });
  assert.deepEqual(resolveTarget(byId("log-wellness"), "/races"), { kind: "navigate", href: "/today?quick=wellness" });
  assert.deepEqual(resolveTarget(byId("log-supplements"), "/strength/history/x"), { kind: "navigate", href: "/today?quick=supplements" });
  assert.deepEqual(resolveTarget(byId("plan-session"), "/training"), { kind: "event", id: "plan-session" });
  assert.deepEqual(resolveTarget(byId("plan-session"), "/today"), { kind: "navigate", href: "/training?add=1" });
  assert.deepEqual(resolveTarget(byId("ask-coach"), "/coach"), { kind: "event", id: "ask-coach" });
  assert.deepEqual(resolveTarget(byId("evaluate-session"), "/profile"), { kind: "navigate", href: "/coach?tab=session" });
  assert.deepEqual(resolveTarget(byId("log-wellness"), "/todayx"), { kind: "navigate", href: "/today?quick=wellness" }, "a path that only starts with the same letters is another page");
  for (const id of ["add-blood-test", "start-workout", "import-strength", "sync-activities"]) {
    assert.equal(resolveTarget(byId(id), "/anywhere").kind, "navigate"); assert.equal(resolveTarget(byId(id), byId(id).href).kind, "navigate");
  }
});

test("the parameters pages read on arrival are validated", () => {
  assert.equal(quickFromSearch("?quick=wellness"), "wellness"); assert.equal(quickFromSearch("?quick=supplements"), "supplements");
  assert.equal(quickFromSearch("?quick=more"), null); assert.equal(quickFromSearch(""), null); assert.equal(quickFromSearch("?quick=<script>"), null);
  for (const t of COACH_TABS) assert.equal(coachTabFromSearch(`?tab=${t}`), t);
  assert.equal(coachTabFromSearch("?tab=admin"), null); assert.equal(coachTabFromSearch(""), null);
  assert.equal(addFromSearch("?add=1"), "today"); assert.equal(addFromSearch("?add=2026-11-20"), "2026-11-20");
  assert.equal(addFromSearch("?add=2026-02-30"), "today", "an impossible date falls back to today"); assert.equal(addFromSearch("?add=junk"), "today"); assert.equal(addFromSearch(""), null);
});

test("emitRun sends one event carrying the action id", () => {
  const seen: Array<{ type: string; detail: unknown }> = [];
  emitRun("plan-session", { dispatchEvent: (e: Event) => { seen.push({ type: e.type, detail: (e as CustomEvent).detail }); return true; } });
  assert.deepEqual(seen, [{ type: OMNI_RUN_EVENT, detail: { id: "plan-session" } }]);
});

test("every in-page action has a listener on its page (so no action is a dead end)", () => {
  const pages: Record<string, string> = { "/today": read("app/(app)/today/page.tsx"), "/training": read("app/(app)/training/page.tsx"), "/coach": read("app/(app)/coach/page.tsx") };
  for (const a of OMNI_ACTIONS.filter((x) => x.page)) {
    const src = pages[a.page!]; assert.ok(src, `${a.page} has a listener file`);
    assert.match(src, new RegExp(`"${a.id}"`), `${a.page} handles ${a.id}`);
    assert.match(src, /OMNI_RUN_EVENT/); assert.match(src, /removeEventListener\(OMNI_RUN_EVENT/);
    assert.match(src, /history\.replaceState\(null, "", window\.location\.pathname\)/, `${a.page} cleans the query after reading it`);
  }
  // they open the existing form/drawer; they never write anything themselves
  assert.match(pages["/today"], /setQuick\(\{ open: true, tab: "wellness" \}\)/); assert.match(pages["/training"], /setForm\(\{ date: today \}\)/); assert.match(pages["/coach"], /setTab\("session"\)/);
});

// ------------------------------------------------------------------ dialog accessibility
test("dialog: modal, labelled, Escape, outside click, focus trap, focus in and back out, scroll lock", () => {
  assert.match(host, /role="dialog" aria-modal="true" aria-labelledby="omni-title"/); assert.match(host, /id="omni-title"/);
  assert.match(host, /e\.key === "Escape"/); assert.match(host, /onMouseDown=\{\(e\) => \{ if \(e\.target === e\.currentTarget\) close\(\); \}\}/);
  assert.match(host, /e\.key === "Tab"/); assert.match(host, /last\.focus\(\)/); assert.match(host, /first\.focus\(\)/);
  assert.match(host, /input\.current\)\?\.focus\(\)/); assert.match(host, /\.omni-row"\) : input\.current/);
  assert.match(host, /opener\.current\.focus\(\)/); assert.match(host, /document\.body\.style\.overflow = "hidden"/); assert.match(host, /document\.body\.style\.overflow = prev/);
  assert.match(host, /useEffect\(\(\) => \{ setOpen\(false\); \}, \[path\]\)/, "navigating closes it");
  assert.match(host, /skipRestore\.current = true/, "after an action the destination keeps the focus");
});

test("desktop palette uses the combobox/listbox pattern; phone sheet uses real buttons", () => {
  for (const a of ['role="combobox"', 'aria-controls="omni-list"', 'aria-autocomplete="list"', "aria-activedescendant=", '"listbox"','role="option"', "aria-selected=", 'aria-label="Search actions"']) assert.ok(host.includes(a), a);
  assert.match(host, /"ArrowDown"/); assert.match(host, /"ArrowUp"/); assert.match(host, /e\.key === "Enter" && act/);
  assert.match(host, /<button type="button" className="omni-row"/); assert.match(host, /aria-label="Close"/);
  assert.match(host, /aria-hidden="true" focusable="false"/);
});

test("one entry point: a single host in the layout, a phone button, a desktop sidebar button, and no second floating quick-log button", () => {
  const layout = read("app/(app)/layout.tsx");
  assert.equal((layout.match(/<OmniActionHost \/>/g) ?? []).length, 1); assert.match(layout, /<OmniSidebarButton \/>/);
  assert.match(host, /aria-label="Quick actions" aria-haspopup="dialog" aria-expanded=\{open\}/); assert.match(host, /aria-keyshortcuts="Control\+K Meta\+K"/);
  const walk = (d: string): string[] => readdirSync(join(root, d)).flatMap((f) => { const p = `${d}/${f}`; return statSync(join(root, p)).isDirectory() ? walk(p) : [p]; });
  const tsx = [...walk("app"), ...walk("components")].filter((f) => f.endsWith(".tsx"));
  assert.deepEqual(tsx.filter((f) => /className="[^"]*\bomni-fab\b/.test(read(f))), ["components/omni/OmniAction.tsx"], "exactly one omni button");
  assert.deepEqual(tsx.filter((f) => /td-quickbtn/.test(read(f))), [], "Today's separate floating Quick log button is gone (its drawer is reached through the global button)");
  assert.match(read("app/(app)/today/page.tsx"), /<QuickLog /, "the Quick log drawer itself is kept");
});

test("presentation only: the host never talks to the database or auth", () => {
  assert.doesNotMatch(host, /supabase|\.from\(|\.rpc\(|auth\./);
  assert.doesNotMatch(host, /\bfetch\(/);
});

// ------------------------------------------------------------------ layering and CSS
test("CSS: the button exists only on phones, sits above the bar, hides with the keyboard; dialog is above bar and sheets; reduced motion", () => {
  const i = css.indexOf("/* global quick actions"), block = css.slice(i);
  assert.match(block, /\.omni-fab\{display:none\}/);
  const media = block.slice(block.indexOf("@media (max-width:800px),(orientation:landscape) and (pointer:coarse) and (max-height:500px) and (max-width:1000px){"));
  assert.match(media, /\.omni-fab\{display:grid;[^}]*position:fixed;right:16px;bottom:calc\(var\(--bnav-h\) \+ 16px \+ var\(--composer-h,0px\) \+ var\(--rest-h,0px\)\)/);
  assert.match(read("components/coach/ChatPanel.tsx"), /--composer-h/, "the Coach composer publishes its height so the button never covers Send");
  assert.match(media, /html\.kb-open \.omni-fab\{display:none\}/); assert.match(media, /:root\.kb-open\{--bnav-h:0px\}/);
  const z = (re: RegExp) => Number(css.match(re)![1]);
  assert.ok(z(/\.omni-bg\{[^}]*z-index:(\d+)/) > z(/\.sheet-bg\{[^}]*z-index:(\d+)/), "above page sheets");
  assert.ok(z(/\.omni-bg\{[^}]*z-index:(\d+)/) > z(/\.bnav\{[^}]*z-index:(\d+)/), "above the bottom bar");
  assert.ok(z(/\.omni-fab\{display:grid;[^}]*z-index:(\d+)/) < z(/\.bnav-scrim\{[^}]*z-index:(\d+)/), "dimmed (not on top) while the More menu is open");
  assert.match(block, /@media \(prefers-reduced-motion:reduce\)\{\.omni-bg,\.omni-palette,\.omni-sheet\{animation:none\}/);
  assert.match(block, /\.omni-side:focus-visible,\.omni-row:focus-visible\{outline:2px solid #38d4d0/);
  assert.match(block, /\.omni-row\{[^}]*min-height:56px/);
  assert.match(css, /\.bnav\.typing\{transform:translateY\(100%\);visibility:hidden\}/);
  assert.match(read("components/nav/BottomNav.tsx"), /classList\.toggle\("kb-open", typing\)/);
});

// ------------------------------------------------------------------ Strength rest bar vs floating buttons (final layout check)
test("rest bar: its real height is published, and the floating buttons and page padding clear it on phones", () => {
  const rest = read("components/strength/RestTimer.tsx");
  assert.match(rest, /setProperty\("--rest-h", `\$\{el\.offsetHeight\}px`\)/); assert.match(rest, /new ResizeObserver\(set\)/);
  assert.match(rest, /removeProperty\("--rest-h"\)/, "the space is released when the bar goes away");
  assert.ok(rest.indexOf('setProperty("--rest-h"') < rest.indexOf("if (!rest) return null"), "the hook runs before the early return (stable hook order)");
  const phone = css.slice(css.indexOf("/* mobile bottom navigation"));
  assert.match(phone, /\.main\{padding-bottom:calc\(var\(--bnav-h\) \+ 96px \+ var\(--rest-h,0px\)\)\}/);
  assert.match(phone, /\.omni-fab\{display:grid;[^}]*bottom:calc\(var\(--bnav-h\) \+ 16px \+ var\(--composer-h,0px\) \+ var\(--rest-h,0px\)\);z-index:32/);
  assert.match(phone, /\.restbar\{bottom:var\(--bnav-h\)/, "the bar itself sits directly above the bottom navigation");
});

test("stacking order is deliberate: quick-actions button < rest bar < page sheets < quick-actions dialog; the button hides with the keyboard on every page", () => {
  const z = (re: RegExp) => Number(css.match(re)![1]);
  const omniFab = z(/\.omni-fab\{display:grid;[^}]*z-index:(\d+)/), restbar = z(/\.restbar\{[^}]*z-index:(\d+)/), sheet = z(/\.sheet-bg\{[^}]*z-index:(\d+)/), omni = z(/\.omni-bg\{[^}]*z-index:(\d+)/);
  assert.ok(omniFab < restbar && restbar < sheet && sheet < omni, `${omniFab} < ${restbar} < ${sheet} < ${omni}`);
  assert.equal((css.match(/(^|\n)\.omni-fab\{display:none\}/g) ?? []).length, 1, "hidden by default (desktop); shown only inside the phone media query");
  assert.equal((css.match(/kb-open \.omni-fab\{display:none\}/g) ?? []).length, 1, "one global rule, no page-specific exceptions");
  assert.match(css, /@media \(min-width:801px\)\{\.restbar\{left:240px\}\}/);
});

test("desktop: the rest bar starts where the sidebar ends, so it never covers the sidebar's Sign out button", () => {
  assert.match(css, /\.shell\{display:grid;grid-template-columns:240px 1fr;/);
  assert.match(css, /@media \(min-width:801px\)\{\.restbar\{left:240px\}\}/, "same 240px as the sidebar column");
  assert.match(css, /\.omni-fab\{display:none\}/, "no floating quick-actions button on desktop (the sidebar button and Ctrl/Cmd+K are used)");
});
