// Staging-readiness checks: complete paged reads, source preservation, count-once wiring, honest export labelling, migration hardening.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkouts, pageAll, type Db } from "../lib/strength/data.ts";
import { buildPayload, buildPreview, parseHevy } from "../lib/strength/hevy.ts";
import { CATALOG, catalogExercise } from "../lib/strength/library.ts";
import { MemoryStore, SyncEngine, adoptInto, diffInto, emptySync, hasPending } from "../lib/strength/sync.ts";
import { addExercise, addSet, startWorkout, updateSet, type Workout } from "../lib/strength/workout.ts";
import { fitSnapshot, snapshotOf, validateSnapshot } from "../lib/strength/actions.ts";
import { FIT_ADAPTER, GARMIN_CONNECT_ADAPTER } from "../lib/strength/garmin/adapters.ts";
import { FakeStrengthServer, T0, clock, ex, transportFor, uid } from "./strength-fixtures.ts";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

/** A chainable PostgREST look-alike that serves `rows` in the requested order and range, capped like Supabase (max_rows 1000). */
function fakeDb(rows: Array<Record<string, unknown>>, log: string[] = []): Db {
  const q = (filters: Array<(r: Record<string, unknown>) => boolean>, range: [number, number] | null): Record<string, unknown> => {
    const self: Record<string, unknown> = {
      select: (s: string) => { log.push(`select:${s.slice(0, 40)}`); return self; },
      is: (c: string, v: unknown) => q([...filters, (r) => (r[c] ?? null) === v], range),
      eq: (c: string, v: unknown) => q([...filters, (r) => r[c] === v], range),
      gte: (c: string, v: string) => q([...filters, (r) => String(r[c]) >= v], range),
      in: (c: string) => { log.push(`in:${c}`); return q(filters, range); },
      order: (c: string) => { log.push(`order:${c}`); return self; },
      range: (a: number, b: number) => { log.push(`range:${a}-${b}`); return q(filters, [a, b]); },
      then: (res: (v: unknown) => void) => {
        const all = rows.filter((r) => filters.every((f) => f(r))).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
        const [a, b] = range ?? [0, all.length - 1];
        res({ data: all.slice(a, Math.min(b + 1, a + 1000)), error: null });
      },
    };
    return self;
  };
  return { from: () => q([], null), rpc: async () => ({ data: null, error: null }) } as unknown as Db;
}
const session = (i: number) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, title: `W${i}`, status: "completed", deleted_at: null, started_at: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString(), ended_at: null, paused_seconds: 0, source: "hevy_csv", strength_session_exercises: [] });

test("history is read completely and in order, past the 1000-row response cap", async () => {
  const rows = Array.from({ length: 1234 }, (_, i) => session(i));
  const log: string[] = [];
  const w = await loadWorkouts(fakeDb(rows, log), { resolve: catalogExercise });
  assert.equal(w.length, 1234, "every finished workout, not a silently truncated list");
  assert.equal(w[0].title, "W1233", "newest first");
  assert.ok(log.includes("order:started_at") && log.includes("range:0-199") && log.includes("range:1200-1399"));
  const keyed: string[] = [];
  await loadWorkouts(fakeDb(rows, keyed), { keys: ["back_squat"], max: 300, resolve: catalogExercise });
  assert.ok(keyed.some((l) => l.startsWith("select:") && l.includes("id,title")) && keyed.includes("in:strength_session_exercises.exercise_key"));
  assert.equal(keyed.filter((l) => l.startsWith("range:")).length, 2, "keyed history is capped (300) for the assistant");
  let calls = 0;
  const two = await pageAll(async (a, b) => { calls++; return { data: Array.from({ length: Math.max(0, Math.min(b, 4) - a + 1) }, (_, i) => a + i), error: null }; }, { size: 3 });
  assert.deepEqual([two, calls], [[0, 1, 2, 3, 4], 2]);
});

