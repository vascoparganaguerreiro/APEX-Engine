// Static checks that the credential boundary cannot silently regress. They read source and SQL text;
// they do NOT replace running 07_intervals_key_security.sql's verification queries against a real database.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(root, p), "utf8");
const stripSql = (s: string) => s.replace(/--.*$/gm, "");
const files = (dir: string, exts: string[]) =>
  (readdirSync(join(root, dir), { recursive: true }) as string[])
    .map((f) => f.replace(/\\/g, "/")).filter((f) => !f.includes("node_modules") && exts.some((e) => f.endsWith(e))).map((f) => `${dir}/${f}`);

const sql = stripSql(read("07_intervals_key_security.sql")).toLowerCase();

test("browser roles have no access to the encrypted credentials table", () => {
  assert.match(sql, /alter table public\.intervals_credentials enable row level security/);
  assert.match(sql, /revoke all on public\.intervals_credentials from public, anon, authenticated/);
  assert.ok(!/create policy[^;]*on public\.intervals_credentials/.test(sql), "no policy may open the credentials table");
  assert.ok(!/grant[^;]*on public\.intervals_credentials/.test(sql), "no grant on the credentials table");
});

test("browser roles can read only the non-secret connection columns and cannot write", () => {
  assert.match(sql, /revoke all on public\.intervals_connections from public, anon, authenticated/);
  const grants = [...sql.matchAll(/grant\s+([^;]*?)\s+on public\.intervals_connections to ([^;]*);/g)];
  assert.equal(grants.length, 1);
  assert.match(grants[0][1], /^select \(user_id, athlete_id, last_sync_at, created_at\)$/);
  assert.ok(!grants[0][1].includes("api_key"));
  assert.ok(!/for all/.test(sql) && !/for (insert|update|delete)/.test(sql), "only a SELECT policy may exist");
});

test("service-role and encryption secrets are server-only", () => {
  const ts = [...files("app", [".ts", ".tsx"]), ...files("lib", [".ts", ".tsx"]), ...files("components", [".ts", ".tsx"])];
  const serverModules = /(serverConnections|serverAuth|connectionStore|\/crypto)["']/;
  for (const f of ts) {
    const src = read(f);
    if (/^\s*["']use client["']/.test(src)) {
      assert.ok(!serverModules.test(src), `${f}: a client component must not import server modules`);
      assert.ok(!/SERVICE_ROLE|ENCRYPTION_KEY|api_key_enc/.test(src), `${f}: client code must not reference secrets`);
    }
    if (/SERVICE_ROLE/.test(src)) assert.equal(f, "lib/serverConnections.ts", `${f}: only serverConnections may read the service role key`);
  }
  for (const f of [".env.example", "env.example"]) assert.ok(!/NEXT_PUBLIC_\w*(SERVICE|ENCRYPTION)/.test(read(f)), `${f}: secrets must not be NEXT_PUBLIC_`);
});

test("browser code never selects the key columns", () => {
  for (const f of [...files("app", [".tsx"]), ...files("components", [".tsx"]), "lib/api.ts"]) {
    assert.ok(!/api_key/.test(read(f)), `${f} must not touch api_key columns`);
  }
});

test("routes authenticate first, take the user id only from the verified token, and never return or log keys", () => {
  for (const f of ["app/api/intervals/connect/route.ts", "app/api/intervals/sync/route.ts"]) {
    const src = read(f);
    const auth = src.indexOf("authUser(req)");
    assert.ok(auth > 0, `${f} must call authUser`);
    assert.ok(auth < src.search(/(save|get|delete)Connection\(/), `${f} must authenticate before touching credentials`);
    assert.ok(!/body\??\.\s*(user_?id|uid)/i.test(src), `${f} must not read a user id from the request body`);
    assert.ok(!/console\.[a-z]+\([^)]*(apiKey|api_key)/i.test(src), `${f} must not log credentials`);
    assert.ok(!/Response\.json\([^)]*apiKey/.test(src), `${f} must not return the key`);
  }
});
