// In-memory stand-in for the Supabase query builder subset used by lib/integrations (select/eq/lt/or/maybeSingle/upsert/update/
// delete/insert/rpc). Rows are plain objects; conflicts are resolved like PostgREST upserts.
import { decryptSecret, encryptSecret, needsRotation } from "../lib/crypto.ts";
import type { CryptoOps } from "../lib/connectionStore.ts";

type Row = Record<string, unknown>;
type Err = { message: string; code?: string } | null;

export const TEST_ENV = { INTERVALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") };
export const ops: CryptoOps = {
  encrypt: (p, aad) => encryptSecret(p, aad, TEST_ENV), decrypt: (b, aad) => decryptSecret(b, aad, TEST_ENV), needsRotation: (b) => needsRotation(b, TEST_ENV),
};

const DEFAULTS: Record<string, Row> = {
  provider_connections: { status: "connected", failures: 0, settings: {}, cursor: null, next_retry_at: null, last_success_at: null, lease_until: null, scopes: [] },
  provider_credentials: { rev: 1, scopes: [] },
};

export class FakeDb {
  tables: Map<string, Row[]>;
  missing: Set<string>;
  rpcs: Map<string, (args: Row) => { data: unknown; error: Err }>;
  calls: Array<{ table: string; op: string }>;
  constructor() { this.tables = new Map(); this.missing = new Set(); this.rpcs = new Map(); this.calls = []; }
  rows(t: string): Row[] { if (!this.tables.has(t)) this.tables.set(t, []); return this.tables.get(t)!; }
  from(t: string): Query { return new Query(this, t); }
  rpc(fn: string, args: Row): PromiseLike<{ data: unknown; error: Err }> {
    const f = this.rpcs.get(fn);
    return Promise.resolve(f ? f(args) : { data: null, error: { message: `function ${fn} does not exist`, code: "PGRST202" } });
  }
}

class Query implements PromiseLike<{ data: unknown; error: Err }> {
  db: FakeDb; t: string; op: string; payload: unknown; opts: { onConflict?: string; ignoreDuplicates?: boolean }; filters: Array<(r: Row) => boolean>; single: boolean; returning: boolean;
  constructor(db: FakeDb, t: string) { this.db = db; this.t = t; this.op = "select"; this.payload = null; this.opts = {}; this.filters = []; this.single = false; this.returning = false; }
  select(_c?: string) { this.returning = true; return this; }
  eq(k: string, v: unknown) { this.filters.push((r) => r[k] === v); return this; }
  lt(k: string, v: string) { this.filters.push((r) => r[k] !== null && r[k] !== undefined && String(r[k]) < v); return this; }
  not(k: string, _op: string, _v: unknown) { this.filters.push((r) => r[k] !== null && r[k] !== undefined); return this; }
  order() { return this; }
  limit() { return this; }
  or(expr: string) {
    const parts = expr.split(",").map((p) => { const [k, op, ...rest] = p.split("."); return { k, op, v: rest.join(".") }; });
    this.filters.push((r) => parts.some(({ k, op, v }) => (op === "is" && v === "null" ? r[k] === null || r[k] === undefined : op === "lt" ? r[k] !== null && r[k] !== undefined && String(r[k]) < v : false)));
    return this;
  }
  maybeSingle() { this.single = true; return this; }
  upsert(p: unknown, o: { onConflict?: string; ignoreDuplicates?: boolean } = {}) { this.op = "upsert"; this.payload = p; this.opts = o; return this; }
  insert(p: unknown) { this.op = "insert"; this.payload = p; return this; }
  update(p: unknown) { this.op = "update"; this.payload = p; return this; }
  delete() { this.op = "delete"; return this; }
  then<A, B>(res?: ((v: { data: unknown; error: Err }) => A | PromiseLike<A>) | null, rej?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(res, rej);
  }
  run(): { data: unknown; error: Err } {
    this.db.calls.push({ table: this.t, op: this.op });
    if (this.db.missing.has(this.t)) return { data: null, error: { message: `relation "public.${this.t}" does not exist`, code: "42P01" } };
    const rows = this.db.rows(this.t), match = (r: Row) => this.filters.every((f) => f(r));
    if (this.op === "select") {
      const found = rows.filter(match).map((r) => ({ ...r }));
      return { data: this.single ? found[0] ?? null : found, error: null };
    }
    if (this.op === "update") {
      const hit = rows.filter(match);
      for (const r of hit) Object.assign(r, this.payload as Row);
      return { data: this.returning ? hit.map((r) => ({ ...r })) : null, error: null };
    }
    if (this.op === "delete") {
      const hit = rows.filter(match);
      this.db.tables.set(this.t, rows.filter((r) => !match(r)));
      return { data: this.returning ? hit : null, error: null };
    }
    const list = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
    const keys = (this.opts.onConflict ?? "").split(",").filter(Boolean);
    for (const p of list) {
      const existing = keys.length ? rows.find((r) => keys.every((k) => r[k] === p[k])) : undefined;
      if (existing) {
        if (this.op === "insert") return { data: null, error: { message: "duplicate key", code: "23505" } };
        if (!this.opts.ignoreDuplicates) Object.assign(existing, p);
      } else rows.push({ ...(DEFAULTS[this.t] ?? {}), imported_at: "first", ...p });
    }
    return { data: null, error: null };
  }
}

/** A scripted fetch: each call is matched by a predicate on (url, init); unmatched calls fail the test. */
export function scriptedFetch(routes: Array<{ when: (url: string, init?: RequestInit) => boolean; reply: (url: string, init?: RequestInit) => Response }>) {
  const log: Array<{ url: string; method: string; auth: string | null }> = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    log.push({ url, method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization") });
    const r = routes.find((x) => x.when(url, init));
    if (!r) throw new Error(`unexpected request ${url}`);
    return r.reply(url, init);
  }) as unknown as typeof fetch;
  return { fetch: f, log };
}
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
export const noSleep = async () => undefined;
