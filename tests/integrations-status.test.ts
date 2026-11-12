// P1.3: the Connectivity Centre reports "not set up" only for a confirmed missing provider_connections table/column. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROVIDER_CONNECTION_COLUMNS, isMissingProviderSchema, loadSnapshot } from "../lib/integrations/status.ts";

type Answer = { data?: unknown; error?: unknown; throws?: unknown };
/** Fake Db: each table answers with its own data, error or thrown exception; every query builder method is chainable. */
function fakeDb(answers: Record<string, Answer>, calls: string[] = []) {
  return {
    calls,
    from(t: string) {
      calls.push(t);
      const a = answers[t] ?? { data: [], error: null };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = new Proxy({}, { get(_o, k) {
        if (k === "then") return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => (a.throws !== undefined ? Promise.reject(a.throws) : Promise.resolve({ data: a.data ?? null, error: a.error ?? null })).then(res, rej);
        if (k === "maybeSingle") return () => b;
        return () => b;
      } });
      return b;
    },
  };
}
const LEAKS = /SELECT|relation|column|schema cache|PGRST|42P01|42703|42501|JWT|TypeError|fetch failed|provider_connections|public\.|migration|\.sql/i;
const ok = { intervals_connections: { data: { athlete_id: "i1", last_sync_at: null } }, provider_connections: { data: [] }, activities: { data: [] }, daily_metrics: { data: [] }, metric_observations: { data: [] } };
const E = {
  noTable: { code: "42P01", message: 'relation "public.provider_connections" does not exist' },
  noTableCache: { code: "PGRST205", message: "Could not find the table 'public.provider_connections' in the schema cache" },
  noColumn: { code: "42703", message: "column provider_connections.next_retry_at does not exist" },
  noColumnCache: { code: "PGRST204", message: "Could not find the 'scopes' column of 'provider_connections' in the schema cache" },
};

// ------------------------------------------------------------------ the predicate
test("only a missing provider_connections table or one of its selected columns is 'missing schema'", () => {
  for (const e of Object.values(E)) assert.equal(isMissingProviderSchema(e), true, JSON.stringify(e));
  const not: unknown[] = [
    { code: "", message: "TypeError: fetch failed" }, { code: "PGRST303", message: "JWT expired" }, { code: "42501", message: "permission denied for table provider_connections" },
    { code: "57014", message: "canceling statement due to statement timeout" }, { code: "XX000", message: "internal error in provider_connections" },
    { code: "42P01", message: 'relation "public.activities" does not exist' },                       // another table
    { code: "42703", message: "column provider_connections.unrelated does not exist" },            // a column this code does not select
    { code: "42703", message: "column activities.origin does not exist" },
    { code: "PGRST205", message: "Could not find the table 'public.metric_observations' in the schema cache" },
    { message: "relation provider_connections does not exist" },                                    // no code: not conclusive
    { code: "42P01", message: "relation does not exist" },                                          // does not name the table
    null, undefined, "provider_connections does not exist", 42,
  ];
  for (const e of not) assert.equal(isMissingProviderSchema(e), false, JSON.stringify(e));
  assert.equal(PROVIDER_CONNECTION_COLUMNS.length, 10);
});

// ------------------------------------------------------------------ the snapshot
test("everything works: connections ready, no notices", async () => {
  const s = await loadSnapshot(fakeDb({ ...ok, provider_connections: { data: [{ provider: "whoop", status: "connected" }] } }));
  assert.deepEqual([s.connections.status, s.migrated14, s.partial, s.direct.length, s.intervals.connected], ["ready", true, null, 1, true]);
});

test("a confirmed missing table or column is 'not set up' (migration 14 missing), and the rest of the page still loads", async () => {
  for (const e of Object.values(E)) {
    const s = await loadSnapshot(fakeDb({ ...ok, provider_connections: { error: e } }));
    assert.equal(s.connections.status, "not-set-up", JSON.stringify(e)); assert.equal(s.migrated14, false);
    assert.equal(s.intervals.connected, true, "Intervals.icu keeps working"); assert.equal(s.partial, null);
  }
});

