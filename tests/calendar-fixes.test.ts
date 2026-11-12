// Calendar Phase 1 review fixes: ON DELETE SET NULL safety of the migration, stale-load guard, bounded strength query, locked plan type.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { kindLocked, latestGate, type PlannedWorkout } from "../lib/calendar/model.ts";
import { loadStrengthRange } from "../lib/calendar/data.ts";

const SQL = readFileSync(new URL("../15_training_calendar.sql", import.meta.url), "utf8");
const code = SQL.replace(/--.*$/gm, "");
const plan = (o: Partial<PlannedWorkout> = {}): PlannedWorkout => ({
  id: "p1", planned_date: "2026-11-12", kind: "endurance", sport: "run", title: "Easy run", duration_min: 45, distance_m: null, intensity: null, routine_id: null,
  structure: null, notes: null, status: "planned", completed_at: null, completed_activity_id: null, completed_strength_session_id: null, link_origin: null, source: "manual", ...o,
});

/** Check constraints of the migration with comments removed: [name, expression]. */
function checkConstraints(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of code.matchAll(/constraint\s+(\w+)\s+check\s*\(/g)) {
    let depth = 1, i = m.index! + m[0].length;
    const start = i;
    while (depth > 0 && i < code.length) { if (code[i] === "(") depth++; else if (code[i] === ")") depth--; i++; }
    out.push([m[1], code.slice(start, i - 1)]);
  }
  return out;
}

