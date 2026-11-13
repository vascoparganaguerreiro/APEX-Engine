// Coach mobile redesign (UI/UX Phase 2, part B): compact context header, composer, suggestions, desktop and behaviour preserved.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COACH_CATEGORIES } from "../lib/coach/consentStore.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const page = read("app/(app)/coach/page.tsx");
const chat = read("components/coach/ChatPanel.tsx");
const css = read("app/globals.css");
const block = css.slice(css.indexOf("/* global quick actions"));
const media = block.slice(block.indexOf("@media (max-width:800px),(orientation:landscape) and (pointer:coarse) and (max-height:500px) and (max-width:1000px){"));

test("context header reads 'Coach Context · n/total active' from the categories the user actually shares", () => {
  assert.ok(COACH_CATEGORIES.length >= 1, "the header's total is the real number of shareable categories (7 today)");
  assert.match(page, /`Coach Context · \$\{authorized\.length\}\/\$\{COACH_CATEGORIES\.length\} active`/);
  assert.match(page, /const authorized = authorizedOf\(consent\)/, "n comes from the existing consent state, not a new source");
  assert.match(page, /"Coach Context · loading"/);
});

test("the header is a real disclosure button: expanded state, controlled region, keyboard-operable, collapsed by default", () => {
  assert.match(page, /const \[ctxOpen, setCtxOpen\] = useState\(false\)/);
  assert.match(page, /<button type="button" className="coachctx-head" aria-expanded=\{ctxOpen\} aria-controls="coach-context" onClick=\{\(\) => setCtxOpen\(\(v\) => !v\)\}>/);
  assert.match(page, /<div id="coach-context" className="coachctx-body">/);
  assert.match(media, /\.coachctx-head:focus-visible\{outline:2px solid #38d4d0/); assert.match(media, /min-height:48px/);
  assert.match(page, /\{missing\.length > 0 && <span className="coachctx-miss">\{missing\.length\} missing<\/span>\}/, "missing data is still flagged in the header");
});

test("nothing is removed: the sharing panel, the four context tiles and the Missing list are all inside the expandable region, unchanged", () => {
  const start = page.indexOf('id="coach-context"'), end = page.indexOf('<div className="captiles">');
  const body = page.slice(start, end);
  for (const keep of ["<ConsentPanel consent={consent} onChange={setConsent} />", "Your context today", "measured data only", "Latest wellness", "Last activity", "Next race", "Profile baselines", "Missing", "missing.map"]) assert.ok(body.includes(keep), `still present: ${keep}`);
  assert.ok(start > 0 && end > start);
});

test("desktop keeps the original layout: header hidden, body always shown; the collapse exists only inside the phone media query", () => {
  const before = block.slice(0, block.indexOf("@media (max-width:800px),(orientation:landscape) and (pointer:coarse) and (max-height:500px) and (max-width:1000px){"));
  assert.match(before, /\.coachctx-head\{display:none\}/); assert.doesNotMatch(before, /\.coachctx-body\{display:none\}/);
  assert.match(media, /\.coachctx-body\{display:none;[^}]*\}\.coachctx\.open \.coachctx-body\{display:block\}/);
  assert.match(before, /\.sug-strip\{display:none\}/, "the phone-only suggestion row is hidden by default");
  assert.ok(block.indexOf(".sug-strip{display:none}") < block.indexOf(".sug-strip{display:flex"), "default rule comes before the phone override");
  assert.match(css, /@media \(max-width:760px\)\{\.chatwrap\{grid-template-columns:1fr\}/, "the existing 760px chat rule is untouched");
});

test("composer: sticky at the bottom above the bar and the safe area, releases the bar space while the keyboard is open, 48px targets, no auto-focus", () => {
  assert.match(media, /\.composer\{position:sticky;bottom:var\(--bnav-h\);/);
  assert.match(media, /:root\.kb-open\{--bnav-h:0px\}/);
  assert.match(css, /--bnav-h:calc\(60px \+ env\(safe-area-inset-bottom\)\)/, "--bnav-h already contains the safe-area inset");
  assert.match(media, /\.composer \.chatinput textarea\{min-height:48px;/); assert.match(media, /\.composer \.chatinput \.btn\{min-height:48px\}/);
  assert.match(media, /\.coachpage\.chatmode\{display:flex;flex-direction:column;min-height:calc\(100vh - var\(--bnav-h\) - 16px\);min-height:calc\(100dvh - var\(--bnav-h\) - 16px\)\}/);
  assert.match(media, /\.chatmode \.chatlog>div:last-child\{scroll-margin-bottom:150px\}/, "the newest message is never hidden behind the composer");
  assert.doesNotMatch(chat, /autoFocus/, "the keyboard does not pop up by itself");
  assert.match(page, /className=\{chatTab \? "coachpage chatmode" : "coachpage"\}/); assert.match(page, /const chatTab = tab === "ask" \|\| tab === "plan"/);
  assert.match(chat, /<div className="composer" ref=\{composer\}>[\s\S]*<form className="chatinput"[\s\S]*AI-generated guidance[\s\S]*<\/div>\s*\n\s*<\/div>\s*\n\s*<\/div>/, "form and the safety disclaimer sit together in the composer");
});

test("suggestions: one swipeable row right above the composer on phones, same prompts, same send path, desktop list kept", () => {
  assert.match(chat, /className="sug-strip" role="group" aria-label="Suggested questions"/);
  assert.match(chat, /className="row sug-inline"/);
  assert.equal((chat.match(/suggestions\.map\(\(s\) => <button key=\{s\} type="button" className="chip" onClick=\{\(\) => void send\(s\)\}>/g) ?? []).length, 2, "both lists send through the same send()");
  assert.match(media, /\.sug-strip\{display:flex;gap:8px;overflow-x:auto;/); assert.match(media, /\.sug-inline\{display:none\}/);
  assert.match(media, /\.sug-strip \.chip\{flex:none;white-space:nowrap\}/);
  assert.match(chat, /\{msgs\.length === 0 && \(\s*\n?\s*\/\*[\s\S]*?\*\/\s*\n?\s*<div className="sug-strip"/, "shown while the conversation is empty, like the original list");
  for (const q of ["Am I training too much?", "Should I do intervals tomorrow?"]) assert.ok(page.includes(q), `prompt kept: ${q}`);
});

test("tabs and conversation history become compact, scrollable rows on phones; descriptions stay available as tooltips", () => {
  assert.match(media, /\.coachpage \.captiles\{display:flex;gap:8px;overflow-x:auto;/); assert.match(media, /\.coachpage \.captile\{[^}]*min-height:44px/);
  assert.match(media, /\.chatmode \.convs\{flex-wrap:nowrap;overflow-x:auto;/);
  assert.match(page, /aria-pressed=\{tab === t\.id\} title=\{t\.text\}/);
  assert.match(media, /\.coachpage \.captile\.on\{border-color:#38d4d0;box-shadow:none/, "cyan used for the active tab only, no glow");
});

test("chat behaviour and data are unchanged: same request, history, streaming states, errors, retry, consent", () => {
  for (const keep of [
    'coachRequest({ intent, message, conversationId: active, domain: "general", raceId }, authorized, consentUser)', "listConversations(getSupabase())", "listMessages(getSupabase(), id)",
    "The Coach is thinking...", 'aria-live="polite"', "Not sent. Retry", "setError(errMsg(e))", "maxLength={2000}", 'aria-label="Message"', "e.key === \"Enter\" && !e.shiftKey", "+ New conversation",
    "window.confirm(\"Delete this conversation?", "disabled={busy || !input.trim()}",
  ]) assert.ok(chat.includes(keep), `kept in ChatPanel: ${keep}`);
  for (const keep of ["coachRequest({ intent: \"daily\" }, authorized, consentUser)", "listAssessments(getSupabase())", "<SessionEvaluator authorized={authorized} consentUser={consentUser}", "<ChatPanel intent=\"chat\" authorized={authorized} consentUser={consentUser}", "<ChatPanel intent=\"plan\"", "Recent assessments", "ConsentPanel"]) assert.ok(page.includes(keep), `kept in the Coach page: ${keep}`);
  assert.doesNotMatch(page + chat, /gemini|prompts|systemPrompt|GEMINI/i, "no provider or prompt code is touched from the UI");
});

test("motion: the context chevron and every new transition respect prefers-reduced-motion", () => {
  assert.match(block, /prefers-reduced-motion:reduce\)\{[^\n]*\.coachctx-head svg\{transition:none\}/);
});
