import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NotSetUp, isMissing, loadCustom, loadLinksOrNone, supabaseTransport, workoutFromRow, type Db } from "../lib/strength/data.ts";
import { TransportError } from "../lib/strength/sync.ts";
import { catalogExercise } from "../lib/strength/library.ts";
import { FakeStrengthServer, uid } from "./strength-fixtures.ts";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");
const sql = read("13_strength.sql");
const TABLES = ["strength_custom_exercises", "strength_routines", "strength_routine_exercises", "strength_routine_sets", "strength_sessions", "strength_session_exercises", "strength_sets", "training_sessions", "training_session_links", "training_merge_decisions", "wearable_devices"];

test("migration 13: every user-owned table has RLS, an owner-only policy, and no anonymous access", () => {
  for (const t of TABLES) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${t} \\(`), `${t} is created idempotently`);
    assert.match(sql, new RegExp(`alter table public\\.${t}\\s+enable row level security`), `${t}: RLS`);
    assert.match(sql, new RegExp(`on public\\.${t} for all to authenticated\\s+using \\(user_id = \\(select auth\\.uid\\(\\)\\)\\)`), `${t}: owner-only policy`);
    assert.match(sql, new RegExp(`user_id\\s+uuid (?:primary key )?(?:not null )?default auth\\.uid\\(\\) references auth\\.users\\(id\\) on delete cascade`), `${t}: owned by a user`);
  }
  assert.match(sql, /revoke all on public\.strength_custom_exercises[\s\S]*from public, anon, authenticated;/);
  assert.ok(!/grant [^;]* to anon/i.test(sql), "nothing is granted to anon");
  for (const f of ["save_strength_routine", "apply_strength_ops", "import_strength_sessions", "merge_training_sources", "unmerge_training_session"]) {
    assert.match(sql, new RegExp(`function public\\.${f}\\([^)]*\\)\\s+returns [a-z]+ language plpgsql security invoker set search_path = public`), `${f} runs as the caller (RLS applies)`);
    assert.match(sql, new RegExp(`revoke all on function public\\.${f}\\([^)]*\\) from public, anon;`));
  }
  assert.ok(!/security definer/i.test(sql), "no function bypasses RLS");
});

test("migration 13: additive, idempotent, and independent of the pending migrations 09-12", () => {
  assert.ok(!/\bdrop table\b|\bdrop column\b|\btruncate\b|\bdelete from public\.activities\b|\bupdate public\.activities\b/i.test(sql), "no destructive statement on existing data");
  for (const obj of ["coach_", "consume_extraction_quota", "extraction_usage", "races", "profiles", "birth_date", "field_sources"]) assert.ok(!sql.includes(obj), `does not depend on ${obj} (09-12)`);
  assert.match(sql, /alter table public\.activities\s+add column if not exists origin/);
  assert.ok((sql.match(/add column if not exists/g) ?? []).length === 5, "only new, nullable provenance columns on activities");
  assert.match(sql, /training_session_links_activity_uq on public\.training_session_links \(activity_id\) where activity_id is not null/, "a source can belong to one canonical session only");
  assert.match(sql, /strength_sets_exercise_fk foreign key \(session_exercise_id, session_id\) references public\.strength_session_exercises \(id, session_id\)/, "a set always belongs to an exercise of the same session");
  assert.match(sql, /where t\.rev < excluded\.rev/, "replays cannot overwrite newer data");
  assert.match(sql, /on conflict \(user_id, source, source_ref\) where source_ref is not null do nothing/, "re-imports never overwrite");
  assert.match(sql, /custom_exercise_id uuid references public\.strength_custom_exercises\(id\) on delete restrict/, "custom exercises with history cannot be hard-deleted");
});

test("cross-user isolation in the sync model: another user's ids are rejected and their rows untouched", () => {
  const server = new FakeStrengthServer("alice");
  const sid = uid();
  server.apply([{ op_id: uid(), kind: "session", id: sid, rev: 5, deleted: false, data: { title: "Alice" } }], "alice");
  const r = server.apply([{ op_id: uid(), kind: "session", id: sid, rev: 99, deleted: true, data: { title: "hijack" } }], "bob");
  assert.equal(r[0].status, "rejected");
  assert.deepEqual([server.rows.get(`session:${sid}`)?.data.title, server.rows.get(`session:${sid}`)?.deleted], ["Alice", false]);
  const ex = server.apply([{ op_id: uid(), kind: "exercise", id: uid(), rev: 1, deleted: false, data: { session_id: sid } }], "bob");
  assert.equal(ex[0].status, "rejected", "bob cannot attach exercises to alice's session");
});

test("data layer: missing migration is detected and reported, never a crash; transport errors are classified", async () => {
  assert.ok(isMissing({ code: "PGRST205", message: "Could not find the table 'public.strength_sessions' in the schema cache" }));
  assert.ok(isMissing({ code: "42883", message: "function public.apply_strength_ops(jsonb) does not exist" }));
  assert.ok(!isMissing({ code: "23505", message: "duplicate key" }));
  const missing: Db = { from: () => ({ select: () => ({ is: () => ({ order: async () => ({ data: null, error: { code: "PGRST205", message: "Could not find the table" } }) }) }) }), rpc: async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }) };
  await assert.rejects(loadCustom(missing), NotSetUp);
  assert.deepEqual(await loadLinksOrNone(missing), [], "modules like Today keep working");
  await assert.rejects(supabaseTransport(missing).send([]), (e: unknown) => e instanceof TransportError && e.kind === "not_set_up");
  await assert.rejects(supabaseTransport(missing, () => false).send([]), (e: unknown) => e instanceof TransportError && e.kind === "offline");
  const throws: Db = { from: () => ({}), rpc: async () => { throw new TypeError("Failed to fetch"); } };
  await assert.rejects(supabaseTransport(throws).send([]), (e: unknown) => e instanceof TransportError && e.kind === "offline");
  const auth: Db = { from: () => ({}), rpc: async () => ({ data: null, error: { code: "PGRST301", message: "JWT expired" } }) };
  await assert.rejects(supabaseTransport(auth).send([]), (e: unknown) => e instanceof TransportError && e.kind === "auth");
  const ok: Db = { from: () => ({}), rpc: async (_f: string, a: Record<string, unknown>) => ({ data: (a.p_ops as Array<{ op_id: string }>).map((o) => ({ op_id: o.op_id, status: "applied" })), error: null }) };
  assert.deepEqual(await supabaseTransport(ok).send([{ op_id: "x", kind: "set", id: uid(), rev: 1, deleted: false, data: {} }]), [{ op_id: "x", status: "applied", error: undefined }]);
});

test("rows from the database drop deleted records and keep units exactly as stored", () => {
  const w = workoutFromRow({
    id: uid(), title: "Push", status: "completed", started_at: "2026-11-10T08:00:00Z", ended_at: "2026-11-10T09:00:00Z", paused_seconds: 0, source: "hevy_csv",
    strength_session_exercises: [
      { id: uid(), position: 1, exercise_key: "barbell_row", exercise_name: "Row", load_mode: "total", weight_unit: "kg", deleted_at: "2026-11-11T00:00:00Z", strength_sets: [] },
      { id: uid(), position: 0, exercise_key: "barbell_bench_press", exercise_name: "Bench Press (Barbell)", load_mode: "total", weight_unit: "lb", strength_sets: [
        { id: uid(), position: 1, set_type: "working", weight: "225.00", weight_unit: "lb", reps: 5, completed: true, deleted_at: null },
        { id: uid(), position: 0, set_type: "warmup", weight: "135", weight_unit: "lb", reps: 8, completed: true, deleted_at: "2026-11-11T00:00:00Z" },
      ] },
    ],
  }, catalogExercise);
  assert.equal(w.exercises.length, 1, "the deleted exercise is not shown");
  assert.deepEqual(w.exercises[0].sets.map((s) => [s.weight, s.unit]), [[225, "lb"]], "deleted set dropped, numeric strings parsed, unit kept");
  assert.equal(w.source, "hevy_csv");
  assert.equal(w.exercises[0].measurement, "weight_reps");
});

test("no credentials or privileged keys anywhere in the Strength Hub code", () => {
  const walk = (dir: string): string[] => (readdirSync(join(root, dir), { recursive: true }) as string[]).map((f) => `${dir}/${String(f).replace(/\\/g, "/")}`).filter((f) => /\.tsx?$/.test(f));
  const files = [...walk("lib/strength"), ...walk("components/strength"), ...walk("app/(app)/strength")];
  assert.ok(files.length > 20);
  for (const f of files) {
    const src = read(f);
    assert.ok(!/SERVICE_ROLE|service_role|adminClient|api_key|apiKey|GEMINI_API_KEY|password/i.test(src), `${f} must not touch credentials`);
  }
  assert.ok(!/from\("activities"\)\.(update|delete|upsert|insert)/.test(files.map(read).join("\n")), "the Strength Hub never modifies Garmin/Intervals activities");
});
