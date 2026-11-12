// Forgot / reset password (lib/authFlow.ts and its pages). A fake auth client stands in for Supabase; no network, no real accounts or passwords.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LINK_EXPIRED_MESSAGE, LINK_INVALID_MESSAGE, MAX_PASSWORD, MIN_PASSWORD, NEUTRAL_REQUEST_MESSAGE, completePasswordReset, parseRecoveryUrl, passwordInputType, passwordToggleLabel,
  recoverySession, requestPasswordReset, resetRedirectUrl, validateEmail, validateNewPassword, type AuthClientLike,
} from "../lib/authFlow.ts";

const PREVIEW = "https://apex-engine-4sp7qpx6y-apex-engine2.vercel.app";
type Err = { message?: string; code?: string; status?: number } | null;
interface Calls { reset: Array<{ email: string; redirectTo?: string }>; update: string[]; signOut: Array<unknown>; exchange: string[] }
function fakeAuth(o: { resetError?: Err; resetThrows?: boolean; updateError?: Err; updateThrows?: boolean; sessionAfter?: number; hasSession?: boolean; exchangeError?: Err; signOutThrows?: boolean } = {}) {
  const calls: Calls = { reset: [], update: [], signOut: [], exchange: [] };
  let polls = 0;
  const auth: AuthClientLike = {
    async resetPasswordForEmail(email, opts) { calls.reset.push({ email, redirectTo: opts?.redirectTo }); if (o.resetThrows) throw new Error("network"); return { data: {}, error: o.resetError ?? null }; },
    async updateUser({ password }) { if (o.updateThrows) throw new Error("network"); calls.update.push(password); return { data: {}, error: o.updateError ?? null }; },
    async getSession() { polls++; const ok = o.hasSession ?? (o.sessionAfter !== undefined && polls > o.sessionAfter); return { data: { session: ok ? { user: {} } : null } }; },
    async exchangeCodeForSession(code) { calls.exchange.push(code); return { data: {}, error: o.exchangeError ?? null }; },
    async signOut(opts) { if (o.signOutThrows) throw new Error("x"); calls.signOut.push(opts); return { error: null }; },
  };
  return { auth, calls, polls: () => polls };
}
const noWait = async () => undefined;

// ------------------------------------------------------------------ request
test("request: the reset email links back to THIS site's /reset-password (Preview, localhost, trailing slash)", async () => {
  for (const [origin, expected] of [[PREVIEW, `${PREVIEW}/reset-password`], ["http://localhost:3000", "http://localhost:3000/reset-password"], [`${PREVIEW}/`, `${PREVIEW}/reset-password`]] as const) {
    const f = fakeAuth();
    const r = await requestPasswordReset(f.auth, "  Someone@Example.com ", origin);
    assert.deepEqual(f.calls.reset, [{ email: "Someone@Example.com", redirectTo: expected }]);
    assert.equal(r.ok, true);
  }
  assert.equal(resetRedirectUrl(PREVIEW), `${PREVIEW}/reset-password`);
});

test("request: the answer never reveals whether the email has an account", async () => {
  const known = await requestPasswordReset(fakeAuth().auth, "known@example.com", PREVIEW);
  const unknown = await requestPasswordReset(fakeAuth({ resetError: { message: "User not found", status: 400, code: "user_not_found" } }).auth, "nobody@example.com", PREVIEW);
  const serverError = await requestPasswordReset(fakeAuth({ resetError: { message: "boom", status: 500 } }).auth, "x@example.com", PREVIEW);
  const offline = await requestPasswordReset(fakeAuth({ resetThrows: true }).auth, "x@example.com", PREVIEW);
  for (const r of [known, unknown, serverError, offline]) assert.deepEqual(r, { ok: true, message: NEUTRAL_REQUEST_MESSAGE });
  assert.ok(!/not found|no account|does not exist|unknown/i.test(NEUTRAL_REQUEST_MESSAGE));
});

test("request: a malformed email is rejected before anything is sent; a rate limit is reported plainly", async () => {
  for (const bad of ["", "   ", "no-at-sign", "a@b", "a b@c.com", "x".repeat(260) + "@e.com"]) {
    const f = fakeAuth();
    const r = await requestPasswordReset(f.auth, bad, PREVIEW);
    assert.equal(r.ok, false); assert.equal(f.calls.reset.length, 0, `nothing sent for ${JSON.stringify(bad.slice(0, 12))}`);
  }
  assert.equal(validateEmail("a@b.co"), null);
  const rl = await requestPasswordReset(fakeAuth({ resetError: { status: 429, code: "over_email_send_rate_limit", message: "email rate limit exceeded" } }).auth, "a@b.co", PREVIEW);
  assert.equal(rl.ok, false); assert.match(rl.message, /Too many requests/);
});

