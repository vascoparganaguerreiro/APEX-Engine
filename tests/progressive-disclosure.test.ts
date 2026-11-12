// Progressive disclosure (UI/UX Phase 3B): Profile sections, Connections cards, expand/collapse rules, and every existing workflow preserved.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { countSet, effectiveOpen, isSet, needsAttention, setSummary } from "../lib/disclosure.ts";
import { PROVIDERS } from "../lib/integrations/providers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(root, p), "utf8");
const profile = read("app/(app)/profile/page.tsx");
const hub = read("app/(app)/integrations/page.tsx");
const disc = read("components/ui/Disclosure.tsx");
const css = read("app/globals.css");
const between = (src: string, a: string, b: string) => { const i = src.indexOf(a), j = src.indexOf(b, i + a.length); assert.ok(i !== -1 && j !== -1, `markers ${a} .. ${b}`); return src.slice(i, j); };

// ------------------------------------------------------------------ expand / collapse rules
test("summary counts only what the user entered: blanks, empty lists and false do not count", () => {
  assert.equal(isSet(""), false); assert.equal(isSet("   "), false); assert.equal(isSet(null), false); assert.equal(isSet(undefined), false); assert.equal(isSet([]), false); assert.equal(isSet(false), false); assert.equal(isSet(NaN), false);
  assert.equal(isSet("12"), true); assert.equal(isSet(["run"]), true); assert.equal(isSet(0), true); assert.equal(isSet(true), true);
  assert.equal(countSet(["", "x", [], ["a"], null]), 2);
  assert.equal(setSummary(0, 4), "None set"); assert.equal(setSummary(2, 4), "2 of 4 set"); assert.equal(setSummary(-1, 4), "None set");
});

test("a section is open when the user opened it OR when it holds a problem; a problem can never be collapsed away", () => {
  assert.equal(effectiveOpen(false, false), false, "collapsed by default");
  assert.equal(effectiveOpen(true, false), true, "the user's choice");
  assert.equal(effectiveOpen(false, true), true, "forced open by a failure");
  assert.equal(effectiveOpen(true, true), true);
});

test("connections that need attention are recognised from the status or an error message", () => {
  assert.equal(needsAttention("reauth_required"), true); assert.equal(needsAttention("error"), true);
  assert.equal(needsAttention("connected", "Token expired"), true);
  assert.equal(needsAttention("connected"), false); assert.equal(needsAttention("connected", null), false); assert.equal(needsAttention(undefined), false); assert.equal(needsAttention("disconnected", ""), false);
});

test("Disclosure is the native details/summary: keyboard operable, state announced, forced open by problems, no library", () => {
  assert.match(disc, /<details className="disc" open=\{isOpen\} onToggle=/); assert.match(disc, /<summary>/);
  assert.match(disc, /useEffect\(\(\) => \{ if \(forceOpen\) setOpen\(true\); \}, \[forceOpen\]\)/);
  assert.match(disc, /effectiveOpen\(open, forceOpen\)/); assert.match(disc, /aria-hidden="true" focusable="false"/);
  assert.match(disc, /useState\(defaultOpen\)/); assert.match(disc, /defaultOpen = false/, "collapsed unless asked");
  assert.doesNotMatch(disc.split("\n").filter((l) => /^import /.test(l)).join("\n"), /radix|headless|framer|@mui|reach/i, "no new dependency");
  assert.equal(read("lib/disclosure.ts").split("\n").filter((l) => /^import /.test(l)).length, 0, "the model is pure");
});

// ------------------------------------------------------------------ Profile
const LABELS = [
  "Display name", "Date of birth", "Height (ft / in)", "Height (cm)", "Body weight (", "Body fat (%)", "Preferred sports", "Primary training goal", "Goal notes",
  "Resting heart rate baseline (bpm)", "Maximum heart rate (bpm)", "VO2 max (ml/kg/min)", "Lactate threshold heart rate (bpm)", "Threshold pace (min per", "FTP / threshold power (W)",
  "Training experience", "Units", "Time zone", "Sleep goal (hours)",
];

