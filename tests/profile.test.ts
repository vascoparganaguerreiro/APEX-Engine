import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ageFromBirth, buildProfilePatch, cmToFtIn, coachContext, draftFromProfile, formatPace, ftInToCm, hasNewColumns, kgToLb, lbToKg, loadProfile, measuredSource,
  parsePace, profileFromRow, saveProfile, sourceBadge, timezoneValid, type Db, type Profile, type ProfileDraft,
} from "../lib/profile.ts";

const NOW = "2026-11-12T09:00:00.000Z", TODAY = "2026-11-12";
const ROW = {
  id: "u1", display_name: "Ana", timezone: "Europe/Lisbon", units: "metric", weight_kg: "70.35", height_cm: "180.3", max_hr: 190, ftp_watts: 250, sleep_goal_h: "8.0",
  birth_date: "1990-06-15", body_fat_pct: null, preferred_sports: ["running"], primary_goal: null, goal_notes: null, resting_hr: 50, vo2max: null, lthr: null,
  threshold_pace_s_per_km: null, experience_level: null, field_sources: { resting_hr: { source: "manual", at: "2026-01-01T00:00:00Z" } }, created_at: "2025-01-01T00:00:00Z",
};
const base = (): Profile => profileFromRow(ROW, "u1");
const draft = (o: Partial<ProfileDraft> = {}, p: Profile = base()): ProfileDraft => ({ ...draftFromProfile(p), ...o });
const build = (o: Partial<ProfileDraft> = {}, p: Profile = base(), migrated = true) => buildProfilePatch(p, draft(o, p), NOW, TODAY, migrated);

// ------------------------------------------------------------------ loading and missing data
test("a profile row loads, and missing data stays missing (nothing is invented)", () => {
  const p = base();
  assert.deepEqual([p.display_name, p.weight_kg, p.height_cm, p.sleep_goal_h, p.resting_hr, p.vo2max, p.lthr], ["Ana", 70.35, 180.3, 8, 50, null, null]);
  const empty = profileFromRow(null, "u2", "Europe/Paris");
  assert.deepEqual([empty.display_name, empty.timezone, empty.units, empty.sleep_goal_h, empty.weight_kg, empty.max_hr, empty.resting_hr, empty.vo2max, empty.birth_date], [null, "Europe/Paris", "metric", 8, null, null, null, null, null]);
  assert.deepEqual(empty.preferred_sports, []);
  assert.deepEqual(empty.field_sources, {});
  const old = profileFromRow({ id: "u3", display_name: "Old", timezone: "UTC", units: "imperial", weight_kg: 80, height_cm: 170, max_hr: 180, ftp_watts: 200, sleep_goal_h: 7.5 }, "u3");
  assert.deepEqual([old.units, old.resting_hr, old.vo2max, old.field_sources, old.preferred_sports], ["imperial", null, null, {}, []], "a row from before the migration has no Profile-module values");
  assert.equal(hasNewColumns({ field_sources: {} }), true);
  assert.equal(hasNewColumns({ id: "x" }), false);
  assert.equal(hasNewColumns(null), false);
  assert.equal(profileFromRow({ ...ROW, units: "weird", field_sources: [1, 2], preferred_sports: "nope" }, "u1").units, "metric", "bad stored values fall back safely");
});

// ------------------------------------------------------------------ optional fields
test("every physiological field is optional, and clearing one removes it and its source", () => {
  const empty = profileFromRow(null, "u2");
  const r = buildProfilePatch(empty, draftFromProfile(empty), NOW, TODAY);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.patch, {}, "an untouched empty profile produces no changes and no errors");

  const cleared = build({ resting_hr: "" });
  assert.equal(cleared.error, undefined);
  assert.equal(cleared.patch.resting_hr, null);
  assert.deepEqual(cleared.patch.field_sources, {}, "no value, no provenance");
  assert.equal(build({ max_hr: "", ftp_watts: "", weight: "", height_cm: "" }).error, undefined);
  assert.equal(build({ birth_date: "" }).patch.birth_date, null);
});

