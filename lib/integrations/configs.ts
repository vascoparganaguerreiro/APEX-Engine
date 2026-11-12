// Server-side OAuth configuration per provider, read from server-only environment variables. Pure: env is passed in.
// Never fabricates credentials: a provider without all of its variables is simply "not configured".
import { parseTokenResponse, postToken, type OAuthConfig, type TokenSet } from "./oauth.ts";
import { whoopConfig } from "./whoop.ts";

export type OAuthProvider = "whoop" | "intervals";
export const OAUTH_PROVIDERS: readonly OAuthProvider[] = ["whoop", "intervals"];
export const isOAuthProvider = (p: unknown): p is OAuthProvider => p === "whoop" || p === "intervals";

/** Intervals.icu OAuth (needs an APPROVED app, applied for at https://intervals.icu/oauth/apply). Scopes are comma-separated;
 *  tokens do not expire and there are no refresh tokens; DELETE /api/v1/disconnect-app revokes. */
export function intervalsOAuthConfig(env: Record<string, string | undefined>): OAuthConfig | null {
  const clientId = env.INTERVALS_CLIENT_ID?.trim(), clientSecret = env.INTERVALS_CLIENT_SECRET?.trim(), redirectUri = env.INTERVALS_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { provider: "intervals", authorizeUrl: "https://intervals.icu/oauth/authorize", tokenUrl: "https://intervals.icu/api/oauth/token", clientId, clientSecret, redirectUri,
    scopes: ["ACTIVITY:READ", "WELLNESS:READ"], scopeSeparator: ",", stateLength: 32 };
}

export function oauthConfig(p: OAuthProvider, env: Record<string, string | undefined>): OAuthConfig | null {
  return p === "whoop" ? whoopConfig(env) : intervalsOAuthConfig(env);
}

export async function exchangeIntervalsCode(c: OAuthConfig, code: string, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<TokenSet> {
  const j = await postToken(c.tokenUrl, { client_id: c.clientId, client_secret: c.clientSecret, code }, fetchImpl);
  return parseTokenResponse(j, now, ",");
}

export async function revokeIntervals(token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try { const r = await fetchImpl("https://intervals.icu/api/v1/disconnect-app", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }); return r.ok || r.status === 401; }
  catch { return false; }
}

/** Names (never values) of the server variables that are set, for the Connectivity Centre. */
export const CONFIG_ENV = ["WHOOP_CLIENT_ID", "WHOOP_CLIENT_SECRET", "WHOOP_REDIRECT_URI", "INTERVALS_CLIENT_ID", "INTERVALS_CLIENT_SECRET", "INTERVALS_REDIRECT_URI"] as const;
export const configuredNames = (env: Record<string, string | undefined>) => CONFIG_ENV.filter((k) => !!env[k]?.trim());