test("Profile has three sections in order: Personal, Physiology, Account, with jump links", () => {
  const ids = ["profile-personal", "profile-physiology", "profile-account"].map((id) => profile.indexOf(`<section id="${id}"`));
  assert.ok(ids.every((i) => i > 0) && ids[0] < ids[1] && ids[1] < ids[2], "sections exist in order");
  for (const [id, h] of [["personal", "Personal"], ["physiology", "Physiology"], ["account", "Account"]]) assert.match(profile, new RegExp(`<h2 id="profile-${id}-h">${h}</h2>`));
  assert.match(profile, /<nav className="prof-jump" aria-label="Profile sections">/);
  for (const id of ["personal", "physiology", "account"]) assert.match(profile, new RegExp(`href="#profile-${id}"`));
  assert.match(profile, /aria-labelledby="profile-personal-h"/);
});

test("Profile: nothing was removed, every original field is still on the page", () => {
  for (const l of LABELS) assert.ok(profile.includes(l), `field still present: ${l}`);
  for (const keep of ["Email", "Member since", "Connected services", "Wearable device and exports", "Notifications are not available yet", "Your profile is private", "<ChangePasswordCard email={session?.user.email} />", "<GarminDeviceCard", "Open the Connectivity Centre", "Laboratory reports", "Manual entry"]) assert.ok(profile.includes(keep), keep);
});

test("Profile: everyday fields are visible; less frequent ones sit in an expander with a summary of what is set", () => {
  const personal = between(profile, '<section id="profile-personal"', '<section id="profile-physiology"');
  const personalOpen = personal.slice(0, personal.indexOf("<Disclosure"));
  for (const l of ["Display name", "Date of birth", "Height (cm)", "Body weight ("]) assert.ok(personalOpen.includes(l), `${l} is visible without expanding`);
  const more = between(personal, '<Disclosure title="More about you"', "</Disclosure>");
  for (const l of ["Body fat (%)", "Preferred sports", "Primary training goal", "Goal notes"]) assert.ok(more.includes(l), `${l} is under "More about you"`);
  assert.match(personal, /summary=\{setSummary\(moreSet, 4\)\}/);

  const phys = between(profile, '<section id="profile-physiology"', "</form>");
  const physOpen = phys.slice(0, phys.indexOf("<Disclosure"));
  for (const l of ["Resting heart rate baseline (bpm)", "Maximum heart rate (bpm)", "FTP / threshold power (W)", "Sleep goal (hours)"]) assert.ok(physOpen.includes(l), `${l} is visible without expanding`);
  const adv = between(phys, '<Disclosure title="Advanced physiology"', "</Disclosure>");
  for (const l of ["VO2 max (ml/kg/min)", "Lactate threshold heart rate (bpm)", "Threshold pace (min per", "Training experience"]) assert.ok(adv.includes(l), `${l} is under "Advanced physiology"`);
  assert.match(phys, /summary=\{setSummary\(advSet, 4\)\}/);
  assert.match(profile, /const moreSet = countSet\(\[draft\.body_fat, draft\.preferred_sports, draft\.primary_goal, draft\.goal_notes\]\)/);
  assert.match(profile, /const advSet = countSet\(\[draft\.vo2max, draft\.lthr, draft\.threshold_pace, draft\.experience_level\]\)/);
  assert.match(profile, /Intervals\.icu \$\{integrations\.intervals\.connected \? "connected" : "not connected"\}/, "the connection status shows even when Connected services is collapsed");
});

test("Profile: warnings are never hidden. Notices sit outside every expander, and a failed save opens them all", () => {
  const firstDisc = profile.indexOf("<Disclosure");
  for (const w of ['{error && <div className="notice error">{error}</div>}', '{ok && <div className="notice ok">{ok}</div>}', "{locked && <div className=\"notice\">"]) assert.ok(profile.indexOf(w) > 0 && profile.indexOf(w) < firstDisc, `${w.slice(0, 30)}… is outside the expanders`);
  assert.match(profile, /if \(result\.error\) \{ setError\(result\.error\); setOk\(null\); setShowAll\(true\); return; \}/);
  assert.match(profile, /catch \(x\) \{ setError\(errMsg\(x\)\); setShowAll\(true\); \}/);
  assert.equal((profile.match(/forceOpen=\{showAll\}/g) ?? []).length, 2, "both field expanders open on a failed save");
  assert.match(profile, /locked = !state\.migrated/); assert.match(profile, /disabled=\{locked\}/);
});