// ------------------------------------------------------------------ updating and preserving existing fields
test("only changed fields are sent, so existing data is preserved", () => {
  const r = build({ display_name: "Ana Silva", resting_hr: "48" });
  assert.equal(r.error, undefined);
  assert.deepEqual(Object.keys(r.patch).sort(), ["display_name", "field_sources", "resting_hr"]);
  assert.deepEqual(r.patch.field_sources, { resting_hr: { source: "manual", at: NOW } });
  assert.deepEqual(build().patch, {}, "saving an unchanged form sends nothing");
  for (const k of ["weight_kg", "height_cm", "max_hr", "ftp_watts", "sleep_goal_h", "timezone", "units", "preferred_sports"]) assert.ok(!(k in r.patch), `${k} untouched`);
});

// ------------------------------------------------------------------ provenance
test("manual, lab, Garmin and Intervals values are told apart, and unknown origin is never guessed", () => {
  const p = base();
  assert.equal(sourceBadge(p, "resting_hr"), "Manual");
  assert.equal(sourceBadge(p, "max_hr"), "Source not recorded", "an existing value with no recorded source is not called manual");
  assert.equal(sourceBadge(p, "vo2max"), "", "no value, no badge");
  const lab = build({ vo2max: "55.5", sources: { vo2max: "lab" } });
  assert.deepEqual(lab.patch.field_sources, { resting_hr: { source: "manual", at: "2026-01-01T00:00:00Z" }, vo2max: { source: "lab", at: NOW } });
  const intervals = build({ resting_hr: "47", sources: { resting_hr: "intervals" } });
  assert.deepEqual((intervals.patch.field_sources as Record<string, unknown>).resting_hr, { source: "intervals", at: NOW });
  assert.equal(build({ sources: { max_hr: "lab" } }).patch.field_sources !== undefined, true, "a source can be recorded for an existing value without changing it");
  assert.equal("max_hr" in build({ sources: { max_hr: "lab" } }).patch, false);
  assert.equal(measuredSource("intervals", "manual"), "intervals");
  assert.equal(measuredSource("legacy_unknown", "garmin"), "garmin");
  assert.equal(measuredSource("legacy_unknown", "mystery"), "unknown");
  assert.equal(measuredSource(null, null), "unknown");
});

// ------------------------------------------------------------------ units
test("unit conversions round trip and an unchanged form never drifts", () => {
  assert.ok(Math.abs(kgToLb(lbToKg(155)) - 155) < 1e-9);
  assert.deepEqual(cmToFtIn(180.3), { ft: 5, inch: 11 });
  assert.ok(Math.abs(ftInToCm(5, 11) - 180.34) < 0.01);
  assert.deepEqual(cmToFtIn(182.8), { ft: 6, inch: 0 }, "11.99 in rolls over to the next foot");
  assert.equal(formatPace(275, "metric"), "4:35");
  assert.equal(formatPace(275, "imperial"), "7:23");
  assert.equal(parsePace("4:35", "metric"), 275);
  assert.equal(parsePace("7:23", "imperial"), 443 / 1.609344);
  for (const bad of ["4.35", "4:5", "abc", "0:00", "99:99"]) assert.equal(parsePace(bad, "metric"), "bad", bad);
  assert.equal(parsePace("", "metric"), null);

  const imp = draftFromProfile(base(), "imperial");
  assert.deepEqual([imp.height_ft, imp.height_in, imp.weight, imp.units], ["5", "11", "155.1", "imperial"]);
  const switched = buildProfilePatch(base(), imp, NOW, TODAY);
  assert.deepEqual(switched.patch, { units: "imperial" }, "only the preference changes: no rounding drift on weight or height");
});

test("imperial input is stored in metric", () => {
  const imp = draftFromProfile(base(), "imperial");
  const w = buildProfilePatch(base(), { ...imp, weight: "154.3" }, NOW, TODAY);
  assert.ok(Math.abs((w.patch.weight_kg as number) - 69.99) < 0.01);
  const h = buildProfilePatch(base(), { ...imp, height_ft: "6", height_in: "0" }, NOW, TODAY);
  assert.ok(Math.abs((h.patch.height_cm as number) - 182.9) < 0.1);
  const pace = buildProfilePatch(base(), { ...imp, threshold_pace: "7:23" }, NOW, TODAY);
  assert.equal(pace.patch.threshold_pace_s_per_km, Math.round(443 / 1.609344));
  const metricPace = build({ threshold_pace: "4:35" });
  assert.equal(metricPace.patch.threshold_pace_s_per_km, 275);
});

