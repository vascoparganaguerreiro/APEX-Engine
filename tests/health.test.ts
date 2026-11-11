import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeOn, adherence, buildTimeline, change, dueOn, fetchAll, isoWeekday, normalizeMarker, observations, parseExtraction, rangeStatus, sameRange,
  splitByUnit, supplementEvents, validatePanelDate, validateResult, validateSchedule, validateSupplement,
  type Panel, type Result, type ResultPoint, type Schedule, type Supplement,
} from "../lib/health/core.ts";

const sup = (o: Partial<Supplement> = {}): Supplement => ({
  id: "a", name: "Magnesium", brand: null, ingredients: null, formulation: "capsule", dose: null, dose_unit: null, notes: null,
  start_date: "2026-01-01", end_date: null, status: "active", discontinuation_reason: null, ...o,
});
const sch = (o: Partial<Schedule> = {}): Schedule => ({ supplement_id: "a", slot: "morning", dose: 200, dose_unit: "mg", days: [1, 2, 3, 4, 5, 6, 7], valid_from: "2026-01-01", valid_to: null, ...o });
const pt = (o: Partial<ResultPoint>): ResultPoint => ({
  id: String(Math.random()), panel_id: "p", original_name: "Ferritin", marker_key: "ferritin", value: 30, unit: "ng/mL", ref_low: 30, ref_high: 400,
  flag: null, source: "manual", collected_on: "2026-01-01", lab_name: "Lab", ...o,
});

// ------------------------------------------------------------------ supplements
test("create/edit/discontinue validation", () => {
  assert.equal(validateSupplement(sup()), null);
  assert.ok(validateSupplement(sup({ name: " " })));
  assert.ok(validateSupplement(sup({ dose: -1 })));
  assert.ok(validateSupplement(sup({ end_date: "2025-12-31" })), "end before start");
  assert.ok(validateSupplement(sup({ status: "discontinued" })), "discontinued needs an end date");
  assert.equal(validateSupplement(sup({ status: "discontinued", end_date: "2026-03-01", discontinuation_reason: "finished" })), null);
});

test("different morning, lunch and dinner doses are validated independently", () => {
  assert.equal(validateSchedule([{ slot: "morning", dose: 200, dose_unit: "mg", days: [1, 2] }, { slot: "dinner", dose: 1000, dose_unit: "IU", days: [1] }]), null);
  assert.ok(validateSchedule([{ slot: "lunch", dose: 0, dose_unit: "mg", days: [1] }]));
  assert.ok(validateSchedule([{ slot: "lunch", dose: 5, dose_unit: "mg", days: [] }]));
  assert.ok(validateSchedule([{ slot: "lunch", dose: 5, dose_unit: "stone", days: [1] }]));
  assert.ok(validateSchedule([{ slot: "lunch", dose: 5, dose_unit: "mg", days: [1] }, { slot: "lunch", dose: 5, dose_unit: "mg", days: [1] }]));
});

test("doses due follow weekdays, schedule versions and the supplement's active period", () => {
  assert.equal(isoWeekday("2026-11-09"), 1);
  const s = [sup({ end_date: "2026-12-31" })];
  const weekly = [sch({ days: [1, 3, 5] })];
  assert.equal(dueOn("2026-11-09", s, weekly).length, 1);   // Monday
  assert.equal(dueOn("2026-11-10", s, weekly).length, 0);   // Tuesday
  const v = [sch({ dose: 200, valid_to: "2026-06-30" }), sch({ dose: 400, valid_from: "2026-07-01" })];
  assert.equal(dueOn("2026-06-30", s, v)[0].dose, 200);      // history keeps the old dose
  assert.equal(dueOn("2026-07-01", s, v)[0].dose, 400);
  assert.equal(dueOn("2027-01-01", s, v).length, 0);         // after it was stopped
  assert.equal(activeOn(sup({ end_date: "2026-03-01" }), "2026-03-02"), false);
});