test("Profile: one form, one save. Account preferences still belong to it; the save bar submits it", () => {
  assert.match(profile, /<form id="profile-form" onSubmit=\{save\}>/); assert.equal((profile.match(/<form /g) ?? []).length, 1);
  const form = between(profile, '<form id="profile-form"', "</form>");
  assert.ok(form.includes("profile-personal") && form.includes("profile-physiology") && !form.includes("profile-account"));
  assert.match(profile, /<select form="profile-form" value=\{draft\.units\} onChange=\{changeUnits\}>/); assert.match(profile, /<input form="profile-form" list="tzlist" value=\{draft\.timezone\}/);
  assert.match(profile, /<button className="btn" type="submit" form="profile-form" disabled=\{saving \|\| !dirty\}>/);
  assert.match(profile, /saveProfile\(getSupabase\(\), session\.user\.id, result\.patch, state\.exists, \{ timezone: draft\.timezone\.trim\(\), units: draft\.units \}\)/, "the save call is unchanged");
  assert.match(profile, /<div className="row savebar">/);
});

test("Profile: existing workflows preserved (baseline confirm, sources, retry, units conversion)", () => {
  for (const keep of ["window.confirm(`Replace your current", "Use as baseline", "AUTO_SOURCES.includes(cur)", ">Try again</button>", "void load()", "function changeUnits", "editValue(d, k, f, e.target.value)", "buildProfilePatch(", "Discard"]) assert.ok(profile.includes(keep), keep);
  assert.doesNotMatch(profile, /api_key|apiKey|intervals_credentials|SERVICE_ROLE/i);
});

// ------------------------------------------------------------------ Connections
test("Connections: a status overview shows every provider at a glance and links to its card", () => {
  const nav = between(hub, '<nav className="conn-glance"', "</nav>");
  assert.match(nav, /PROVIDERS\.map/); assert.match(nav, /href=\{`#conn-\$\{p\.id\}`\}/); assert.match(nav, /STATUS_LABEL\[c\.status\]/); assert.match(nav, /needs attention/);
  assert.match(nav, /needsAttention\(d\?\.status, d\?\.last_error\)/);
  assert.match(hub, /<nav className="conn-glance" aria-label="Connection status overview">/);
  assert.match(hub, /id=\{`conn-\$\{p\.id\}`\} className="card psec conn"/);
  assert.ok(PROVIDERS.length >= 6, "all providers get a card and a chip");
});