// ------------------------------------------------------------------ callback (what comes back in the URL)
test("callback: recovery tokens, PKCE code, errors and an empty visit are told apart", () => {
  assert.deepEqual(parseRecoveryUrl("#access_token=AAA&refresh_token=BBB&expires_in=3600&token_type=bearer&type=recovery", ""), { kind: "session" });
  assert.deepEqual(parseRecoveryUrl("", "?code=abcdefgh12345678"), { kind: "code", code: "abcdefgh12345678" });
  assert.deepEqual(parseRecoveryUrl("#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired", ""), { kind: "error", reason: "expired" });
  assert.deepEqual(parseRecoveryUrl("", "?error=access_denied&error_code=otp_expired"), { kind: "error", reason: "expired" });
  assert.deepEqual(parseRecoveryUrl("#error=server_error&error_description=Something+went+wrong", ""), { kind: "error", reason: "invalid" });
  assert.deepEqual(parseRecoveryUrl("#error=access_denied", ""), { kind: "error", reason: "invalid" });
  assert.deepEqual(parseRecoveryUrl("", ""), { kind: "none" });
  assert.deepEqual(parseRecoveryUrl("#access_token=AAA", ""), { kind: "none" }, "a token without a refresh token is not a usable link");
  assert.deepEqual(parseRecoveryUrl("", "?code=<script>"), { kind: "none" }, "a malformed code is ignored");
  assert.deepEqual(parseRecoveryUrl("#access_token=AAA&refresh_token=BBB&type=signup", ""), { kind: "none" }, "another link type is not a password reset");
});

test("callback: waits for the recovery session; expired, invalid, reused and empty links never produce one", async () => {
  const a = fakeAuth({ sessionAfter: 3 });
  assert.equal(await recoverySession(a.auth, { kind: "session" }, { wait: noWait }), true); assert.equal(a.polls(), 4);
  const never = fakeAuth({ sessionAfter: 999 });
  assert.equal(await recoverySession(never.auth, { kind: "session" }, { wait: noWait, tries: 5 }), false); assert.equal(never.polls(), 5, "gives up after the allowed tries");
  for (const link of [{ kind: "error", reason: "expired" }, { kind: "error", reason: "invalid" }, { kind: "none" }] as const) {
    const f = fakeAuth({ hasSession: true });
    assert.equal(await recoverySession(f.auth, link, { wait: noWait }), false, JSON.stringify(link)); assert.equal(f.polls(), 0);
  }
  const code = fakeAuth({ hasSession: true });
  assert.equal(await recoverySession(code.auth, { kind: "code", code: "abcdefgh12345678" }, { wait: noWait }), true); assert.deepEqual(code.calls.exchange, ["abcdefgh12345678"]);
  const used = fakeAuth({ hasSession: true, exchangeError: { message: "invalid flow state, no valid flow state found" } });
  assert.equal(await recoverySession(used.auth, { kind: "code", code: "abcdefgh12345678" }, { wait: noWait }), false, "a reused code is refused");
  assert.ok(LINK_EXPIRED_MESSAGE.includes("Request a new one") && LINK_INVALID_MESSAGE.includes("Request a new one"));
});

// ------------------------------------------------------------------ new password
test("validation: length, confirmation and the 72-byte limit", () => {
  assert.equal(validateNewPassword("abcdefgh", "abcdefgh"), null);
  assert.match(validateNewPassword("", "")!, /Enter a new password/);
  assert.match(validateNewPassword("short", "short")!, new RegExp(`at least ${MIN_PASSWORD}`));
  assert.match(validateNewPassword("abcdefgh", "")!, /Repeat/);
  assert.match(validateNewPassword("abcdefgh", "abcdefgH")!, /do not match/);
  assert.equal(validateNewPassword("a".repeat(MAX_PASSWORD), "a".repeat(MAX_PASSWORD)), null);
  assert.match(validateNewPassword("a".repeat(MAX_PASSWORD + 1), "a".repeat(MAX_PASSWORD + 1))!, /too long/);
  assert.match(validateNewPassword("é".repeat(40), "é".repeat(40))!, /too long/, "80 bytes even though only 40 characters");
});