// ------------------------------------------------------------------ validation
test("validation rejects unrealistic or inconsistent values with a clear message", () => {
  const cases: Array<[Partial<ProfileDraft>, RegExp]> = [
    [{ height_cm: "30" }, /Height/], [{ height_cm: "abc" }, /Height/], [{ weight: "5" }, /Weight/], [{ body_fat: "70" }, /Body fat/],
    [{ resting_hr: "10" }, /Resting heart rate/], [{ resting_hr: "50.5" }, /whole/], [{ max_hr: "300" }, /Maximum heart rate/],
    [{ resting_hr: "120", max_hr: "110" }, /lower than maximum/], [{ lthr: "200" }, /cannot be above maximum/], [{ vo2max: "5" }, /VO2/],
    [{ threshold_pace: "4.35" }, /Threshold pace/], [{ threshold_pace: "0:30" }, /realistic/], [{ ftp_watts: "5000" }, /FTP/], [{ sleep_goal_h: "0" }, /Sleep goal/], [{ sleep_goal_h: "" }, /required/],
    [{ birth_date: "2030-01-01" }, /future/], [{ birth_date: "2024-01-01" }, /looks wrong/], [{ birth_date: "1990-02-30" }, /valid date/],
    [{ timezone: "Mars/Base" }, /time zone/], [{ units: "stone" as never }, /units/], [{ display_name: "x".repeat(61) }, /Display name/],
    [{ goal_notes: "x".repeat(501) }, /Goal notes/], [{ preferred_sports: ["chess"] }, /Preferred sports/], [{ preferred_sports: ["running", "running"] }, /Preferred sports/],
    [{ experience_level: "god" }, /experience/], [{ primary_goal: "world_peace" }, /goal/],
  ];
  for (const [over, re] of cases) { const r = build(over); assert.match(r.error ?? "", re, JSON.stringify(over)); assert.deepEqual(r.patch, {}, "an invalid form changes nothing"); }
  assert.equal(timezoneValid("Europe/Lisbon"), true);
  assert.equal(timezoneValid(" Europe/Lisbon"), false);
  assert.equal(ageFromBirth("1990-06-15", "2026-06-14"), 35);
  assert.equal(ageFromBirth("1990-06-15", "2026-06-15"), 36);
  assert.equal(ageFromBirth(null, TODAY), null);
  assert.equal(ageFromBirth("2030-01-01", TODAY), null);
});

// ------------------------------------------------------------------ data access: ownership and RLS assumptions (stand-in that applies RLS)
function fakeSupabase(migrated = true) {
  const rows: Array<Record<string, unknown>> = [{ ...ROW, id: "alice" }, { ...ROW, id: "bob", display_name: "Bob" }];
  const sent: Array<{ op: string; payload: Record<string, unknown> }> = [];
  const NEW = ["birth_date", "body_fat_pct", "preferred_sports", "primary_goal", "goal_notes", "resting_hr", "vo2max", "lthr", "threshold_pace_s_per_km", "experience_level", "field_sources"];
  const asUser = (uid: string): Db => ({
    from() {
      let op = "select"; let payload: Record<string, unknown> = {}; let cols = ""; const filters: Array<[string, unknown]> = [];
      const visible = () => rows.filter((r) => r.id === uid && filters.every(([c, v]) => r[c] === v));
      const run = async (): Promise<{ data: unknown; error: { message: string } | null }> => {
        if (!migrated && (NEW.some((k) => cols.includes(k)) || NEW.some((k) => k in payload))) return { data: null, error: { message: "column does not exist" } };
        if (op === "insert") {
          if (payload.id !== uid) return { data: null, error: { message: "new row violates row-level security policy" } };
          if (rows.some((r) => r.id === payload.id)) return { data: null, error: { message: "duplicate key" } };
          const row = { timezone: "Europe/Lisbon", units: "metric", sleep_goal_h: 8, created_at: "now", ...payload }; rows.push(row); return { data: row, error: null };
        }
        if (op === "update") { const hit = visible(); hit.forEach((r) => Object.assign(r, payload)); return { data: hit.map((r) => ({ id: r.id })), error: null }; }
        return { data: visible()[0] ?? null, error: null };
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {
        select(c?: string) { if (op === "select") cols = c ?? ""; return b; },
        insert(p: Record<string, unknown>) { op = "insert"; payload = p; sent.push({ op, payload }); return b; },
        update(p: Record<string, unknown>) { op = "update"; payload = p; sent.push({ op, payload }); return b; },
        eq(c: string, v: unknown) { filters.push([c, v]); return b; },
        single() { return run(); }, maybeSingle() { return run(); },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return run().then(res, rej); },
      };
      return b;
    },
  });
  return { asUser, rows, sent };
}

