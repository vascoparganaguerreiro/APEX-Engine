// Coach mobile layout (one-screen page, scrolling conversation, composer at the bottom) and the Activities summary grid / pace tile.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { paceKpiLabel, summarizeActivities, type Activity } from "../lib/activities.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const css = read("app/globals.css");
const phone = css.slice(css.indexOf("@media (max-width:800px),(orientation:landscape) and (pointer:coarse) and (max-height:500px) and (max-width:1000px){", css.indexOf("/* global quick actions")));
// The declarations of the first rule that starts with `sel{` (preceded by whitespace or a closing brace), or "".
const rule = (sel: string) => {
  const key = sel + "{";
  for (let i = phone.indexOf(key); i !== -1; i = phone.indexOf(key, i + 1)) {
    const prev = phone[i - 1];
    if (prev === undefined || /[\s}]/.test(prev)) return phone.slice(i + key.length, phone.indexOf("}", i));
  }
  return "";
};

test("Coach chat tab on a phone is exactly one screen tall and only the conversation scrolls", () => {
  const page = rule(".coachpage.chatmode");
  assert.match(page, /height:calc\(100dvh - var\(--bnav-h\) - 16px\)/); assert.match(page, /overflow:hidden/); assert.doesNotMatch(page, /min-height/);
  assert.match(phone, /\.main:has\(\.coachpage\.chatmode\)\{padding-bottom:0\}/, "the page's bottom padding must not push it past one screen");
  assert.match(rule(".coachpage.chatmode .chatwrap"), /min-height:0/);
  const log = rule(".chatmode .chatlog"); assert.match(log, /min-height:0/); assert.match(log, /overflow-y:auto/); assert.match(log, /flex:1/);
  assert.match(rule(".composer"), /flex:none/, "the composer keeps its size at the bottom of the column");
  assert.match(phone, /:root\.kb-open\{--bnav-h:0px\}/, "an open keyboard releases the bar space");
});

test("Coach desktop is unchanged: the height rules exist only inside the phone query", () => {
  const before = css.slice(0, css.indexOf(phone));
  assert.doesNotMatch(before, /\.coachpage\.chatmode/); assert.match(before, /\.chatlog\{min-height:260px;max-height:58vh;overflow-y:auto/);
});

test("weekly summary is a 2x2 grid whose tiles can shrink and wrap long distances", () => {
  const card = read("components/WeekCard.tsx");
  assert.match(card, /className="metrics week-metrics"/); assert.doesNotMatch(card, /className="wide"/);
  assert.equal((card.match(/<div><small>(Sessions|Time|Load|Distance)<\/small>/g) ?? []).length, 4);
  assert.match(css, /\.week-metrics\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
  assert.match(css, /\.week-metrics>div\{min-width:0\}\.week-metrics b\{overflow-wrap:anywhere/);
});

test("average pace tile: only for run, swim and bike, with an accurate label, never a 'pick a sport' placeholder", () => {
  assert.equal(paceKpiLabel("run"), "Avg pace"); assert.equal(paceKpiLabel("swim"), "Avg pace"); assert.equal(paceKpiLabel("bike"), "Avg speed");
  for (const s of ["all", "strength", "yoga", "other", ""]) assert.equal(paceKpiLabel(s), null, s);
  const page = read("app/(app)/activities/page.tsx");
  assert.doesNotMatch(page, /pick a sport/); assert.doesNotMatch(page, /Avg pace[^"]*\/ power/);
  assert.match(page, /\{paceKpi && <div className="kpi"><small>\{paceKpi\}<\/small>/);
  const a: Activity = { id: "1", sport: "run", started_at: "2026-01-01T08:00:00Z", duration_s: 3000, distance_m: 10000 } as Activity;
  assert.equal(summarizeActivities([a], "run").pace, "5:00/km");
  assert.equal(summarizeActivities([a], "all").pace, null);
});