test("REGRESSION: no check constraint may depend on a nullable FK column that is 'on delete set null'", () => {
  // completed_activity_id, completed_strength_session_id and routine_id are "on delete set null". Deleting the referenced activity, strength
  // session or routine (admin cleanup, auth.users cascade) makes Postgres UPDATE this row to null the id and evaluate EVERY check on it.
  // A rule such as "link_origin is set => an id is not null" then fails and BLOCKS the delete of the activity or session itself.
  const setNull = [...code.matchAll(/(\w+)\s+\w+\s+references public\.\w+\(id\) on delete set null/g)].map((m) => m[1]).sort();
  assert.deepEqual(setNull, ["completed_activity_id", "completed_strength_session_id", "routine_id"]);
  assert.doesNotMatch(code, /planned_workouts_link_origin/, "the unsafe constraint is gone");

  const cs = checkConstraints();
  for (const name of ["planned_workouts_link_kind", "planned_workouts_one_source", "planned_workouts_link_status"]) assert.ok(cs.some(([n]) => n === name), `${name} is preserved`);
  for (const [name, expr] of cs) {
    if (!setNull.some((c) => expr.includes(c))) continue;
    assert.doesNotMatch(expr, /link_origin|source_ref|import_batch_id/, `${name} must not tie another nullable column to an FK column`);
    // Evaluate the constraint as it is right after ON DELETE SET NULL: every FK column null, any kind, any status, any link_origin.
    const js = expr.replace(/(\w+) is not null/g, "($1 !== null)").replace(/(\w+) is null/g, "($1 === null)").replace(/ = '/g, " === '").replace(/\bor\b/g, "||").replace(/\band\b/g, "&&");
    const fn = new Function("kind", "status", "completed_activity_id", "completed_strength_session_id", "routine_id", "link_origin", `return Boolean(${js});`);
    for (const kind of ["endurance", "strength", "rest", "milestone"]) for (const status of ["planned", "completed", "skipped"]) for (const origin of [null, "manual", "confirmed_match"]) {
      assert.equal(fn(kind, status, null, null, null, origin), true, `${name} fails after SET NULL (kind=${kind}, status=${status}, link_origin=${origin}): it would block deleting the linked record`);
    }
  }
  // The completion rules that remain are still real rules for non-null links.
  const kindRule = new Function("kind", "completed_activity_id", "completed_strength_session_id", `return Boolean(${cs.find(([n]) => n === "planned_workouts_link_kind")![1].replace(/(\w+) is null/g, "($1 === null)").replace(/ = '/g, " === '").replace(/\bor\b/g, "||").replace(/\band\b/g, "&&")});`);
  assert.equal(kindRule("endurance", 1, null), true); assert.equal(kindRule("strength", 1, null), false); assert.equal(kindRule("rest", null, "x"), false);
});

test("migration still has the partial unique indexes and the other completion constraints", () => {
  assert.match(code, /unique index if not exists planned_workouts_activity_uq[^;]*where completed_activity_id is not null/);
  assert.match(code, /unique index if not exists planned_workouts_strength_uq[^;]*where completed_strength_session_id is not null/);
  assert.match(code, /planned_workouts_one_source/); assert.match(code, /planned_workouts_link_status/); assert.match(code, /planned_workouts_link_kind/);
});

test("latestGate: an older response can never overwrite a newer one", async () => {
  const gate = latestGate();
  let shown: string | null = null;
  const load = (label: string, ms: number) => { const t = gate.ticket(); return new Promise<string>((r) => setTimeout(() => r(label), ms)).then((v) => { if (gate.isLatest(t)) shown = v; }); };
  await Promise.all([load("range A (slow, older)", 30), load("range B (fast, newest)", 5)]);
  assert.equal(shown, "range B (fast, newest)");
  const g2 = latestGate(), t1 = g2.ticket();
  assert.equal(g2.isLatest(t1), true); g2.ticket(); assert.equal(g2.isLatest(t1), false);
});

test("training page: planned loads use a ticket and the current range; the other loads are cancelled when the range changes", () => {
  const page = readFileSync(new URL("../app/(app)/training/page.tsx", import.meta.url), "utf8");
  assert.match(page, /latestGate\(\)/);
  assert.match(page, /isLatest\(t\) && rangeRef\.current === r/, "applied only if newest AND for the range on screen");
  assert.match(page, /const r = rangeRef\.current/, "actions reload the range shown now, not the range captured when the callback was made");
  assert.match(page, /let cancelled = false/); assert.match(page, /return \(\) => \{ cancelled = true; \}/);
  assert.match(page, /if \(!cancelled\) set\(v\)/);
  for (const l of ["loadCompletedActivities", "loadCompletedStrength", "loadRaces"]) assert.match(page, new RegExp(`${l}\\([^)]*\\)\\.then\\(keep\\(`), `${l} result goes through the cancel guard`);
  assert.match(page, /loadCompletedStrength\(range\.from, range\.to\)/);
});

// ------------------------------------------------------------------ bounded strength query
type Row = Record<string, unknown>;
/** Fake PostgREST for strength_sessions / training_session_links: honours filters, ordering and range(), records the selected columns. */
function strengthDb(sessions: Row[], links: Row[] | "missing") {
  const selects: string[] = [];
  return {
    selects,
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const sorts: string[] = [];
      let lo = 0, hi = Infinity;
      const b: any = {
        select(c: string) { selects.push(`${table}:${c}`); return b; },
        is(c: string, v: null) { filters.push((r) => (r[c] ?? null) === v); return b; },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
        gte(c: string, v: string) { filters.push((r) => String(r[c]) >= v); return b; },
        lt(c: string, v: string) { filters.push((r) => String(r[c]) < v); return b; },
        order(c: string) { sorts.push(c); return b; },
        range(f: number, t: number) { lo = f; hi = t; return b; },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
          if (table === "training_session_links" && links === "missing") return Promise.resolve({ data: null, error: { code: "42P01", message: "does not exist" } }).then(res, rej);
          const src = table === "strength_sessions" ? sessions : (links as Row[]);
          const rows = src.filter((r) => filters.every((f) => f(r))).sort((x, y) => { for (const c of sorts) { const a = String(x[c]), d = String(y[c]); if (a !== d) return a < d ? -1 : 1; } return 0; });
          return Promise.resolve({ data: rows.slice(lo, hi + 1).map((r) => ({ ...r })), error: null }).then(res, rej);
        },
      };
      return b;
    },
  };
}
const ss = (i: number, o: Row = {}): Row => ({ id: `id-${String(i).padStart(6, "0")}`, title: `W${i}`, started_at: new Date(Date.UTC(2024, 0, 1, 6) + i * 60_000).toISOString(), ended_at: "2030-01-01T00:00:00Z", paused_seconds: 0, status: "completed", deleted_at: null, ...o });