test("reset: success changes the password once, ends the recovery session and returns to sign-in", async () => {
  const f = fakeAuth();
  const r = await completePasswordReset(f.auth, "new-pass-123", "new-pass-123");
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(f.calls.update, ["new-pass-123"]); assert.deepEqual(f.calls.signOut, [{ scope: "local" }]);
  const g = fakeAuth({ signOutThrows: true });
  assert.deepEqual(await completePasswordReset(g.auth, "new-pass-123", "new-pass-123"), { ok: true }, "the password is changed even if signing out fails");
});

test("reset: invalid input never reaches the server; server errors become useful messages", async () => {
  const f = fakeAuth();
  for (const [p, c] of [["short", "short"], ["abcdefgh", "abcdefgx"], ["abcdefgh", ""]] as const) { const r = await completePasswordReset(f.auth, p, c); assert.equal(r.ok, false); }
  assert.equal(f.calls.update.length, 0); assert.equal(f.calls.signOut.length, 0);
  const cases: Array<[Err, RegExp, boolean]> = [
    [{ code: "same_password", message: "New password should be different from the old password." }, /not used before/, false],
    [{ code: "weak_password", message: "Password is known to be weak" }, /too easy to guess/, false],
    [{ message: "Auth session missing!", status: 401 }, /expired or was already used/, true],
    [{ code: "session_not_found", message: "Session from session_id claim in JWT does not exist" }, /expired or was already used/, true],
    [{ status: 429, message: "rate limit" }, /Too many attempts/, false],
    [{ status: 500, message: "database error" }, /could not be changed/, false],
  ];
  for (const [err, re, expired] of cases) {
    const r = await completePasswordReset(fakeAuth({ updateError: err }).auth, "new-pass-123", "new-pass-123");
    assert.equal(r.ok, false); assert.match((r as { message: string }).message, re); assert.equal(Boolean((r as { expired?: boolean }).expired), expired);
  }
  const net = await completePasswordReset(fakeAuth({ updateThrows: true }).auth, "new-pass-123", "new-pass-123");
  assert.match((net as { message: string }).message, /Check your connection/);
});

test("end to end (fake accounts): request, open the link, set a password, sign in with the new one; the old link then fails", async () => {
  // A tiny model of the account: one password, one single-use recovery token.
  const acct = { password: "old-password-1", token: "T1" as string | null };
  const sessionFor = new Set<string>();
  const auth: AuthClientLike = {
    async resetPasswordForEmail(email) { void email; acct.token = "T2"; return { data: {}, error: null }; },
    async updateUser({ password }) { if (!sessionFor.size) return { data: {}, error: { message: "Auth session missing!", status: 401 } }; acct.password = password; return { data: {}, error: null }; },
    async getSession() { return { data: { session: sessionFor.size ? {} : null } }; },
    async exchangeCodeForSession() { return { data: {}, error: { message: "invalid flow state" } }; },
    async signOut() { sessionFor.clear(); return { error: null }; },
  };
  assert.equal((await requestPasswordReset(auth, "me@example.com", PREVIEW)).ok, true);
  // the user opens the link: supabase-js turns the fragment into a session and consumes the token
  const open = (token: string) => { if (acct.token === token) { acct.token = null; sessionFor.add(token); return "#access_token=AAA&refresh_token=BBB&type=recovery"; } return "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired"; };
  const hash = open("T2");
  assert.equal(await recoverySession(auth, parseRecoveryUrl(hash, ""), { wait: noWait }), true);
  assert.deepEqual(await completePasswordReset(auth, "brand-new-pass", "brand-new-pass"), { ok: true });
  assert.equal(acct.password, "brand-new-pass");
  // opening the same link again: reused
  const again = parseRecoveryUrl(open("T2"), "");
  assert.deepEqual(again, { kind: "error", reason: "expired" });
  assert.equal(await recoverySession(auth, again, { wait: noWait }), false);
  // and without a session the change is refused
  assert.equal((await completePasswordReset(auth, "another-pass-1", "another-pass-1") as { expired?: boolean }).expired, true);
  assert.equal(acct.password, "brand-new-pass");
});

// ------------------------------------------------------------------ show / hide password
test("show/hide: hidden by default; only the input type and the button label change", () => {
  assert.equal(passwordInputType(false), "password"); assert.equal(passwordInputType(true), "text");
  assert.equal(passwordToggleLabel(false), "Show password"); assert.equal(passwordToggleLabel(true), "Hide password");
});