test("taken / skipped / not yet taken and adherence history", () => {
  const s = [sup({ start_date: "2026-11-01" })], c = [sch({ valid_from: "2026-11-01" })];
  const a = adherence("a", s, c, [
    { supplement_id: "a", slot: "morning", day: "2026-11-01", status: "taken" },
    { supplement_id: "a", slot: "morning", day: "2026-11-02", status: "skipped" },
  ], "2026-11-01", "2026-11-04");
  assert.deepEqual([a.expected, a.taken, a.skipped, a.missed], [3, 1, 1, 1]);   // today (11-04) is still pending, not "missed"
  assert.equal(a.rate, 1 / 3);
  assert.equal(adherence("a", [sup({ id: "b" })], [], [], "2026-11-01", "2026-11-04").rate, null);
});

test("discontinued supplements keep their history and show as events", () => {
  const ev = supplementEvents([sup({ status: "discontinued", end_date: "2026-03-01" })], [sch(), sch({ valid_from: "2026-02-01" })]);
  assert.deepEqual(ev.map((e) => e.type), ["start", "schedule", "stop"]);
});

// ------------------------------------------------------------------ biomarkers
test("marker names are matched only when confident (English and Portuguese)", () => {
  assert.equal(normalizeMarker("Colesterol Total")?.key, "cholesterol_total");
  assert.equal(normalizeMarker("FERRITINA")?.key, "ferritin");
  assert.equal(normalizeMarker("Hemoglobina glicada")?.key, "hba1c");
  assert.equal(normalizeMarker("25-OH Vitamin D")?.key, "vitamin_d_25oh");
  assert.equal(normalizeMarker("Vitamin D"), null, "ambiguous names stay unmatched");
  assert.equal(normalizeMarker("Something unusual"), null);
});

test("range status uses the result's own laboratory range and never invents one", () => {
  assert.equal(rangeStatus(5, 10, 20), "below");
  assert.equal(rangeStatus(15, 10, 20), "within");
  assert.equal(rangeStatus(25, 10, 20), "above");
  assert.equal(rangeStatus(25, null, 20), "above");
  assert.equal(rangeStatus(5, 10, null), "below");
  assert.equal(rangeStatus(5, null, null), "unknown");
});

test("incompatible units are never combined into one chart series", () => {
  const s = splitByUnit([
    pt({ unit: "mg/dL", collected_on: "2026-01-01" }), pt({ unit: "mmol/L", collected_on: "2026-02-01" }),
    pt({ unit: "mg/dL", collected_on: "2026-03-01" }), pt({ unit: "µg/L" }), pt({ unit: "ug/L" }),
  ]);
  assert.equal(s.length, 3);
  assert.deepEqual(s[0].points.map((p) => p.collected_on), ["2026-01-01", "2026-03-01"]);
  assert.equal(s.find((x) => x.key === "ug/l")!.points.length, 2);
  assert.equal(sameRange(pt({ ref_low: 1, ref_high: 2 }), pt({ ref_low: 1, ref_high: 3 })), false);
  assert.deepEqual(change(30, 45), { abs: 15, pct: 50 });
  assert.equal(change(0, 5).pct, null);
});

test("observations describe timing only: no causal claims, no advice", () => {
  const series = splitByUnit([pt({ value: 30, collected_on: "2026-01-01" }), pt({ value: 45, collected_on: "2026-06-01" })])[0];
  const started = observations(series, [sup({ name: "Vitamin D3", start_date: "2026-02-01" })]);
  assert.equal(started.length, 1);
  assert.match(started[0], /higher/); assert.match(started[0], /started Vitamin D3 in between/);
  assert.match(observations(series, [sup({ start_date: "2025-12-01" })])[0], /taking Magnesium at both tests/);
  assert.match(observations(series, [])[0], /no supplements were recorded/);
  for (const t of [...started, ...observations(series, [sup()])]) assert.ok(!/caus|because|due to|should|recommend|improv|worsen/i.test(t), t);
  assert.deepEqual(observations(splitByUnit([pt({})])[0], []), [], "one measurement is not enough");
});

