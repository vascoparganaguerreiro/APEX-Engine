// Phase 2, premium mobile experience: the Coach composer, the grouped More sheet and the four-tab bar. Pure logic is tested directly; components and CSS at
// source level (the build covers compilation). Routes, API calls and desktop layout are unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { DESKTOP_NAV, MORE_GROUPS, MORE_NAV, PRIMARY_NAV, activeTab } from "../lib/nav.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const css = read("app/globals.css"), bar = read("components/nav/BottomNav.tsx"), chat = read("components/coach/ChatPanel.tsx");
const block = (start: string, end?: string) => { const i = css.indexOf(start); assert.ok(i >= 0, `${start} exists`); return css.slice(i, end ? css.indexOf(end, i) : undefined); };
const mobileNav = css.slice(css.indexOf("/* mobile bottom navigation"));
// a rule inside the phone query (indented), not the default-hidden one at the top of the block
const rule = (sel: string) => { const m = mobileNav.match(new RegExp(`\\n\\s+${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\{([^}]*)\\}`)); return m ? m[1] : ""; };

// ------------------------------------------------------------------ More: groups
test("More groups: every existing destination appears exactly once, with its route and label unchanged, in clear groups", () => {
  assert.deepEqual(MORE_GROUPS.map((g) => g.id), ["train", "health", "account"]);
  assert.deepEqual(MORE_GROUPS.map((g) => g.label), ["Training", "Health", "Settings and account"]);
  assert.deepEqual(MORE_GROUPS.map((g) => g.items.map((i) => i.href)), [["/training", "/strength", "/races"], ["/biomarkers", "/supplements", "/timeline"], ["/integrations", "/profile"]]);
  const flat = MORE_GROUPS.flatMap((g) => g.items);
  assert.deepEqual(MORE_NAV, flat, "the flat list is the groups, in order");
  assert.equal(new Set(flat.map((i) => i.href)).size, flat.length, "no duplicate entry");
  assert.deepEqual([...PRIMARY_NAV, ...MORE_NAV].map((n) => n.href).sort(), DESKTOP_NAV.map((n) => n.href).sort(), "nothing lost, nothing added, nothing shared with the bar");
  for (const n of flat) {
    assert.equal(DESKTOP_NAV.find((d) => d.href === n.href)!.label, n.label, `${n.href} keeps its label`);
    assert.ok(existsSync(new URL(`../app/(app)${n.href}/page.tsx`, import.meta.url)), `${n.href} is an existing page`);
    assert.equal(activeTab(n.href), "more"); assert.equal(activeTab(`${n.href}/x`), "more");
  }
  for (const g of MORE_GROUPS) assert.ok(g.items.length >= 2 && g.label.length <= 24, `${g.id}: a real group with a short label`);
  assert.equal(MORE_NAV.find((n) => n.href === "/integrations")!.label, "Connections");
});