// ------------------------------------------------------------------ wiring
const read =(p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
test("wiring: login has a visible Forgot password link; both pages use the shared helper and this site's own origin", () => {
  const login = read("app/login/page.tsx");
  assert.match(login, /mode === "in" && <Link className="linkbtn" href="\/forgot-password"[^>]*>Forgot password\?<\/Link>/);
  const forgot = read("app/forgot-password/page.tsx"), reset = read("app/reset-password/page.tsx");
  assert.match(forgot, /requestPasswordReset\(getSupabase\(\)\.auth, email, window\.location\.origin\)/);
  assert.match(reset, /parseRecoveryUrl\(window\.location\.hash, window\.location\.search\)/);
  assert.match(reset, /recoverySession\(sb\.auth, link\)/); assert.match(reset, /completePasswordReset\(getSupabase\(\)\.auth, password, confirm\)/);
  assert.match(reset, /window\.history\.replaceState\(null, "", window\.location\.pathname\)/, "tokens are removed from the address bar");
  assert.match(reset, /href="\/login"/); assert.match(reset, /href="\/forgot-password"/);
  for (const [name, src] of [["forgot", forgot], ["reset", reset], ["helper", read("lib/authFlow.ts")]] as const) {
    assert.ok(!/service_role|SERVICE_ROLE|adminClient|process\.env|console\./.test(src), `${name}: no service key, no env, no logging`);
  }
  assert.ok(!/localhost|vercel\.app/.test((forgot + reset + read("lib/authFlow.ts")).replace(/\/\/.*$/gm, "")), "no hard-coded host: the redirect comes from window.location.origin");
  assert.ok(!/(auth\/)?(login|forgot-password|reset-password)/.test(read("app/(app)/layout.tsx").replace(/router\.replace\("\/login"\)/, "")), "the pages live outside the signed-in shell");
  assert.match(read("lib/supabase.ts"), /createClient\(url, key\)/, "the existing client (implicit flow) is reused unchanged");
});

test("wiring: every password box (login, new, confirm) is a PasswordField with its own hidden-by-default toggle", () => {
  const pf = read("components/PasswordField.tsx"), login = read("app/login/page.tsx"), reset = read("app/reset-password/page.tsx");
  assert.match(pf, /const \[visible, setVisible\] = useState\(false\)/, "state is per field and starts hidden");
  assert.match(pf, /type=\{passwordInputType\(visible\)\}/);
  assert.match(pf, /<button type="button" className="pwtoggle" aria-label=\{action\} aria-pressed=\{visible\}/, "a real, labelled button that never submits the form");
  assert.match(pf, /onClick=\{\(\) => setVisible\(\(v\) => !v\)\}/);
  assert.match(pf, /<svg[\s\S]*aria-hidden="true"[\s\S]*<svg[\s\S]*aria-hidden="true"/, "two icons: eye and eye-off");
  assert.match(pf, /htmlFor=\{id\}/, "the label names the input, not the toggle");
  assert.ok(!/console\.|localStorage|sessionStorage|fetch\(|useEffect/.test(pf), "the component stores, logs and sends nothing");
  assert.equal((login.match(/<PasswordField /g) ?? []).length, 1); assert.equal((reset.match(/<PasswordField /g) ?? []).length, 2);
  assert.ok(!/type="password"/.test(login + reset), "no bare password inputs left");
  assert.match(reset, /label="Repeat the new password" value=\{confirm\} onChange=\{setConfirm\}/);
  assert.match(read("app/globals.css"), /\.pwtoggle\{[^}]*width:44px;height:44px/, "44 px tap target");
});

// ------------------------------------------------------------------ Profile -> Change password (signed in)
import { changePassword, type PasswordChangeClientLike } from "../lib/authFlow.ts";
function fakeChange(o: { signInError?: { message?: string; status?: number; code?: string } | null; signInThrows?: boolean; updateError?: { message?: string; code?: string; status?: number } | null; updateThrows?: boolean; signOutThrows?: boolean } = {}) {
  const calls = { signIn: [] as Array<{ email: string; password: string }>, update: [] as string[], signOut: [] as unknown[] };
  const sb: PasswordChangeClientLike = {
    async signInWithPassword(c) { if (o.signInThrows) throw new Error("net"); calls.signIn.push(c); return { data: {}, error: o.signInError ?? null }; },
    async updateUser({ password }) { if (o.updateThrows) throw new Error("net"); calls.update.push(password); return { data: {}, error: o.updateError ?? null }; },
    async signOut(opts) { if (o.signOutThrows) throw new Error("x"); calls.signOut.push(opts); return { error: null }; },
  };
  return { sb, calls };
}
test("change password: checks the current password first, applies the same rules as the reset page, signs out other devices only", async () => {
  const f = fakeChange();
  const r = await changePassword(f.sb, "me@example.com", "old-password-1", "new-password-22", "new-password-22");
  assert.equal(r.ok, true); assert.match(r.message, /changed/);
  assert.deepEqual(f.calls.signIn, [{ email: "me@example.com", password: "old-password-1" }]);
  assert.deepEqual(f.calls.update, ["new-password-22"]); assert.deepEqual(f.calls.signOut, [{ scope: "others" }], "this device stays signed in");
  assert.deepEqual(await changePassword(fakeChange({ signOutThrows: true }).sb, "me@example.com", "old-password-1", "new-password-22", "new-password-22"), { ok: true, message: r.message }, "the change stands even if signing out other devices fails");
});

test("change password: nothing is sent for invalid input; a wrong current password never reaches the update", async () => {
  const f = fakeChange();
  const cases: Array<[string | null, string, string, string, RegExp]> = [
    [null, "old-password-1", "new-password-22", "new-password-22", /email is not available/], ["me@example.com", "", "new-password-22", "new-password-22", /current password/],
    ["me@example.com", "old-password-1", "short", "short", /at least 8/], ["me@example.com", "old-password-1", "new-password-22", "new-password-23", /do not match/],
    ["me@example.com", "old-password-1", "old-password-1", "old-password-1", /not used before/], ["me@example.com", "old-password-1", "a".repeat(80), "a".repeat(80), /too long/],
  ];
  for (const [em, cur, n, c, re] of cases) { const r = await changePassword(f.sb, em, cur, n, c); assert.equal(r.ok, false); assert.match((r as { message: string }).message, re); }
  assert.equal(f.calls.signIn.length, 0); assert.equal(f.calls.update.length, 0); assert.equal(f.calls.signOut.length, 0);
  const wrong = fakeChange({ signInError: { message: "Invalid login credentials", status: 400, code: "invalid_credentials" } });
  const r = await changePassword(wrong.sb, "me@example.com", "bad-current", "new-password-22", "new-password-22");
  assert.deepEqual(r, { ok: false, message: "The current password is not correct." }); assert.equal(wrong.calls.update.length, 0);
  assert.match((await changePassword(fakeChange({ signInError: { status: 429, message: "rate limit" } }).sb, "me@example.com", "x-current-1", "new-password-22", "new-password-22") as { message: string }).message, /Too many attempts/);
  assert.match((await changePassword(fakeChange({ signInThrows: true }).sb, "me@example.com", "x-current-1", "new-password-22", "new-password-22") as { message: string }).message, /connection/);
});

test("change password: server refusals become useful messages (same password, weak, session, network)", async () => {
  const cases: Array<[{ message?: string; code?: string; status?: number } | null, RegExp]> = [
    [{ code: "same_password", message: "New password should be different from the old password." }, /not used before/], [{ code: "weak_password", message: "weak" }, /too easy to guess/],
    [{ status: 401, message: "Auth session missing!" }, /Sign in again/], [{ status: 429, message: "rate limit" }, /Too many attempts/], [{ status: 500, message: "boom" }, /could not be changed/],
  ];
  for (const [err, re] of cases) { const r = await changePassword(fakeChange({ updateError: err }).sb, "me@example.com", "old-password-1", "new-password-22", "new-password-22"); assert.equal(r.ok, false); assert.match((r as { message: string }).message, re); }
  assert.match((await changePassword(fakeChange({ updateThrows: true }).sb, "me@example.com", "old-password-1", "new-password-22", "new-password-22") as { message: string }).message, /connection/);
});

test("wiring: Profile -> Account has the Change password control built on the shared helpers and password fields", () => {
  const card = read("components/ChangePasswordCard.tsx"), page = read("app/(app)/profile/page.tsx");
  assert.match(page, /<ChangePasswordCard email=\{session\?\.user\.email\} \/>/);
  assert.match(card, /changePassword\(getSupabase\(\)\.auth, email, current, next, confirm\)/);
  assert.equal((card.match(/<PasswordField /g) ?? []).length, 3, "current, new and confirm, each with show/hide");
  assert.match(card, /autoComplete="current-password"/); assert.ok(!/type="password"/.test(card));
  assert.ok(!/console\.|localStorage|sessionStorage|SERVICE_ROLE|adminClient/.test(card + read("lib/authFlow.ts")), "no logging, storage or service key");
  assert.match(card, /setCurrent\(""\); setNext\(""\); setConfirm\(""\)/, "typed passwords are cleared after use");
});