test("manual result validation", () => {
  const ok = { original_name: "Ferritin", value: 40, unit: "ng/mL", ref_low: 30, ref_high: 400 };
  assert.equal(validateResult(ok), null);
  assert.ok(validateResult({ ...ok, value: NaN }));
  assert.ok(validateResult({ ...ok, unit: " " }));
  assert.ok(validateResult({ ...ok, original_name: "" }));
  assert.ok(validateResult({ ...ok, ref_low: 500 }));
  assert.equal(validatePanelDate("2026-05-01", "2026-11-11"), null);
  assert.ok(validatePanelDate("2027-05-01", "2026-11-11"));
  assert.ok(validatePanelDate("2026-02-30", "2026-11-11"));
});

// ------------------------------------------------------------------ extraction safety
test("extraction keeps only plain numbers with units and reports what it skipped", () => {
  const x = parseExtraction({
    collected_on: "2026-05-01", lab_name: " Lab Central ",
    results: [
      { name: "Ferritina", value: "45,2", unit: "ng/mL", ref_low: 30, ref_high: 400, flag: "H" },
      { name: "CRP", value: "<0.5", unit: "mg/L" },
      { name: "TSH", value: 2.1, unit: null },
      { name: "Ferritina", value: 50, unit: "ng/mL" },
      { name: "Glucose", value: 90, unit: "mg/dL", ref_low: 100, ref_high: 70 },
      { value: 3, unit: "x" },
    ],
  }, "2026-11-11");
  assert.equal(x.collected_on, "2026-05-01"); assert.equal(x.lab_name, "Lab Central");
  assert.deepEqual(x.results.map((r) => [r.original_name, r.value, r.marker_key]), [["Ferritina", 45.2, "ferritin"], ["Glucose", 90, "glucose"]]);
  assert.equal(x.results[0].flag, "H");
  assert.deepEqual([x.results[1].ref_low, x.results[1].ref_high], [null, null], "an impossible range is dropped, not repaired");
  assert.equal(x.skipped.length, 3);
  assert.equal(parseExtraction({ collected_on: "2999-01-01", results: [] }, "2026-11-11").collected_on, null);
  assert.deepEqual(parseExtraction("garbage", "2026-11-11").results, []);
});

// ------------------------------------------------------------------ timeline
test("unified timeline merges tests and supplement events, newest first", () => {
  const panels: Panel[] = [{ id: "p", collected_on: "2026-05-01", lab_name: "Lab", notes: null, source: "manual", report_path: null, report_filename: null }];
  const results: Result[] = [pt({ panel_id: "p", value: 10, ref_low: 30, ref_high: 400 }), pt({ panel_id: "p", value: 100 })];
  const items = buildTimeline(panels, results, [sup({ status: "discontinued", end_date: "2026-07-01" })], [sch()]);
  assert.deepEqual(items.map((i) => i.kind), ["stop", "panel", "start"]);
  assert.match(items[1].detail, /2 results, 1 outside the laboratory range/);
});

// ------------------------------------------------------------------ static security checks (SQL and source)
const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(root, p), "utf8");
const sql = read("08_supplements_biomarkers.sql").replace(/--.*$/gm, "").toLowerCase();
const TABLES = ["supplements", "supplement_revisions", "supplement_schedules", "supplement_intakes", "blood_panels", "biomarker_results"];

test("every new table has RLS, a user-scoped policy and no anonymous access", () => {
  for (const t of TABLES) {
    assert.match(sql, new RegExp(`alter table public\\.${t}\\s+enable row level security`), `${t}: RLS`);
    assert.match(sql, new RegExp(`create policy "[^"]+" on public\\.${t} for [a-z]+ to authenticated`), `${t}: policy`);
    assert.match(sql, new RegExp(`${t}\\s+(\\(|\\n)`), `${t}: exists`);
  }
  assert.ok(!/grant[^;]*\banon\b/.test(sql), "nothing is granted to anon");
  assert.match(sql, /revoke all on public\.supplements[^;]*from public, anon/);
  assert.ok((sql.match(/user_id = auth\.uid\(\)/g) ?? []).length >= TABLES.length);
  assert.ok(!/security definer/.test(sql), "functions run as the caller so RLS always applies");
});