test("Hevy import never overwrites or resurrects: imported, deleted-after-import, and APEX overlaps", () => {
  const csv = ["title,start_time,end_time,exercise_title,set_index,set_type,weight_kg,reps", "A,26 Mar 2024 07:00,26 Mar 2024 08:00,Squat (Barbell),0,normal,100,5", "B,27 Mar 2024 07:00,27 Mar 2024 08:00,Squat (Barbell),0,normal,100,5", "C,28 Mar 2024 07:00,28 Mar 2024 08:00,Squat (Barbell),0,normal,100,5"].join("\n");
  const p = parseHevy(csv, "UTC");
  const existing = [
    { id: "1", source: "hevy_csv", sourceRef: p.workouts[0].ref, startedAt: "", endedAt: null, title: "A", deleted: false },
    { id: "2", source: "hevy_csv", sourceRef: p.workouts[1].ref, startedAt: "", endedAt: null, title: "B", deleted: true },
    { id: "3", source: "apex", sourceRef: null, startedAt: "2024-03-28T07:05:00.000Z", endedAt: "2024-03-28T07:55:00.000Z", title: "deleted APEX log", deleted: true },
  ];
  const pv = buildPreview(p, existing, CATALOG);
  assert.deepEqual(pv.workouts.map((w) => [w.status, w.include]), [["already_imported", false], ["deleted_before", false], ["new", true]], "a deleted APEX log is not an overlap");
  pv.workouts.forEach((w) => { w.include = true; });                       // even if the UI were bypassed
  const payload = buildPayload(pv, {}, CATALOG, { dumbbellWeights: "per_hand" }).flat();
  assert.deepEqual(payload.map((s) => s.title), ["C"], "imported and deleted-after-import workouts are never sent again");
  const sql = read("13_strength.sql");
  assert.match(sql, /on conflict \(user_id, source, source_ref\) where source_ref is not null do nothing/);
  const fnImport = sql.slice(sql.indexOf("function public.import_strength_sessions"), sql.indexOf("function public.merge_training_sources"));
  assert.ok(!/\bupdate\b|\bdelete\b/i.test(fnImport.replace(/--.*$/gm, "")), "the import function only inserts");
  const fnMerge = sql.slice(sql.indexOf("function public.merge_training_sources"), sql.indexOf("revoke all on function public.save_strength_routine"));
  assert.ok(!/(update|delete from|insert into) public\.(activities|strength_sessions|strength_sets|strength_session_exercises)/i.test(fnMerge), "merge/unmerge never touch source records");
});

function benchWorkout(): Workout {
  let w = startWorkout({ id: uid(), now: T0, newId: uid, defaultUnit: "kg" });
  w = addExercise(w, ex("barbell_bench_press"), { id: uid(), unit: "kg", setId: uid() });
  return updateSet(w, w.exercises[0].id, w.exercises[0].sets[0].id, { weight: 80, reps: 8 });
}
test("device copies: the server copy wins unless local changes are still waiting; synced workouts are pruned", async () => {
  const w: Workout = { ...benchWorkout(), status: "completed", endedAt: "2026-11-10T09:00:00.000Z" };
  const s1 = diffInto(emptySync(), w, { nowMs: 1, newOpId: uid, inflight: new Set() });
  assert.ok(hasPending(s1, w.id));
  const remote = updateSet(w, w.exercises[0].id, w.exercises[0].sets[0].id, { reps: 10 });     // edited on another device
  assert.equal(adoptInto(s1, remote), s1, "pending local changes are not overwritten");
  const clean = { ...s1, queue: [] };
  const adopted = adoptInto(clean, remote);
  assert.match(adopted.known[`set:${w.exercises[0].sets[0].id}`].json, /"reps":10/, "bookkeeping now matches the server");
  const server = new FakeStrengthServer(), store = new MemoryStore();
  const engine = new SyncEngine(store, transportFor(server), clock());
  await engine.load();
  await engine.record(w, { active: false });
  assert.equal(engine.pendingWorkouts().length, 1);
  assert.equal((await engine.adopt(remote)).exercises[0].sets[0].reps, 8, "unsent local copy is kept for editing");
  await engine.flush();
  assert.equal(engine.pendingWorkouts().length, 0, "nothing is listed as waiting once uploaded");
  assert.equal((await engine.adopt(remote)).exercises[0].sets[0].reps, 10, "after upload, a newer server copy is used");
  await engine.prune();
  assert.equal(Object.keys(engine.local.workouts).length, 0, "fully synced finished workouts are removed from the device");
});

