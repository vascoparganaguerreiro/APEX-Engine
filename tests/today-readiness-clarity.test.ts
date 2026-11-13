// Readiness clarity on Today: the metric is named as the APEX estimate, explained as different from Garmin Training Readiness,
// and shows inputs freshness plus the last Intervals.icu sync. Display only: no calculation, sync or database behaviour changes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { READINESS_EXPLAINER, readinessFreshnessLine } from "../lib/today/format.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("explainer text is exact and the freshness line reuses current/partial/stale", () => {
  assert.equal(READINESS_EXPLAINER, "Calculated by APEX from HRV, resting heart rate and sleep. It is different from Garmin Training Readiness.");
  const l = readinessFreshnessLine("partial", "2026-11-13T08:15:00Z");
  assert.match(l, /^Inputs: Partly today\. Last Intervals\.icu sync: .*2026.*\.$/);
  assert.match(readinessFreshnessLine("stale", null), /Inputs: Older\. Last Intervals\.icu sync: not recorded\./);
  assert.match(readinessFreshnessLine("current", "garbage"), /not recorded/);
});

test("Wellness card names the estimate and passes the stored sync time; nothing is called Garmin readiness", () => {
  const mod = read("components/today/Modules.tsx"), page = read("app/(app)/today/page.tsx"), load = read("lib/today/load.ts");
  assert.match(mod, /APEX Readiness Estimate\{/); assert.match(mod, /READINESS_EXPLAINER/); assert.match(mod, /readinessFreshnessLine\(w\.state, lastSyncAt\)/);
  assert.match(page, /lastSyncAt=\{lastSyncAt\}/); assert.match(page, /loadIntervalsLastSync\(\)\.then\(setLastSyncAt\)/);
  assert.match(load, /from\("intervals_connections"\)\.select\("last_sync_at"\)/);
  assert.doesNotMatch(read("lib/integrations/normalize.ts"), /label: "Garmin Training Readiness/);
  assert.doesNotMatch(mod + page, /intervals\.readiness/);
});

test("no automatic sync was added to Today", () => {
  assert.doesNotMatch(read("app/(app)/today/page.tsx"), /syncIntervals|api\/intervals\/sync/);
});
