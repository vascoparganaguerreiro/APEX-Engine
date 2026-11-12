// "Remember me": where the Supabase session lives (lib/authStorage.ts), and the wiring that uses it. Fake storages; fake tokens only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SESSION_MODE_KEY, createAuthStorage, readSessionMode, writeSessionMode, type KV } from "../lib/authStorage.ts";

class Mem implements KV {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}
const KEY = "sb-ncbceqrulodrdkptnfot-auth-token", TOKEN = JSON.stringify({ access_token: "FAKE-ACCESS", refresh_token: "FAKE-REFRESH" });
const keysOf = (s: Mem) => [...s.m.keys()];
const throwing: KV = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };

test("default (no choice made yet): persistent, exactly as before, so nobody is signed out by this change", () => {
  const local = new Mem(), session = new Mem();
  assert.equal(readSessionMode(local), "persistent"); assert.equal(readSessionMode(null), "persistent"); assert.equal(readSessionMode(throwing), "persistent");
  local.setItem(KEY, TOKEN);                                                  // a session saved by the app before this feature
  const s = createAuthStorage(local, session);
  assert.equal(s.getItem(KEY), TOKEN, "an existing session is still found");
  s.setItem(KEY, TOKEN.replace("FAKE-ACCESS", "FAKE-ACCESS-2"));
  assert.deepEqual([keysOf(local).includes(KEY), keysOf(session)], [true, []]);
});

test("Remember me ON: the session is kept in localStorage and survives a browser restart", () => {
  const local = new Mem(), session1 = new Mem();
  writeSessionMode(local, "persistent");
  const s1 = createAuthStorage(local, session1);
  s1.setItem(KEY, TOKEN);
  assert.deepEqual([keysOf(local).includes(KEY), keysOf(session1)], [true, []]);
  const restarted = createAuthStorage(local, new Mem());                       // new browser run: localStorage kept, sessionStorage empty
  assert.equal(restarted.getItem(KEY), TOKEN);
  // token refreshes keep writing to the same place
  s1.setItem(KEY, TOKEN.replace("FAKE-REFRESH", "FAKE-REFRESH-2"));
  assert.match(local.getItem(KEY)!, /REFRESH-2/); assert.equal(keysOf(session1).length, 0);
});

test("Remember me OFF: the session lives only in sessionStorage, never in localStorage, and is gone after a restart", () => {
  const local = new Mem(), session1 = new Mem();
  writeSessionMode(local, "session");
  const s1 = createAuthStorage(local, session1);
  s1.setItem(KEY, TOKEN);
  assert.equal(keysOf(local).includes(KEY), false, "no token in localStorage");
  assert.equal(session1.getItem(KEY), TOKEN); assert.equal(s1.getItem(KEY), TOKEN);
  s1.setItem(KEY, TOKEN.replace("FAKE-REFRESH", "FAKE-REFRESH-2"));            // an automatic token refresh
  assert.equal(keysOf(local).includes(KEY), false, "a refresh does not move the session into localStorage");
  assert.match(session1.getItem(KEY)!, /REFRESH-2/);
  const restarted = createAuthStorage(local, new Mem());                       // browser closed and reopened
  assert.equal(restarted.getItem(KEY), null, "signed out after the restart: the login page is shown");
  assert.equal(readSessionMode(local), "session", "only the (non-secret) choice remained");
});

test("switching the choice at the next login moves the session and leaves no copy behind", () => {
  const local = new Mem(), session = new Mem();
  const s = createAuthStorage(local, session);
  writeSessionMode(local, "persistent"); s.setItem(KEY, TOKEN);
  writeSessionMode(local, "session"); s.setItem(KEY, TOKEN);
  assert.deepEqual([keysOf(local).includes(KEY), session.getItem(KEY) === TOKEN], [false, true]);
  writeSessionMode(local, "persistent"); s.setItem(KEY, TOKEN);
  assert.deepEqual([local.getItem(KEY) === TOKEN, keysOf(session)], [true, []]);
});

test("sign-out clears the session from every storage; unavailable storage is safe", () => {
  const local = new Mem(), session = new Mem(); local.setItem(KEY, TOKEN); session.setItem(KEY, TOKEN);
  const s = createAuthStorage(local, session);
  s.removeItem(KEY);
  assert.deepEqual([keysOf(local), keysOf(session)], [[], []]);
  // sessionStorage blocked + "remember me" off: kept in memory only (never written to localStorage)
  const l2 = new Mem(); writeSessionMode(l2, "session");
  const s2 = createAuthStorage(l2, null); s2.setItem(KEY, TOKEN);
  assert.equal(s2.getItem(KEY), TOKEN); assert.equal(keysOf(l2).includes(KEY), false);
  assert.equal(createAuthStorage(l2, null).getItem(KEY), null, "gone with the page");
  // localStorage blocked: the adapter never throws
  const s3 = createAuthStorage(throwing, new Mem()); s3.setItem(KEY, TOKEN); assert.equal(s3.getItem(KEY), TOKEN); s3.removeItem(KEY); assert.equal(s3.getItem(KEY), null);
  const s4 = createAuthStorage(null, null); s4.setItem(KEY, TOKEN); assert.equal(s4.getItem(KEY), TOKEN);
});

test("passwords are never stored: the adapter only ever holds what supabase-js writes, and the choice key holds no secret", () => {
  const local = new Mem(), session = new Mem(); const s = createAuthStorage(local, session);
  writeSessionMode(local, "session"); s.setItem(KEY, TOKEN);
  const all = JSON.stringify([...local.m, ...session.m]);
  assert.ok(!/password/i.test(all));
  assert.equal(local.getItem(SESSION_MODE_KEY), "session");
});

// ------------------------------------------------------------------ wiring
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
test("wiring: the client uses the adapter with persistence and auto-refresh left on; the login page sets the choice before signing in", () => {
  const sb = read("lib/supabase.ts"), login = read("app/login/page.tsx");
  assert.match(sb, /createAuthStorage\(browserStore\("localStorage"\), browserStore\("sessionStorage"\)\)/);
  assert.ok(!/persistSession\s*:\s*false|autoRefreshToken\s*:\s*false|detectSessionInUrl\s*:\s*false|flowType/.test(sb), "supabase-js defaults (persist, refresh, URL detection) are untouched");
  assert.match(login, /import \{ getSupabase, setRememberMe \} from "@\/lib\/supabase"/);
  assert.ok(login.indexOf("setRememberMe(remember)") > 0 && login.indexOf("setRememberMe(remember)") < login.indexOf("signInWithPassword"), "the choice is set BEFORE the session is created");
  assert.ok(login.indexOf("setRememberMe(remember)") < login.indexOf("signUp("));
  assert.match(login, /useState\(true\)/); assert.match(login, /<input type="checkbox" checked=\{remember\} onChange=\{\(e\) => setRemember\(e\.target\.checked\)\} \/>/);
  assert.ok(login.indexOf('className="remember"') < login.indexOf('type="submit"'), "the checkbox sits above the sign-in button");
  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(login + read("components/PasswordField.tsx")), "the login page itself stores nothing");
  assert.match(read("app/(app)/layout.tsx"), /signOut\(\{ scope: "local" \}\)/, "Sign out ends this device only; the phone stays signed in");
  assert.match(read("app/globals.css"), /\.remember\{[^}]*min-height:44px/, "44 px tap target");
});
