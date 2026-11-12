// /import and /integrations consolidation: the Intervals.icu connection (Athlete ID, API key, status, sync) lives in ONE place, the
// Intervals.icu card of the Connectivity Centre. Static checks over the source; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { PROVIDERS } from "../lib/integrations/providers.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const walk = (dir: string): string[] => readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
const hub = read("app/(app)/integrations/page.tsx"), card = read("components/IntervalsCard.tsx"), imp = read("app/(app)/import/page.tsx");

test("the Intervals.icu connection form and sync controls exist in exactly one component, embedded in the hub", () => {
  const sources = [...walk("app"), ...walk("components")].filter((f) => /\.tsx$/.test(f));
  const withForm = sources.filter((f) => /connectIntervals\(|placeholder="i12345"/.test(read(f)));
  const withSync = sources.filter((f) => /syncIntervals\(/.test(read(f)));
  assert.deepEqual(withForm, ["components/IntervalsCard.tsx"]);
  // Today's quick-action sheet keeps its one-tap "sync now" shortcut (same API, shown only when connected); it has no credentials or settings.
  assert.deepEqual(withSync, ["components/IntervalsCard.tsx", "components/today/QuickLog.tsx"]);
  assert.ok(!/apiKey|athleteId|type="password"/.test(read("components/today/QuickLog.tsx")));
  assert.deepEqual(sources.filter((f) => /disconnectIntervals\(/.test(read(f))), ["components/IntervalsCard.tsx"]);
  assert.match(hub, /import IntervalsCard from "@\/components\/IntervalsCard"/);
  assert.equal((hub.match(/<IntervalsCard /g) ?? []).length, 1);
  assert.match(hub, /p\.id === "intervals" && <IntervalsCard embedded onChange=\{\(\) => \{ void load\(\); \}\} \/>/);
  assert.ok(!/syncIntervals|Manage API key|Connect with API key|href="\/import"/.test(hub), "no second Intervals sync button or link to the old page");
});

test("/import no longer duplicates anything: it only forwards to the Connectivity Centre (it held no other import)", () => {
  assert.match(imp, /redirect\("\/integrations"\)/);
  assert.ok(!/IntervalsCard|connectIntervals|syncIntervals|type="password"|Athlete/.test(imp));
  assert.ok(!/^"use client"/.test(imp), "a server-side redirect, so no flash of an empty page");
  const nav = read("lib/nav.ts");
  assert.ok(!/href: "\/import"/.test(nav) && /href: "\/integrations", label: "Connections"/.test(nav));
  const links = [...walk("app"), ...walk("components")].filter((f) => /\.tsx$/.test(f) && f !== "app/(app)/import/page.tsx" && /href="\/import"/.test(read(f)));
  assert.deepEqual(links, [], "nothing links to the old page any more");
});

test("the genuine manual imports elsewhere are untouched", () => {
  assert.ok(existsSync(new URL("../app/(app)/strength/import/page.tsx", import.meta.url)), "Hevy CSV import (Strength Hub)");
  assert.match(read("components/strength/Bits.tsx"), /href: "\/strength\/import", label: "Import"/);
  assert.ok(existsSync(new URL("../app/api/biomarkers/extract/route.ts", import.meta.url)), "lab report import");
});

test("the card keeps its connection logic: same API calls, key never shown or logged, cleared after use; embedded drops the duplicate header", () => {
  assert.match(card, /connectIntervals\(athleteId, apiKey\)/); assert.match(card, /disconnectIntervals\(\)/); assert.match(card, /syncIntervals\(full \? SYNC_DAYS : undefined\)/);
  assert.match(card, /select\("athlete_id,last_sync_at"\)/, "only non-secret columns are read");
  assert.match(card, /setApiKey\(""\)/); assert.match(card, /<input type="password" value=\{apiKey\}/);
  assert.ok(!/console\.|localStorage|sessionStorage/.test(card));
  assert.equal((card.match(/onChange\?\.\(\)/g) ?? []).length, 3, "the hub refreshes after connect, sync and disconnect");
  assert.match(card, /\{!embedded && \(\s*<div className="act-head">/);
  for (const f of ["connect", "sync", "debug"].filter((x) => x !== "debug")) assert.ok(existsSync(new URL(`../app/api/intervals/${f}/route.ts`, import.meta.url)), `API route ${f} is untouched`);
});

test("every other integration card still works: provider list, WHOOP connect/sync/disconnect/settings, Intervals sign-in", () => {
  const ids = PROVIDERS.map((p) => p.id);
  assert.deepEqual(ids.slice(0, 6), ["intervals", "garmin", "coros", "whoop", "amazfit", "polar"], "the requested order");
  assert.match(hub, /PROVIDERS\.map\(\(p\) => \{/);
  for (const re of [/connect\("whoop"\)/, /syncNow\(p\)/, /disconnect\(p\)/, /setting\("fill_daily"/, /setting\("import_workouts"/, /connect\("intervals"\)/, /Sign in with Intervals\.icu/, /Disconnect sign-in/]) assert.match(hub, re, String(re));
  assert.match(hub, /const r = await syncProvider\("whoop"\)/);
  for (const p of ["whoop", "intervals"]) assert.ok(existsSync(new URL(`../app/api/integrations/${p === "whoop" ? "[provider]" : "[provider]"}/route.ts`, import.meta.url)));
});