test("Ask APEX payload stays under the route's 64 KB limit and keeps the current exercise whole", () => {
  let w = startWorkout({ id: uid(), now: T0, newId: uid, defaultUnit: "kg" });
  for (let i = 0; i < 30; i++) {
    w = addExercise(w, ex(CATALOG[i].key), { id: uid(), unit: "kg", setId: uid(), notes: "x".repeat(300) });
    for (let k = 0; k < 29; k++) w = addSet(w, w.exercises[i].id, uid());
  }
  const cur = w.exercises[3].id;
  const full = snapshotOf(w, { elapsedMin: 60, equipment: [], objective: "o".repeat(300), currentId: cur });
  assert.ok(JSON.stringify(full).length > 64_000, "an extreme workout really is too large");
  const fit = fitSnapshot(full);
  assert.ok(new TextEncoder().encode(JSON.stringify(fit)).length <= 40_000);
  assert.equal(fit.exercises.find((e) => e.id === cur)!.sets.length, 30);
  assert.ok(validateSnapshot(JSON.parse(JSON.stringify(fit))).ok);
  const small = snapshotOf(benchWorkout(), { elapsedMin: 5, equipment: [], objective: "", currentId: null });
  assert.equal(fitSnapshot(small), small, "normal workouts are sent unchanged");
});

test("count once: every place that totals activities ignores merged duplicate copies", () => {
  for (const f of ["lib/today/load.ts", "lib/coach/store.ts", "app/api/summarize/route.ts", "app/(app)/activities/page.tsx"]) {
    const src = read(f);
    assert.match(src, /loadExcludedActivityIds\(/, `${f} excludes merged duplicates`);
    assert.match(src, /loadLinksOrNone\(/, `${f} keeps working before migration 13`);
  }
});

test("the general Coach no longer offers a strength switch it does not use; Ask APEX has its own consent", () => {
  const c = read("components/coach/consent.tsx");
  assert.match(read("lib/coach/consentStore.ts"), /COACH_CATEGORIES = CATEGORIES\.filter\(\(c\) => c !== "strength"\)/);   // consent storage moved to lib (Task 7B.2)
  assert.match(c, /COACH_CATEGORIES\.map/, "the panel offers only the Coach categories");
  assert.ok(!/\{CATEGORIES\.map/.test(c));
  assert.match(read("components/strength/AskApex.tsx"), /Share this workout and my strength history with the AI/);
});

test("migration 13 hardening: FK indexes, pinned search_path, bounded import", () => {
  const sql = read("13_strength.sql");
  for (const idx of ["strength_sessions_routine_idx", "strength_routine_exercises_custom_idx", "strength_session_exercises_custom_idx", "training_session_links_user_idx", "training_merge_decisions_session_idx"]) assert.match(sql, new RegExp(`create index if not exists ${idx} `));
  assert.match(sql, /function public\.strength_touch_updated_at\(\) returns trigger language plpgsql set search_path = public/);
  assert.equal((sql.match(/create or replace function/g) ?? []).length, (sql.match(/set search_path = public/g) ?? []).length, "every function pins its search_path");
  assert.match(sql, /too many exercises in one workout/);
  assert.match(sql, /too many sets in one exercise/);
});

test("Forerunner 965 export is labelled experimental and nothing claims a watch sync", () => {
  assert.equal(FIT_ADAPTER.status, "experimental");
  assert.match(FIT_ADAPTER.instructions, /Experimental, not yet confirmed on a Forerunner 965/);
  assert.equal(GARMIN_CONNECT_ADAPTER.status, "requires_approval");
  const walk = (dir: string): string[] => (readdirSync(join(root, dir), { recursive: true }) as string[]).map((f) => `${dir}/${String(f).replace(/\\/g, "/")}`).filter((f) => /\.tsx?$/.test(f));
  const ui = [...walk("app/(app)/strength"), ...walk("components/strength"), ...walk("lib/strength")].map(read).join("\n");
  assert.ok(!/(synced|sent|uploaded|transferred) to (your |the )?(watch|forerunner|garmin connect)/i.test(ui), "no wording claims a completed device sync");
  assert.match(read("app/(app)/strength/export/page.tsx"), /never claims a watch sync it has not seen/);
  assert.match(read("components/strength/GarminDeviceCard.tsx"), /APEX cannot see whether it reached the watch/);
});
