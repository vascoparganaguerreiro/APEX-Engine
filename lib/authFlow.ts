// Forgot / reset password. Pure logic (no React, no window, no Supabase import) so every step is unit-testable; the pages only wire it up.
//
// How it works with this project's Supabase client (implicit flow, detectSessionInUrl on, see lib/supabase.ts):
//   1. /forgot-password calls resetPasswordForEmail(email, { redirectTo: <this site>/reset-password }). The answer is ALWAYS the same neutral
//      message, so nobody can learn whether an email has an account.
//   2. The email link goes through Supabase and comes back to /reset-password with the recovery session in the URL fragment
//      (#access_token=...&type=recovery) or, if the project is ever switched to PKCE, as ?code=... A bad / expired / already used link
//      comes back with #error=...&error_code=otp_expired (or similar).
//   3. supabase-js reads the session from the URL by itself; /reset-password waits for it, then calls updateUser({ password }).
//   4. After success the recovery session is signed out and the user signs in again with the new password.
// The URL is never logged. Passwords are never stored or echoed.

export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 72;                         // bcrypt only uses the first 72 bytes: longer passwords would silently be cut
export const RESET_PATH = "/reset-password";
export const FORGOT_PATH = "/forgot-password";

/** Shown after every reset request, whatever the address. It must never differ between known and unknown emails. */
export const NEUTRAL_REQUEST_MESSAGE = "If an account exists for that email, we have sent a link to reset the password. Check your inbox (and spam folder). The link works once and expires soon.";

/** The address Supabase sends the user back to. Must be listed under Authentication → URL Configuration → Redirect URLs. */
export const resetRedirectUrl = (origin: string) => `${origin.replace(/\/+$/, "")}${RESET_PATH}`;

// ------------------------------------------------------------------ show / hide password (components/PasswordField.tsx)
/** Hidden unless the user chose to show it. Only the input type changes; the typed text is never touched. */
export const passwordInputType = (visible: boolean): "text" | "password" => (visible ? "text" : "password");
export const passwordToggleLabel = (visible: boolean): "Show password" | "Hide password" => (visible ? "Hide password" : "Show password");

// ------------------------------------------------------------------ validation
export function validateEmail(email: string): string | null {
  const e = email.trim();
  if (!e) return "Enter your email address.";
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return "That does not look like an email address.";
  return null;
}

/** Length and confirmation. Counted in bytes (UTF-8) because that is what the password hash uses. */
export function validateNewPassword(password: string, confirm: string): string | null {
  if (!password) return "Enter a new password.";
  if (password.length < MIN_PASSWORD) return `The password must have at least ${MIN_PASSWORD} characters.`;
  if (new TextEncoder().encode(password).length > MAX_PASSWORD) return `The password is too long (at most ${MAX_PASSWORD} bytes).`;
  if (!confirm) return "Repeat the new password to confirm it.";
  if (password !== confirm) return "The two passwords do not match.";
  return null;
}

// ------------------------------------------------------------------ minimal view of the Supabase auth client (so tests need no network)
interface AuthErr { message?: string; code?: string; status?: number; name?: string }
export interface AuthClientLike {
  resetPasswordForEmail(email: string, opts?: { redirectTo?: string }): PromiseLike<{ data: unknown; error: AuthErr | null }>;
  updateUser(attrs: { password: string }): PromiseLike<{ data: unknown; error: AuthErr | null }>;
  getSession(): PromiseLike<{ data: { session: unknown | null }; error?: AuthErr | null }>;
  exchangeCodeForSession(code: string): PromiseLike<{ data: unknown; error: AuthErr | null }>;
  signOut(opts?: { scope?: "local" | "global" | "others" }): PromiseLike<{ error: AuthErr | null }>;
}

// ------------------------------------------------------------------ step 1: request
export type RequestResult = { ok: true; message: string } | { ok: false; message: string };
/** Always neutral about the account. Only the user's own mistakes (empty or malformed email) and a rate limit are reported. */
export async function requestPasswordReset(sb: Pick<AuthClientLike, "resetPasswordForEmail">, email: string, origin: string): Promise<RequestResult> {
  const bad = validateEmail(email);
  if (bad) return { ok: false, message: bad };
  try {
    const { error } = await sb.resetPasswordForEmail(email.trim(), { redirectTo: resetRedirectUrl(origin) });
    if (error && (error.status === 429 || /rate.?limit|too many/i.test(`${error.code ?? ""} ${error.message ?? ""}`))) {
      return { ok: false, message: "Too many requests. Please wait a few minutes before trying again." };
    }
    // Any other outcome, including "user not found" style answers and server errors, looks exactly like success.
    return { ok: true, message: NEUTRAL_REQUEST_MESSAGE };
  } catch {
    return { ok: true, message: NEUTRAL_REQUEST_MESSAGE };
  }
}

// ------------------------------------------------------------------ step 2: what came back in the URL
export type LinkState =
  | { kind: "session" }                                                       // tokens in the fragment: supabase-js turns them into a session
  | { kind: "code"; code: string }                                           // PKCE style
  | { kind: "error"; reason: "expired" | "invalid" }
  | { kind: "none" };                                                        // opened without a link
export const LINK_EXPIRED_MESSAGE = "This reset link has expired or was already used. Request a new one.";
export const LINK_INVALID_MESSAGE = "This reset link is not valid. Request a new one.";
export const linkErrorMessage = (reason: "expired" | "invalid") => (reason === "expired" ? LINK_EXPIRED_MESSAGE : LINK_INVALID_MESSAGE);