test("loading and updating a profile as its owner preserves every other field", async () => {
  const { asUser, rows } = fakeSupabase();
  const db = asUser("alice");
  const { profile, exists, migrated } = await loadProfile(db, "alice");
  assert.deepEqual([exists, migrated, profile.display_name, profile.max_hr], [true, true, "Ana", 190]);
  const r = buildProfilePatch(profile, draftFromProfile(profile), NOW, TODAY);
  const edited = buildProfilePatch(profile, { ...draftFromProfile(profile), display_name: "Ana S", vo2max: "52" }, NOW, TODAY);
  assert.deepEqual(r.patch, {});
  await saveProfile(db, "alice", edited.patch, exists);
  const row = rows.find((x) => x.id === "alice")!;
  assert.deepEqual([row.display_name, row.vo2max, row.weight_kg, row.height_cm, row.max_hr, row.ftp_watts, row.sleep_goal_h, row.timezone, row.created_at, row.resting_hr],
    ["Ana S", 52, "70.35", "180.3", 190, 250, "8.0", "Europe/Lisbon", "2025-01-01T00:00:00Z", 50]);
  assert.equal((await loadProfile(db, "alice")).profile.vo2max, 52);
});

test("a user without a profile row gets one created, and only for their own id", async () => {
  const { asUser, rows, sent } = fakeSupabase();
  const db = asUser("carol");
  const { profile, exists } = await loadProfile(db, "carol", "Europe/Paris");
  assert.deepEqual([exists, profile.timezone, profile.display_name], [false, "Europe/Paris", null]);
  const patch = buildProfilePatch(profile, { ...draftFromProfile(profile), display_name: "Carol" }, NOW, TODAY).patch;
  await saveProfile(db, "carol", patch, exists);
  assert.deepEqual([rows.find((r) => r.id === "carol")!.display_name, sent.at(-1)!.payload.id], ["Carol", "carol"]);
  await assert.rejects(saveProfile(asUser("mallory"), "carol", { display_name: "hacked" }, false), /row-level security/, "cannot create a row for someone else");
});

test("users cannot read or change each other's profiles", async () => {
  const { asUser, rows, sent } = fakeSupabase();
  const alice = asUser("alice");
  assert.equal((await loadProfile(alice, "bob")).exists, false, "bob's row is invisible to alice");
  await assert.rejects(saveProfile(alice, "bob", { display_name: "hacked" }, true), /not found/i);
  assert.equal(rows.find((r) => r.id === "bob")!.display_name, "Bob");
  await saveProfile(alice, "alice", { id: "bob", created_at: "x", display_name: "Mine", not_a_column: 1 }, true);
  const update = sent.filter((s) => s.op === "update").at(-1)!.payload;
  assert.deepEqual(Object.keys(update), ["display_name"], "only known columns are written: never id, created_at or anything else");
  await saveProfile(alice, "alice", {}, true);
  assert.equal(sent.filter((s) => s.op === "update").length, 2, "an empty patch makes no request at all");
});

test("before migration 11 the profile still loads and saves the original fields", async () => {
  const { asUser } = fakeSupabase(false);
  const db = asUser("alice");
  const { profile, migrated } = await loadProfile(db, "alice");
  assert.equal(migrated, false);
  assert.equal(profile.display_name, "Ana");
  const blocked = buildProfilePatch(profile, { ...draftFromProfile(profile), resting_hr: "47" }, NOW, TODAY, false);
  assert.match(blocked.error ?? "", /migration 11/);
  const fine = buildProfilePatch(profile, { ...draftFromProfile(profile), display_name: "Ana Z", max_hr: "192" }, NOW, TODAY, false);
  assert.equal(fine.error, undefined);
  assert.deepEqual(Object.keys(fine.patch).sort(), ["display_name", "max_hr"]);
});

