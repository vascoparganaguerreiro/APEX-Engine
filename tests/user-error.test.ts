// P1.4: shared safe error messages. Synthetic error shapes only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NOT_SET_UP_MESSAGE, SafeError, apiError, classifyKind, friendlyError, friendlyMessage, logTechnical, looksTechnical, safeText, scrubForLog } from "../lib/userError.ts";
import { NotSetUp } from "../lib/strength/data.ts";

const LEAKS = /SELECT|INSERT|relation|column|schema cache|PGRST|42P01|42703|42501|23505|JWT|TypeError|_KEY|SERVICE_ROLE|NEXT_PUBLIC|\.sql|migration|docs\/|races\.sport|public\./i;

test("categories: network, session, permission, rate limit, everything else", () => {
  const cases: Array<[unknown, string]> = [
    [{ message: "TypeError: fetch failed" }, "network"], [{ message: "Failed to fetch" }, "network"], [{ name: "TimeoutError", message: "x" }, "network"], [{ status: 0 }, "network"],
    [{ code: "PGRST301", message: "JWT expired" }, "auth"], [{ status: 401, message: "Unauthorized" }, "auth"], [{ message: "Auth session missing!" }, "auth"],
    [{ code: "42501", message: "permission denied for table races" }, "permission"], [{ status: 403, message: "forbidden" }, "permission"],
    [{ code: "XX000", message: "internal error" }, "other"], [{ code: "42703", message: "column races.sport does not exist" }, "other"],
    [new Error("Could not save the strength session"), "other"],          // the word "session" alone is not an expired session
    [new TypeError("Cannot read properties of undefined (reading 'x')"), "other"],   // a programming error is not a connection problem
  ];
  for (const [e, kind] of cases) assert.equal(classifyKind(e), kind, JSON.stringify(e));
});

test("raw database errors never reach the message; a missing column is NOT called 'not set up' unless the caller says so", () => {
  const raw: unknown[] = [
    { code: "42703", message: 'column "sport" of relation "races" does not exist', details: "x", hint: "y" },
    { code: "42P01", message: 'relation "public.provider_connections" does not exist' },
    { code: "PGRST204", message: "Could not find the 'field_sources' column of 'profiles' in the schema cache" },
    { code: "23505", message: 'duplicate key value violates unique constraint "races_pkey"' },
    new Error("column races.sport does not exist"), new Error("SELECT id FROM races WHERE user_id = 'abc'"),
    new Error("Missing NEXT_PUBLIC_SUPABASE_URL (set them in Vercel)"), new Error("GEMINI_API_KEY is missing on the server"),
    new Error("ENOENT: C:\\Users\\x\\app\\lib\\secret.ts"), new Error("Run 10_races.sql (migration 10)"), "42703", { message: "jwt malformed", code: "PGRST301" },
  ];
  for (const e of raw) {
    const u = friendlyError(e, "Your races could not be loaded");
    assert.ok(!LEAKS.test(u.message), `${JSON.stringify(e)} -> ${u.message}`);
    assert.notEqual(u.kind, "not-set-up", "never inferred from a generic error");
  }
  const confirmed = friendlyError({ code: "42703", message: "column races.sport does not exist" }, "x", { notSetUp: true });
  assert.deepEqual([confirmed.kind, confirmed.message, confirmed.retryable], ["not-set-up", NOT_SET_UP_MESSAGE, false]);
  assert.ok(!LEAKS.test(NOT_SET_UP_MESSAGE));
});

test("retry behaviour per category and the message names what failed", () => {
  const net = friendlyError({ message: "Failed to fetch" }, "Your races could not be loaded");
  assert.deepEqual([net.kind, net.retryable], ["network", true]); assert.match(net.message, /^Your races could not be loaded: the connection failed/);
  const auth = friendlyError({ status: 401 }, "Your races could not be loaded"); assert.deepEqual([auth.kind, auth.retryable], ["auth", false]); assert.match(auth.message, /sign in again/i);
  const perm = friendlyError({ code: "42501" }, "Your races could not be saved"); assert.deepEqual([perm.kind, perm.retryable], ["permission", false]); assert.match(perm.message, /Nothing was changed/);
  const rate = friendlyError({ status: 429, message: "x" }, "That"); assert.equal(rate.retryable, true); assert.match(rate.message, /too many requests/i);
  const other = friendlyError({ code: "XX000", message: "boom" }, "Your races could not be loaded"); assert.deepEqual([other.kind, other.retryable], ["other", true]); assert.match(other.message, /try again/i);
  assert.match(friendlyMessage(undefined), /Something went wrong/); assert.match(friendlyMessage(null), /Something went wrong/);
});