test("network, session, permission, timeout and other errors are real errors: never 'not set up', with the right retry behaviour and no raw text", async () => {
  const cases: Array<[unknown, string, boolean]> = [
    [{ code: "", message: "TypeError: fetch failed" }, "network", true], [{ status: 0, message: "" }, "network", true],
    [{ code: "PGRST303", message: "JWT expired" }, "auth", false], [{ status: 401, message: "Unauthorized" }, "auth", false],
    [{ code: "42501", message: "permission denied for table provider_connections" }, "permission", false],
    [{ code: "57014", message: "canceling statement due to statement timeout" }, "other", true],
    [{ code: "XX000", message: "internal error" }, "other", true],
    [{ code: "42703", message: "column provider_connections.unrelated does not exist" }, "other", true],
    [{ message: "relation provider_connections does not exist" }, "other", true],
  ];
  for (const [err, kind, retryable] of cases) {
    for (const how of ["returned", "thrown"] as const) {
      const s = await loadSnapshot(fakeDb({ ...ok, provider_connections: how === "returned" ? { error: err } : { throws: err } }));
      assert.equal(s.connections.status, "error", `${how} ${JSON.stringify(err)}`);
      if (s.connections.status !== "error") continue;
      assert.deepEqual([s.connections.kind, s.connections.retryable], [kind, retryable], `${how} ${JSON.stringify(err)}`);
      assert.ok(!LEAKS.test(s.connections.message), s.connections.message); assert.match(s.connections.message, /Your connections could not be loaded/);
      assert.equal(s.migrated14, false, "connect buttons stay off while the state is unknown");
      assert.equal(s.intervals.connected, true);
    }
  }
});

test("a real failure of another optional read is a notice with retry, not a silent gap; a missing activities.origin stays silent", async () => {
  const net = { code: "", message: "TypeError: fetch failed" };
  for (const table of ["intervals_connections", "activities", "daily_metrics", "metric_observations"]) {
    const s = await loadSnapshot(fakeDb({ ...ok, [table]: { error: net } }));
    assert.equal(s.connections.status, "ready", table);
    assert.ok(s.partial && s.partial.retryable && !LEAKS.test(s.partial.message), table);
    const t = await loadSnapshot(fakeDb({ ...ok, [table]: { throws: net } })); assert.ok(t.partial, `${table} thrown`);
  }
  const noOrigin = await loadSnapshot(fakeDb({ ...ok, activities: { error: { code: "42703", message: "column activities.origin does not exist" } } }));
  assert.equal(noOrigin.partial, null, "migration 13 not applied is expected");
  const perm = await loadSnapshot(fakeDb({ ...ok, activities: { error: { code: "42501", message: "permission denied for table activities" } } }));
  assert.ok(perm.partial && !perm.partial.retryable);
});

test("when the connections table is unreadable, no per-provider query runs", async () => {
  const calls: string[] = [];
  await loadSnapshot(fakeDb({ ...ok, provider_connections: { error: E.noTable } }, calls));
  assert.ok(!calls.includes("metric_observations"));
});

// ------------------------------------------------------------------ the page
const page = readFileSync(new URL("../app/(app)/integrations/page.tsx", import.meta.url), "utf8");
test("page: the 'set up' notice only for confirmed missing schema; real errors say so with Try again; a failed configuration check is never 'server set-up needed'", () => {
  assert.match(page, /snap\.connections\.status === "not-set-up" && /); assert.match(page, /snap\.connections\.status === "error" && /);
  assert.ok(!/!snap\.migrated14 && <div className="notice">/.test(page), "the old warning that fired on any error is gone");
  assert.match(page, /Try again/); assert.match(page, /!configError && c\.setupMissing\.length > 0/);
  assert.ok(!/integrationConfig\(\)\.catch/.test(page), "a failed configuration check is no longer swallowed");
  assert.ok(!/migration|\.sql|docs\//i.test(page.replace(/\/\/.*$/gm, "")), "no internal wording on screen");
  assert.match(page, /snap\.migrated14 &&/, "connect buttons remain gated on a successful read");
});