test("More sheet: modal dialog with a heading, a close button, grouped lists, outline icons, and the account action kept apart from destinations", () => {
  assert.match(bar, /role="dialog" aria-label="More destinations" aria-modal="true"/);
  assert.match(bar, /<h2 className="bnav-title">More<\/h2>/); assert.match(bar, /aria-label="Close menu" onClick=\{\(\) => setOpen\(false\)\}/);
  assert.match(bar, /MORE_GROUPS\.map\(\(g\) => \(/); assert.match(bar, /<section key=\{g\.id\}[^>]*aria-labelledby=\{`bnav-g-\$\{g\.id\}`\}/); assert.match(bar, /<h3 id=\{`bnav-g-\$\{g\.id\}`\}>\{g\.label\}<\/h3>/);
  assert.match(bar, /aria-current=\{isActive\(path, n\.href\) \? "page" : undefined\}/);
  // one outline icon per destination, on the same grid and stroke as the bar
  for (const n of MORE_NAV) assert.ok(bar.includes(`"${n.href}": <`), `${n.href} has an icon`);
  assert.equal((bar.match(/strokeWidth="1\.75"/g) ?? []).length >= 2, true); assert.doesNotMatch(bar, /fill="(?!none)[^"]+"/, "outline only, no filled icons");
  assert.match(bar, /aria-hidden="true" focusable="false"/);
  // sign out is an action: a button outside the destination lists, with no chevron, the same handler as before
  const actions = bar.slice(bar.indexOf('<div className="bnav-actions">'), bar.indexOf("</nav>"));
  assert.match(actions, /<button type="button" className="bnav-row bnav-out" onClick=\{onSignOut\}>/); assert.ok(!/<Link|M9 6l6 6-6 6/.test(actions.slice(0, actions.indexOf("</div>"))), "no link and no chevron among the actions");
  assert.match(actions, /Signed in as \{email\}/);
  assert.ok(bar.indexOf("MORE_GROUPS.map") < bar.indexOf('<div className="bnav-actions">'), "destinations first, account actions last");
  assert.equal((bar.match(/<Link href=\{n\.href\}/g) ?? []).length, 1, "destinations are rendered from the groups only (no second list)");
});

test("More sheet: focus is managed (in on open, trapped, Escape and scrim and close button dismiss, returns to More) and the page does not scroll behind it", () => {
  assert.match(bar, /querySelector<HTMLElement>\("a,button"\)\?\.focus\(\)/); assert.match(bar, /btn\?\.focus\(\)/);
  assert.match(bar, /e\.key === "Escape"/); assert.match(bar, /className="bnav-scrim" onClick=\{\(\) => setOpen\(false\)\}/);
  assert.match(bar, /onKeyDown=\{trapTab\}/); assert.match(bar, /if \(e\.shiftKey && now === first\) \{ e\.preventDefault\(\); last\.focus\(\); \}/); assert.match(bar, /else if \(!e\.shiftKey && now === last\) \{ e\.preventDefault\(\); first\.focus\(\); \}/);
  assert.match(bar, /document\.body\.style\.overflow = "hidden"/); assert.match(bar, /document\.body\.style\.overflow = prev/);
  assert.match(bar, /useEffect\(\(\) => \{ setOpen\(false\); \}, \[path\]\)/); assert.match(bar, /\(min-width: 801px\)/);
});

test("More sheet CSS: about three quarters of the screen, above the bar, scrolls inside, 44px+ targets, restrained, reduced motion", () => {
  const panel = rule(".bnav-panel");
  assert.match(panel, /max-height:75vh;max-height:min\(75dvh,calc\(100dvh - var\(--bnav-h\) - 16px\)\)/); assert.match(panel, /bottom:var\(--bnav-h\)/); assert.match(panel, /overflow-y:auto/); assert.match(panel, /overscroll-behavior:contain/);
  assert.match(panel, /border-radius:18px 18px 0 0/);
  assert.match(rule(".bnav-head"), /position:sticky;top:0/, "the title and close button stay visible while the list scrolls");
  assert.match(rule(".bnav-close"), /width:44px;height:44px/); assert.match(rule(".bnav-row"), /min-height:52px/);
  assert.match(rule(".bnav-group h3"), /font-size:var\(--fs-xs\)/, "labels are at least 12px");
  assert.doesNotMatch(panel + rule(".bnav-row") + rule(".bnav-out"), /box-shadow|gradient|filter/, "no shadows, gradients or blur");
  assert.match(rule(".bnav-out"), /border:1px solid var\(--line\)/, "the action looks different from a destination row");
  assert.match(mobileNav, /@media \(prefers-reduced-motion:reduce\)\{[^@]*\.bnav-panel\{animation:none\}/);
});

// ------------------------------------------------------------------ bottom bar
test("bottom bar: four equal tabs, one icon size and one label style, solid and flat, safe areas on every side, never over content", () => {
  assert.deepEqual(PRIMARY_NAV.map((n) => n.label), ["Today", "Activities", "Coach"]);
  const b = rule(".bnav");
  assert.match(b, /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/); assert.match(b, /padding:0 env\(safe-area-inset-right\) env\(safe-area-inset-bottom\) env\(safe-area-inset-left\)/);
  assert.match(b, /background:var\(--card2\)/); assert.doesNotMatch(b, /backdrop-filter|blur|gradient|box-shadow/, "restrained: no blur, gradient or shadow");
  assert.match(rule(".bnav-item"), /font-size:12px/); assert.match(rule(".bnav-item"), /min-height:56px/); assert.match(rule(".bnav-item"), /gap:4px/);
  assert.match(bar, /const Icon = \(\{ name \}: \{ name: BottomTab \}\) => <Svg>\{ICON\[name\]\}<\/Svg>/); assert.match(bar, /\{ children, size = 24 \}/, "every tab icon is 24px");
  assert.match(rule(".bnav-item.on"), /color:var\(--cyan\)/); assert.match(css, /\.bnav-item\.on::before\{content:"";[^}]*height:2px/, "active is shown by colour AND a marker, not colour alone");
  assert.match(bar, /aria-current=\{on \? "page" : undefined\}/);
  assert.match(mobileNav, /--bnav-h:calc\(60px \+ env\(safe-area-inset-bottom\)\)/); assert.match(mobileNav, /\.main\{padding-bottom:calc\(var\(--bnav-h\) \+ 96px \+ var\(--rest-h,0px\)\)\}/);
  assert.match(css, /\n\.shell\{padding-left:env\(safe-area-inset-left\);padding-right:env\(safe-area-inset-right\)\}\n/, "landscape notch: a top-level rule, at every width (see tests/landscape-phone.test.ts)");
  assert.match(css, /\.bnav\.typing\{transform:translateY\(100%\);visibility:hidden\}/, "hidden while the keyboard is open");
  const layout = read("app/layout.tsx");
  assert.match(layout, /viewportFit: "cover"/, "needed for the safe-area insets to report real values on notched phones");
  assert.match(layout, /interactiveWidget: "resizes-content"/, "an open keyboard shrinks the layout so bottom controls stay above it");
  assert.match(layout, /initialScale: 1/); assert.ok(!/maximumScale|userScalable/.test(layout), "pinch-zoom stays enabled");
});

test("desktop is unchanged: the sidebar, its routes and the mobile-only rules", () => {
  assert.deepEqual(DESKTOP_NAV.map((n) => n.label), ["Today", "Activities", "Strength", "Connections", "Training", "Coach", "Supplements", "Biomarkers", "Timeline", "Races", "Profile"]);
  const outside = css.slice(0, css.indexOf("/* mobile bottom navigation"));
  assert.doesNotMatch(outside, /\.bnav/); assert.match(mobileNav, /^\/\* mobile bottom navigation[^\n]*\r?\n\.bnav,\.bnav-scrim,\.bnav-panel\{display:none\}\r?\n@media \(max-width:800px\),\(orientation:landscape\) and \(pointer:coarse\) and \(max-height:500px\) and \(max-width:1000px\)\{/);
  // the Coach pill and send icon exist only inside the phone query; desktop keeps its field and its "Send" text
  const desktop = css.slice(0, css.indexOf("@media (max-width:800px),(orientation:landscape) and (pointer:coarse) and (max-height:500px) and (max-width:1000px){", css.indexOf("/* Coach context header")));
  assert.match(css, /\.chatinput\{display:flex;gap:8px;align-items:flex-end;margin-top:10px\}\.chatinput textarea\{flex:1;min-height:68px;resize:none\}/);
  assert.match(css, /\.sendico\{display:none\}/); assert.doesNotMatch(desktop.slice(desktop.indexOf("/* Coach context header")), /border-radius:26px/);
});

// ------------------------------------------------------------------ Coach composer
test("Coach composer: slim rounded field, send icon inside, keyboard submit, auto-growing, long messages, nothing changes in the request", () => {
  const form = chat.slice(chat.indexOf('<form className="chatinput"'), chat.indexOf("</form>"));
  assert.match(form, /<textarea ref=\{field\} rows=\{1\} maxLength=\{2000\}/); assert.match(form, /aria-label="Message"/);
  assert.match(form, /enterKeyHint="send"/); assert.match(form, /autoComplete="off"/); assert.match(form, /autoCapitalize="sentences"/);
  assert.match(form, /e\.key === "Enter" && !e\.shiftKey\) \{ e\.preventDefault\(\); void send\(input\); \}/, "Enter sends, Shift+Enter adds a line");
  assert.match(form, /<button className="btn sendbtn" type="submit" aria-label="Send message" aria-busy=\{busy \|\| undefined\} disabled=\{busy \|\| !input\.trim\(\)\}/);
  assert.match(form, /onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/, "sending does not pull focus off the field, so the keyboard stays open");
  assert.match(form, /<svg className="sendico"[^>]*aria-hidden="true" focusable="false">/); assert.match(form, /<span className="sendtxt">\{busy \? "\.\.\." : "Send"\}<\/span>/);
  assert.doesNotMatch(chat, /autoFocus/, "the keyboard never opens by itself");
  assert.match(chat, /el\.style\.height = "auto"; el\.style\.height = `\$\{el\.scrollHeight\}px`; \}, \[input\]\)/, "the field grows with the text");
  assert.match(chat, /input\.length >= 1800 && <p className="chatcount muted small" role="status" aria-live="polite">\{input\.length\} of 2000 characters<\/p>/, "a long message says how much room is left");
  assert.match(chat, /if \(document\.activeElement === field\.current\) end\.current\?\.scrollIntoView\(\{ block: "end" \}\)/, "while typing, the latest message stays visible above the growing field");
  assert.match(chat, /--composer-h/);
  // unchanged: request, history, states, errors, retry
  for (const keep of ['coachRequest({ intent, message, conversationId: active, domain: "general", raceId }, authorized, consentUser)', "listConversations(getSupabase())", "listMessages(getSupabase(), id)",
    "The Coach is thinking...", 'aria-live="polite"', "Not sent. Retry", "setError(errMsg(e))"]) assert.ok(chat.includes(keep), `kept: ${keep}`);
  assert.doesNotMatch(chat, /gemini|systemPrompt|GEMINI|fetch\(/i);
});

test("Coach composer CSS: pill, 16px text (no iOS zoom), capped height, 48px circular send, above the bar, safe, readable disclaimer", () => {
  const phone = block("/* Coach context header", "@media (prefers-reduced-motion");
  assert.match(phone, /\.composer \.chatinput\{[^}]*border:1px solid var\(--line\);border-radius:26px;background:var\(--card\)/);
  assert.match(phone, /\.composer \.chatinput:focus-within\{border-color:var\(--focus\)\}/);
  assert.match(phone, /\.composer \.chatinput textarea\{min-height:48px;max-height:30vh;border:0;[^}]*font-size:16px/);
  assert.match(phone, /\.composer \.chatinput \.sendbtn\{flex:none;width:48px;padding:0;border-radius:50%/); assert.match(phone, /\.composer \.sendtxt\{display:none\}\.composer \.sendico\{display:block\}/);
  assert.match(phone, /\.composer\{flex:none;position:sticky;bottom:var\(--bnav-h\);/); assert.match(phone, /:root\.kb-open\{--bnav-h:0px\}/);
  assert.match(phone, /\.chatmode \.chatlog>div:last-child\{scroll-margin-bottom:150px\}/, "the newest message is never hidden behind the composer");
  assert.match(phone, /\.chatmode \.chatlog\{flex:1;max-height:none;min-height:0;overflow-y:auto;/);
  assert.match(phone, /\.composer>p\{font-size:12px/, "the safety note is no smaller than 12px");
  assert.match(phone, /\.sug-strip\{display:flex;gap:8px;overflow-x:auto;/); assert.match(phone, /\.sug-strip \.chip\{min-height:40px\}/);
  assert.doesNotMatch(phone.slice(phone.indexOf(".composer{")), /\.composer[^{]*\{[^}]*(box-shadow|gradient)/, "no shadow or gradient on the composer");
  assert.match(css, /\.bubble\.assistant\{align-self:flex-start;background:var\(--card\)\}/);
});

// ------------------------------------------------------------------ boundaries
test("scope: no calculation, schema, API, prompt, auth or dependency change in this phase; Phase 1 Today files are not part of it", () => {
  assert.doesNotMatch(bar, /supabase|from\("|auth\./, "the bar has no queries or auth logic");
  assert.doesNotMatch(read("lib/nav.ts"), /supabase|fetch\(|localStorage/, "the navigation model stays pure");
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
  assert.ok(!["framer-motion", "lucide-react", "@headlessui/react", "@radix-ui/react-dialog", "react-icons"].some((d) => d in pkg.dependencies));
  assert.match(read("app/(app)/today/page.tsx"), /<NextActionCard a=\{action\}/); assert.match(read("components/today/FiveDay.tsx"), /className="td-strip"/);
});