test("Connections: status and primary actions come first; warnings and errors stay visible; only secondary detail is collapsed", () => {
  const card = between(hub, '<section key={p.id} id={`conn-${p.id}`}', "</section>");
  const firstDisc = card.indexOf("<Disclosure");
  const visible = card.slice(0, firstDisc);
  // status badge, last sync, notes, set-up notice, last error and pauses are all visible
  for (const v of ["STATUS_LABEL[c.status]", "Last sync {when(last)}", "{c.note && ", "c.seenInData", "!configError && c.setupMissing.length > 0", "Last error", "Paused until", "Last successful sync", "Latest data"]) assert.ok(visible.includes(v), `${v} is visible without expanding`);
  // primary actions are visible, and appear before the expanders
  for (const a of ['connect("intervals")', 'disconnect(p)', 'connect("whoop")', "syncNow(p)", "<IntervalsCard embedded"]) assert.ok(visible.includes(a), `${a} is visible without expanding`);
  assert.ok(visible.indexOf('<div className="row">') > 0);
  // secondary content is inside the expanders
  const data = between(card, '<Disclosure title="Data, permissions and limits"', "</Disclosure>");
  assert.ok(data.includes("Data APEX can receive") && data.includes("<b>Permissions:</b>") && data.includes("<b>Limits:</b>"));
  const settings = between(card, '<Disclosure title="Sync settings"', "</Disclosure>");
  assert.ok(settings.includes('setting("fill_daily"') && settings.includes('setting("import_workouts"') && settings.includes("Use WHOOP HRV, resting heart rate and sleep") && settings.includes("Add WHOOP workouts to Activities"));
  assert.match(card, /\{p\.id === "whoop" && c\.status === "connected" && d && \(\s*\n\s*<Disclosure title="Sync settings"/, "settings only for a connected WHOOP, as before");
  assert.match(card, /of 2 on/, "the settings summary says how many are on");
});

test("Connections: every existing workflow and message is preserved", () => {
  for (const keep of [
    'p.id === "intervals" && <IntervalsCard embedded onChange={() => { void load(); }} />', "Sign in with Intervals.icu", "Disconnect sign-in", "Connect WHOOP", "Connect again", "Opening WHOOP…", "Sync now", "window.confirm(`Disconnect ${p.name}?",
    'snap.connections.status === "not-set-up" && ', 'snap.connections.status === "error" && ', "snap.partial && (", "configError && (", "Intervals.icu keeps working as before", "Try again",
    "!configError && c.setupMissing.length > 0", "snap.migrated14 &&", "connect(\"intervals\")", "RESULT_TEXT[r]", "Each connection above lists what it can and cannot provide.",
  ]) assert.ok(hub.includes(keep), `kept: ${keep}`);
  assert.equal((hub.match(/<IntervalsCard /g) ?? []).length, 1, "still one place for the Intervals.icu connection form");
  assert.ok(hub.indexOf("snap.connections.status === \"error\"") < hub.indexOf('<nav className="conn-glance"'), "page-level errors come before everything else");
});

test("Connections: notices and errors are outside every expander", () => {
  const firstDisc = hub.indexOf("<Disclosure");
  for (const w of ['snap.connections.status === "not-set-up"', 'snap.connections.status === "error"', "snap.partial && (", "configError && (", "{msg && <div"]) assert.ok(hub.indexOf(w) > 0 && hub.indexOf(w) < firstDisc, w);
});

// ------------------------------------------------------------------ CSS
test("CSS: restrained expander, 48px target, focus ring, summary stays readable on phones, reduced motion, save bar above the bottom bar", () => {
  const b = css.slice(css.indexOf("/* progressive disclosure"));
  assert.match(b, /\.disc>summary\{list-style:none;display:flex;[^}]*min-height:48px/); assert.match(b, /\.disc>summary::-webkit-details-marker\{display:none\}/);
  assert.match(b, /\.disc>summary:focus-visible\{outline:2px solid #38d4d0/); assert.match(b, /\.prof-jump a:focus-visible,\.conn-chip:focus-visible\{outline:2px solid #38d4d0/);
  assert.match(b, /\.disc\[open\]>summary \.disc-chev\{transform:rotate\(180deg\)\}/);
  assert.match(b, /@media \(max-width:520px\)\{[^@]*\.disc-sum\{order:3;flex-basis:100%;max-width:none;text-align:left;white-space:normal\}/, "the summary (status) wraps under the title instead of being cut off");
  assert.match(b, /@media \(prefers-reduced-motion:reduce\)\{\.disc-chev\{transition:none\}\}/);
  assert.match(b, /@media \(max-width:800px\)\{\.savebar\{bottom:var\(--bnav-h\)\}\}/);
  assert.match(b, /\.conn-chip\.attn\{border-color:#4a2327\}\.conn-chip\.attn \.conn-dot\{background:var\(--red\)\}/);
  assert.doesNotMatch(b, /box-shadow|glow/, "no glow");
});

test("scope: no schema, engine or dependency change in this phase", () => {
  for (const f of ["components/ui/Disclosure.tsx", "lib/disclosure.ts"]) assert.doesNotMatch(read(f), /supabase|fetch\(|\.rpc\(|process\.env|\.from\("/, f);
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["@supabase/supabase-js", "next", "react", "react-dom"], "no new dependency");
});