test("a plain message written by the app passes; a SafeError passes as-is; anything technical does not", () => {
  assert.equal(friendlyMessage(new Error("Choose a date for the race.")), "Choose a date for the race.");
  assert.equal(friendlyMessage(new SafeError("other", "Already saved.")), "Already saved.");
  assert.equal(friendlyMessage(new NotSetUp()), NOT_SET_UP_MESSAGE);
  assert.notEqual(friendlyMessage(new Error("x".repeat(500))), "x".repeat(500), "very long text is not shown");
  assert.equal(friendlyMessage("42703"), "Something went wrong. Please try again in a moment.");
});

test("looksTechnical and safeText", () => {
  for (const t of ["migration 14 not applied", "run 13_strength.sql", "see docs/universal-connect.md", "GEMINI_API_KEY missing", "SUPABASE_SERVICE_ROLE_KEY", "relation \"x\" does not exist",
    "SELECT * FROM t", "JWT expired", "Bearer abc", "at foo (/app/x.ts:1:2)", "C:\\Users\\a", "violates check constraint", "PGRST204", "code 42P01 / 23505", "process.env.X", "TypeError: x"]) assert.ok(looksTechnical(t), t);
  for (const t of ["Choose a date.", "Could not reach Intervals.icu.", "Intervals.icu rate limit reached. Try again shortly.", "Please sign in again.", "The file must be between 1 byte and 10 MB.", "Reading the report took too long."]) assert.ok(!looksTechnical(t), t);
  assert.equal(safeText("column x does not exist", "Fallback."), "Fallback."); assert.equal(safeText(null, "Fallback."), "Fallback."); assert.equal(safeText(" Hello ", "Fallback."), "Hello");
});

test("API route answers: a plain server message is shown, a technical one is replaced, 401 is always 'sign in again'", () => {
  assert.equal(apiError(429, { error: "Intervals.icu rate limit reached. Try again shortly." }).message, "Intervals.icu rate limit reached. Try again shortly.");
  const tech = apiError(500, { error: "relation \"public.coach_usage\" does not exist" }); assert.ok(!LEAKS.test(tech.message), tech.message);
  const key = apiError(503, { error: "GEMINI_API_KEY is missing on the server" }); assert.ok(!LEAKS.test(key.message), key.message);
  assert.match(apiError(401, { error: "anything" }).message, /sign in again/i);
  assert.ok(!LEAKS.test(apiError(500, {}).message)); assert.ok(!LEAKS.test(apiError(502, null).message));
  assert.equal(apiError(403, { error: "Your sharing settings belong to another account." }).kind, "permission");
});

test("technical details are logged (code, status, name), never the message in the browser; secrets are scrubbed on the server", () => {
  const lines: unknown[][] = []; const orig = console.error; console.error = (...a: unknown[]) => { lines.push(a); };
  try {
    logTechnical("races.load", { name: "PostgrestError", code: "42703", status: 400, message: "column races.sport does not exist" });
    logTechnical("x", { code: "a".repeat(200), message: "m" }); logTechnical("y", undefined); logTechnical("z", { get message(): string { throw new Error("boom"); } });
  } finally { console.error = orig; }
  assert.equal(lines.length >= 3, true);
  const first = lines[0][1] as Record<string, unknown>;
  assert.deepEqual([first.scope, first.name, first.code, first.status], ["races.load", "PostgrestError", "42703", 400]);
  assert.ok(!("code" in (lines[1][1] as object)), "an odd 'code' is not copied");
  assert.equal(scrubForLog("Bearer abc.def.ghi failed key=" + "A".repeat(40)), "Bearer [redacted] failed key=[redacted]");
  assert.ok(scrubForLog("x".repeat(1000)).length <= 300);
});