export function parseRecoveryUrl(hash: string, search: string): LinkState {
  const h = new URLSearchParams(hash.replace(/^#/, "")), q = new URLSearchParams(search.replace(/^\?/, ""));
  const code = (h.get("error_code") ?? q.get("error_code") ?? "").toLowerCase();
  const err = h.get("error") ?? q.get("error") ?? h.get("error_description") ?? q.get("error_description");
  if (err || code) return { kind: "error", reason: code === "otp_expired" || /expired|already|used/i.test(`${h.get("error_description") ?? q.get("error_description") ?? ""}`) ? "expired" : "invalid" };
  if (h.get("access_token") && h.get("refresh_token") && (h.get("type") ?? "recovery") === "recovery") return { kind: "session" };
  const c = q.get("code");
  if (c && /^[A-Za-z0-9._\-]{8,200}$/.test(c)) return { kind: "code", code: c };
  return { kind: "none" };
}

/** Wait for a recovery session. Resolves true as soon as one exists, false when the link did not produce one in time. */
export async function recoverySession(sb: Pick<AuthClientLike, "getSession" | "exchangeCodeForSession">, link: LinkState,
  o: { wait?: (ms: number) => Promise<void>; tries?: number; stepMs?: number } = {}): Promise<boolean> {
  if (link.kind === "error" || link.kind === "none") return false;
  if (link.kind === "code") {
    try { const { error } = await sb.exchangeCodeForSession(link.code); if (error) return false; } catch { return false; }
  }
  const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < (o.tries ?? 12); i++) {
    try { const { data } = await sb.getSession(); if (data.session) return true; } catch { /* keep waiting */ }
    await wait(o.stepMs ?? 250);
  }
  return false;
}

// ------------------------------------------------------------------ step 3: set the new password
export type ResetResult = { ok: true } | { ok: false; message: string; expired?: boolean };
/** The answer of a failed updateUser({ password }), as a message. Shared by the reset page and Profile → Change password. */
function updateErrorResult(error: AuthErr): { ok: false; message: string; expired?: boolean } {
  const t = `${error.code ?? ""} ${error.message ?? ""}`;
  if (/same_password|different from the old/i.test(t)) return { ok: false, message: "Choose a password you have not used before." };
  if (/weak_password|weak|pwned|leaked|easy to guess/i.test(t)) return { ok: false, message: "That password is too easy to guess. Choose a longer or less common one." };
  if (/session|jwt|not authenticated|refresh_token|expired|invalid/i.test(t) || error.status === 401 || error.status === 403) {
    return { ok: false, message: LINK_EXPIRED_MESSAGE, expired: true };
  }
  if (error.status === 429 || /rate.?limit|too many/i.test(t)) return { ok: false, message: "Too many attempts. Please wait a few minutes and try again." };
  return { ok: false, message: "The password could not be changed. Please try again." };
}

// ------------------------------------------------------------------ Profile → Change password (signed in)
export interface PasswordChangeClientLike {
  signInWithPassword(c: { email: string; password: string }): PromiseLike<{ data: unknown; error: AuthErr | null }>;
  updateUser(attrs: { password: string }): PromiseLike<{ data: unknown; error: AuthErr | null }>;
  signOut(opts?: { scope?: "local" | "global" | "others" }): PromiseLike<{ error: AuthErr | null }>;
}
export type ChangeResult = { ok: true; message: string } | { ok: false; message: string };
/** Change the password of the signed-in account. The CURRENT password is checked first (a fresh sign-in), so an open session alone cannot
 *  change it; the new password follows the same rules as the reset page; afterwards the account's other sessions are signed out and this
 *  device stays signed in. Passwords are never stored or logged. */
export async function changePassword(sb: PasswordChangeClientLike, email: string | null | undefined, current: string, next: string, confirm: string): Promise<ChangeResult> {
  if (!email) return { ok: false, message: "Your account email is not available. Sign in again and retry." };
  if (!current) return { ok: false, message: "Enter your current password." };
  const bad = validateNewPassword(next, confirm);
  if (bad) return { ok: false, message: bad };
  if (next === current) return { ok: false, message: "Choose a password you have not used before." };
  try {
    const { error } = await sb.signInWithPassword({ email, password: current });
    if (error) {
      if (error.status === 429 || /rate.?limit|too many/i.test(`${error.code ?? ""} ${error.message ?? ""}`)) return { ok: false, message: "Too many attempts. Please wait a few minutes and try again." };
      return { ok: false, message: "The current password is not correct." };
    }
  } catch { return { ok: false, message: "Could not reach the server. Check your connection and try again." }; }
  let error: AuthErr | null;
  try { ({ error } = await sb.updateUser({ password: next })); } catch { return { ok: false, message: "Could not reach the server. Check your connection and try again." }; }
  if (error) { const r = updateErrorResult(error); return { ok: false, message: r.expired ? "Your session could not be confirmed. Sign in again and retry." : r.message }; }
  try { await sb.signOut({ scope: "others" }); } catch { /* the password is already changed */ }
  return { ok: true, message: "Your password has been changed. Other devices have been signed out." };
}

export async function completePasswordReset(sb: Pick<AuthClientLike, "updateUser" | "signOut">, password: string, confirm: string): Promise<ResetResult> {
  const bad = validateNewPassword(password, confirm);
  if (bad) return { ok: false, message: bad };
  let error: AuthErr | null;
  try { ({ error } = await sb.updateUser({ password })); } catch { return { ok: false, message: "Could not reach the server. Check your connection and try again." }; }
  if (error) return updateErrorResult(error);
  // The recovery session has done its job: end it on this device so the user signs in normally with the new password.
  try { await sb.signOut({ scope: "local" }); } catch { /* the password is already changed */ }
  return { ok: true };
}