test("lab reports bucket is private and folder-scoped to the owner", () => {
  assert.match(sql, /values \('lab-reports', 'lab-reports', false/);
  const policies = sql.match(/create policy "lab reports[^;]*;/g) ?? [];
  assert.equal(policies.length, 3);
  for (const p of policies) assert.match(p, /bucket_id = 'lab-reports' and \(storage\.foldername\(name\)\)\[1\] = auth\.uid\(\)::text/);
});

test("report extraction is authenticated first, server-side, and never exposes the AI key", () => {
  const route = read("app/api/biomarkers/extract/route.ts");
  assert.ok(route.indexOf("authUser(req)") > 0 && route.indexOf("authUser(req)") < route.indexOf("req.formData"));
  assert.ok(!/console\./.test(route), "report contents are never logged");
  const walk = (dir: string): string[] => (readdirSync(join(root, dir), { recursive: true }) as string[]).map((f) => `${dir}/${f.replace(/\\/g, "/")}`).filter((f) => /\.tsx?$/.test(f));
  for (const f of [...walk("app"), ...walk("components")].filter((f) => !f.includes("/api/"))) {
    assert.ok(!/GEMINI_API_KEY/.test(read(f)), `${f}: AI key must stay on the server`);
  }
});

test("fetchAll returns every row in order, even when the server caps each response", async () => {
  const data = Array.from({ length: 1234 }, (_, i) => i);
  const calls: Array<[number, number]> = [];
  const serverCap = 500;
  const page = async (from: number, to: number) => {
    calls.push([from, to]);
    return { rows: data.slice(from, Math.min(to + 1, from + serverCap)), total: calls.length === 1 ? data.length : null };
  };
  const all = await fetchAll(page, 1000);
  assert.deepEqual(all, data);
  assert.deepEqual(calls[0], [0, 999]);
  assert.equal(calls[1][0], 500, "continues from where the capped page ended, never skipping rows");
  assert.deepEqual(await fetchAll(async () => ({ rows: [], total: 0 })), []);
  await assert.rejects(fetchAll(async () => ({ rows: [1], total: 999_999 }), 1000, 100));
  await assert.rejects(fetchAll(async (from) => ({ rows: from === 0 ? [1, 2] : [], total: 5 })), /Could not load all/);
});

test("migration 08 corrections: grants, revision policy, function name, report path, effective date", () => {
  const body = (re: RegExp) => (sql.match(re) ?? [""])[0];
  assert.match(sql, /revoke all on public\.supplements[^;]*from public, anon, authenticated;/);
  assert.match(sql, /grant select, insert, update, delete on public\.supplements[^;]*to authenticated;/);
  assert.match(sql, /grant select, insert on public\.supplement_revisions to authenticated;/);
  assert.match(body(/create policy "own revisions insert"[^;]*;/), /exists \(select 1 from public\.supplements s where s\.id = supplement_id and s\.user_id = auth\.uid\(\)\)/);
  assert.ok(!/[^_]touch_updated_at/.test(sql), "the shared touch_updated_at name must not be used");
  assert.equal((sql.match(/public\.health_touch_updated_at/g) ?? []).length, 4);
  assert.match(sql, /constraint blood_panels_report_path_own_folder check \(\s*report_path is null or \(left\(report_path, 37\) = user_id::text \|\| '\/'/);
  const fn = body(/create or replace function public\.replace_supplement_schedule[\s\S]*?end \$\$;/);
  assert.match(fn, /p_effective date/);
  assert.match(fn, /p_effective is null or abs\(p_effective - current_date\) > 1/);
  assert.ok(!/valid_from >= current_date|valid_to = current_date|, current_date\s*\n/.test(fn), "schedule dates come from p_effective, not the server date");
  assert.match(sql, /grant execute on function public\.replace_supplement_schedule\(uuid, jsonb, date\) to authenticated/);
  const app = readFileSync(join(root, "app/(app)/supplements/page.tsx"), "utf8");
  assert.match(app, /p_effective: today/);
});