// ------------------------------------------------------------------ wiring: the replaced call sites, and strings that must never be shown
const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(new URL(dir + "/", root))) {
    const p = join(dir, n).replace(/\\/g, "/");
    if (statSync(new URL(p, root)).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

test("no screen builds its error text from the raw message any more", () => {
  const offenders: string[] = [];
  for (const f of [...walk("app"), ...walk("components")].filter((x) => !x.startsWith("app/api/"))) {
    const code = stripComments(read(f));
    if (/(?:setError|setErr|setMsg|setMessage|setProblem)\([^;\n]*(?:instanceof Error \? \w+\.message|\.message\b(?! ?===)|String\(\w+\))/.test(code)) offenders.push(f);
    if (/const errMsg = \(e: unknown\) => \(?e (?:instanceof Error|&&)/.test(code)) offenders.push(f + " (errMsg)");
  }
  // Documented exceptions: messages the app itself wrote (validation in WorkoutEditor and the imports, the fixed texts of lib/authFlow.ts,
  // a SafeError / NotSetUp message). None of them carries database or server text.
  const allowed = new Set(["components/strength/WorkoutEditor.tsx", "app/(app)/strength/import/page.tsx", "app/(app)/strength/routines/page.tsx", "app/forgot-password/page.tsx",
    "app/reset-password/page.tsx", "components/ChangePasswordCard.tsx", "components/strength/GarminDeviceCard.tsx",
    "app/(app)/races/[id]/page.tsx"]);          // shows friendlyError(...).message (so it can also offer Try again)
  assert.deepEqual(offenders.filter((f) => !allowed.has(f)), []);
});

test("user-visible strings never mention migrations, SQL files, documentation paths or environment variables", () => {
  const bad: string[] = [];
  const files = [...walk("app"), ...walk("components"), ...walk("lib")].filter((f) => !/\/(tests?)\//.test(f));
  for (const f of files) {
    const code = stripComments(read(f));
    // string literals and JSX text that a person could read
    for (const m of code.matchAll(/(["'`])((?:\\.|(?!\1).){12,})\1/g)) {
      const s = m[2];
      if (/\bmigration \d|\bmigration\b.*\b(applied|apply)\b|\b\d{2}_[a-z_]+\.sql|docs\/[a-z-]+\.md|(?:GEMINI|SUPABASE|INTERVALS|WHOOP|NEXT_PUBLIC)_[A-Z_]+ (?:is|are) missing|\(set them in Vercel\)|did you run/i.test(s)) bad.push(`${f}: ${s.slice(0, 80)}`);
    }
    for (const m of code.matchAll(/>([^<>{}]{12,})</g)) if (/migration \d|\.sql\b|docs\/[a-z-]+\.md/i.test(m[1])) bad.push(`${f}: ${m[1].slice(0, 80)}`);
  }
  assert.deepEqual(bad, []);
});

test("wiring: Profile, Strength and the API client use the shared helper", () => {
  assert.match(read("lib/profile.ts"), /from "\.\/userError\.ts"/); assert.match(read("lib/profile.ts"), /class ProfileError extends SafeError/);
  assert.match(read("lib/strength/hooks.ts"), /friendlyMessage\(e, "That could not be completed"/);
  assert.match(read("lib/strength/data.ts"), /class NotSetUp extends SafeError/);
  const api = read("lib/api.ts"); assert.ok(!/new Error\(j\.error/.test(api)); assert.equal((api.match(/throw apiError\(r\.status, j\)/g) ?? []).length, 5);
  assert.match(read("lib/supabase.ts"), /can't start right now/); assert.ok(!/NEXT_PUBLIC_SUPABASE_URL or/.test(read("lib/supabase.ts")));
  assert.match(read("lib/today/load.ts"), /\["42P01", "PGRST202", "PGRST205"\]\.includes/, "Today's 'not set up' comes from error codes only, never message text");
});