// ------------------------------------------------------------------ what other modules may use
test("context for Today, Race Hub and a future AI coach: explicit values with provenance, no identity, no estimates", () => {
  const ctx = coachContext(base(), TODAY);
  assert.equal(ctx.age, 36);
  assert.deepEqual(ctx.baselines.resting_hr, { value: 50, unit: "bpm", source: "manual" });
  assert.deepEqual(ctx.baselines.max_hr, { value: 190, unit: "bpm", source: "not_recorded" });
  assert.ok(!("vo2max" in ctx.baselines) && !("lthr" in ctx.baselines), "missing values are omitted, not filled in");
  assert.ok(!JSON.stringify(ctx).match(/Ana|1990-06-15|@|u1/), "no name, date of birth, email or id");
  const none = coachContext(profileFromRow(null, "u2"), TODAY);
  assert.deepEqual([none.age, none.baselines, none.primary_goal], [null, {}, null]);
  assert.ok(!("max_hr" in none.baselines), "max heart rate is never estimated from age");
});

// ------------------------------------------------------------------ static checks: migration, privacy, wiring
const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(root, p), "utf8");

test("migration 11 is additive, keeps data, RLS and grants, and does not duplicate daily data", () => {
  const sql = read("11_profile.sql").replace(/--.*$/gm, "").toLowerCase();
  for (const c of ["birth_date", "body_fat_pct", "preferred_sports", "primary_goal", "goal_notes", "resting_hr", "vo2max", "lthr", "threshold_pace_s_per_km", "experience_level", "field_sources"]) {
    assert.match(sql, new RegExp(`add column if not exists ${c}\\b`));
  }
  assert.ok(!/drop table|drop column|truncate|delete from|alter column/.test(sql), "no destructive change");
  assert.ok(!/create policy|drop policy|enable row level|disable row level|grant |revoke /.test(sql), "RLS and grants stay as they are");
  assert.ok(!/update public\.profiles/.test(sql), "existing rows are not rewritten: no provenance is invented");
  assert.ok(!/daily_metrics|activities/.test(sql), "daily measurements are not duplicated into the profile");
  assert.match(sql, /field_sources\s+jsonb not null default '\{\}'::jsonb/);
  assert.match(sql, /jsonb_typeof\(field_sources\) = 'object'/);
});

test("the profile page and its integrations never touch credentials, and imported values are never applied silently", () => {
  const page = read("app/(app)/profile/page.tsx"), lib = read("lib/profile.ts");
  for (const src of [page, lib]) assert.ok(!/api_key|apiKey|api_key_enc|intervals_credentials|SERVICE_ROLE/i.test(src), "no credential column or secret is referenced");
  assert.match(lib, /from\("intervals_connections"\)\.select\("athlete_id,last_sync_at"\)/, "only non-secret connection columns");
  assert.match(page, /window\.confirm\(`Replace your current/, "replacing an existing baseline with a measured value needs confirmation");
  assert.match(page, /Use as baseline/);
  for (const f of ["app/api/intervals/sync/route.ts", "app/api/intervals/connect/route.ts", "lib/intervals.ts", "lib/provenance.ts"]) {
    assert.ok(!/from\("profiles"\)|profiles/.test(read(f).replace(/\/\/.*$/gm, "")), `${f} must never write to profiles`);
  }
  const walk = (dir: string): string[] => (readdirSync(join(root, dir), { recursive: true }) as string[]).map((f) => `${dir}/${f.replace(/\\/g, "/")}`).filter((f) => /\.tsx?$/.test(f));
  assert.ok(!walk("app/api").some((f) => /from\("profiles"\)\.(insert|update|upsert)/.test(read(f))), "no server route writes profiles");
});

test("navigation and cross-module wiring", () => {
  assert.match(read("app/(app)/layout.tsx"), /\{ href: "\/profile", label: "Profile" \}/);
  assert.ok(!/href: "\/profile", label: "Profile", soon/.test(read("app/(app)/layout.tsx")));
  // Today (redesigned) reads the name, time zone and sleep goal through its loader.
  assert.match(read("lib/today/load.ts"), /from\("profiles"\)\.select\("display_name,timezone,sleep_goal_h"\)/);
  assert.match(read("app/(app)/today/page.tsx"), /loadProfileLite\(\)/);
  assert.match(read("app/(app)/races/page.tsx"), /select\("units"\)/);
  assert.match(read("components/races/RaceForm.tsx"), /initial\?\.distance_unit \?\? defaultUnit \?\? "km"/);
});