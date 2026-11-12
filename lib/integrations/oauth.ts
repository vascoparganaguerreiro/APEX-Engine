// OAuth 2.0 authorization-code helpers. Pure (node:crypto only), so every security rule is unit-tested.
//
// CSRF / mix-up protection without relying on the provider's short state:
//   * /start (authenticated with the user's Supabase token) creates `state` and a 256-bit `nonce`.
//   * The server stores { sha256(state), user_id, provider, sha256(nonce), expires } in oauth_states (server-only table).
//   * The nonce goes to the browser ONLY as an HttpOnly, SameSite=Lax cookie scoped to /api/integrations.
//   * /callback accepts the code only if the state exists, is unused, unexpired, for the same provider, AND the cookie's nonce matches.
//     The state row is consumed (deleted) before the code is exchanged, so a replay fails.
// WHOOP requires an 8-character state when the client generates it; the nonce supplies the entropy.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const STATE_TTL_MS = 10 * 60_000;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function randomState(length = 8): string {
  const out: string[] = [];
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) { if (b < 248 && out.length < length) out.push(ALPHABET[b % 62]); }   // 248 = 4*62: no modulo bias
  }
  return out.join("");
}
export const randomNonce = () => randomBytes(32).toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("base64url");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// PKCE (RFC 7636), used by providers that support it.
export const pkceVerifier = () => randomBytes(48).toString("base64url");
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

export interface OAuthConfig {
  provider: string; authorizeUrl: string; tokenUrl: string; clientId: string; clientSecret: string; redirectUri: string;
  scopes: readonly string[]; scopeSeparator: " " | ","; stateLength: number;
}

export function authorizeUrl(c: OAuthConfig, state: string, extra: Record<string, string> = {}): string {
  const u = new URL(c.authorizeUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", c.clientId);
  u.searchParams.set("redirect_uri", c.redirectUri);
  u.searchParams.set("scope", c.scopes.join(c.scopeSeparator));
  u.searchParams.set("state", state);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.toString();
}

export const COOKIE_PATH = "/api/integrations";
export const cookieName = (provider: string) => `apex_oauth_${provider}`;
export function stateCookie(provider: string, nonce: string, secure: boolean): string {
  return `${cookieName(provider)}=${nonce}; Path=${COOKIE_PATH}; Max-Age=${STATE_TTL_MS / 1000}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}
export const clearStateCookie = (provider: string, secure: boolean) => `${cookieName(provider)}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
export function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

export interface StoredState { state_hash: string; user_id: string; provider: string; nonce_hash: string; expires_at: string; code_verifier?: string | null }
export type StateCheck = { ok: true; userId: string } | { ok: false; reason: "missing" | "expired" | "provider" | "browser" };

/** Validate a callback against the stored state row (already looked up by sha256(state)). */
export function checkState(row: StoredState | null, provider: string, cookieNonce: string | null, now: Date): StateCheck {
  if (!row) return { ok: false, reason: "missing" };
  if (Date.parse(row.expires_at) <= now.getTime()) return { ok: false, reason: "expired" };
  if (row.provider !== provider) return { ok: false, reason: "provider" };
  if (!cookieNonce || !safeEqual(sha256(cookieNonce), row.nonce_hash)) return { ok: false, reason: "browser" };
  return { ok: true, userId: row.user_id };
}

// ------------------------------------------------------------------ token responses
export interface TokenSet { accessToken: string; refreshToken: string | null; expiresAt: string | null; scopes: string[]; externalUserId: string | null }
export class OAuthError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = "OAuthError"; this.status = status; this.code = code; }
}

/** Parse a token endpoint response. Never includes token values in errors. */
export function parseTokenResponse(j: unknown, now: Date, separator: " " | ","): TokenSet {
  const o = (j && typeof j === "object" ? j : {}) as Record<string, unknown>;
  const access = typeof o.access_token === "string" ? o.access_token : "";
  if (!access || access.length > 8192) throw new OAuthError(502, "bad_token_response", "The provider returned no usable access token.");
  const refresh = typeof o.refresh_token === "string" && o.refresh_token ? o.refresh_token : null;
  const ttl = typeof o.expires_in === "number" && Number.isFinite(o.expires_in) && o.expires_in > 0 ? o.expires_in : null;
  const scopes = typeof o.scope === "string" ? o.scope.split(separator).map((s) => s.trim()).filter(Boolean) : [];
  const athlete = o.athlete && typeof o.athlete === "object" ? (o.athlete as Record<string, unknown>).id : undefined;
  const ext = typeof athlete === "string" || typeof athlete === "number" ? String(athlete) : null;
  return { accessToken: access, refreshToken: refresh, expiresAt: ttl === null ? null : new Date(now.getTime() + ttl * 1000).toISOString(), scopes, externalUserId: ext };
}

/** True when the token should be refreshed before use (60 s safety margin). Tokens without expiry never need it. */
export const needsRefresh = (expiresAt: string | null, now: Date) => expiresAt !== null && Date.parse(expiresAt) - now.getTime() < 60_000;

/** POST form data to a token endpoint. Errors carry fixed messages only. */
export async function postToken(url: string, form: Record<string, string>, fetchImpl: typeof fetch, headers: Record<string, string> = {}): Promise<unknown> {
  let r: Response;
  try {
    r = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...headers }, body: new URLSearchParams(form).toString() });
  } catch { throw new OAuthError(502, "unreachable", "Could not reach the provider."); }
  const j = await r.json().catch(() => null);
  if (r.status === 400 || r.status === 401) {
    const code = j && typeof j === "object" && typeof (j as { error?: unknown }).error === "string" ? String((j as { error: string }).error).slice(0, 40) : "invalid_grant";
    throw new OAuthError(401, code, "The provider rejected the authorization. Connect again.");
  }
  if (r.status === 429) throw new OAuthError(429, "rate_limited", "The provider's rate limit was reached. Try again shortly.");
  if (!r.ok) throw new OAuthError(502, "provider_error", `The provider answered ${r.status}.`);
  return j;
}