test("calendar strength query: date-bounded, display columns only, completed and not deleted, and an old month is never truncated", async () => {
  // 1,300 sessions in January 2024 (past the 400 / 500 / 1000 boundaries) plus 3,000 newer ones that a "newest 400" read would return instead
  const old = Array.from({ length: 1300 }, (_, i) => ss(i));
  const newer = Array.from({ length: 3000 }, (_, i) => ss(100000 + i, { started_at: new Date(Date.UTC(2026, 5, 1) + i * 60_000).toISOString() }));
  const noise = [ss(200001, { status: "active" }), ss(200002, { deleted_at: "2024-01-02T00:00:00Z" }), ss(200003, { started_at: "2023-12-30T12:00:00Z" }), ss(200004, { started_at: "2024-02-05T12:00:00Z" })];
  const db = strengthDb([...old, ...newer, ...noise], []);
  const got = await loadStrengthRange(db, "2023-12-31T00:00:00Z", "2024-02-01T00:00:00Z");
  assert.equal(got.length, 1300, "every session of the old month");
  assert.equal(new Set(got.map((g) => g.id)).size, 1300, "each exactly once");
  assert.equal(got.some((g) => ["id-200001", "id-200002", "id-200003", "id-200004"].includes(g.id)), false, "active, deleted and out-of-range sessions are not returned");
  assert.ok(db.selects.includes("strength_sessions:id,title,started_at,ended_at,paused_seconds"), "no nested exercises or sets are read");
  assert.equal(db.selects.some((s) => s.startsWith("strength_sessions:") && /exercise|sets/.test(s)), false);
  assert.deepEqual(Object.keys(got[0]).sort(), ["endedAt", "id", "pausedSeconds", "startedAt", "title"]);
});

test("calendar strength query: merged duplicates are excluded (strengthExcludedIds); a missing links table excludes nothing", async () => {
  const rows = [ss(1), ss(2), ss(3)];
  const links = [
    { id: 1, training_session_id: "t1", activity_id: null, strength_session_id: "id-000001", role: "primary" },
    { id: 2, training_session_id: "t1", activity_id: null, strength_session_id: "id-000002", role: "secondary" },   // an APEX log and a Hevy import of one workout
  ];
  const got = await loadStrengthRange(strengthDb(rows, links), "2023-12-31T00:00:00Z", "2024-02-01T00:00:00Z");
  assert.deepEqual(got.map((g) => g.id), ["id-000001", "id-000003"]);
  assert.equal((await loadStrengthRange(strengthDb(rows, "missing"), "2023-12-31T00:00:00Z", "2024-02-01T00:00:00Z")).length, 3);
});

test("a linked plan keeps its type, with an explanation; an unlinked plan can change it", () => {
  assert.equal(kindLocked(plan()), false);
  assert.equal(kindLocked(plan({ status: "completed", completed_activity_id: 5 })), true);
  assert.equal(kindLocked(plan({ kind: "strength", status: "completed", completed_strength_session_id: "s1" })), true);
  assert.equal(kindLocked(plan({ status: "completed" })), false, "marked done by hand: there is no link, so the type is free");
  const form = readFileSync(new URL("../components/calendar/PlannedForm.tsx", import.meta.url), "utf8");
  assert.match(form, /disabled=\{locked\}/);
  assert.match(form, /can't be changed while this plan is linked to a recorded session/);
  assert.match(form, /initial && kindLocked\(initial\) \? initial\.kind : d\.kind/, "a locked plan is saved with its own kind even if the field were bypassed");
});
