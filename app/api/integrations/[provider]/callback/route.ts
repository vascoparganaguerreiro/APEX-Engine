import { exchangeIntervalsCode, isOAuthProvider, oauthConfig } from "@/lib/integrations/configs";
import { checkState, clearStateCookie, cookieName, readCookie, sha256, type StoredState } from "@/lib/integrations/oauth";
import { adminClient, cryptoOps, integrationError } from "@/lib/integrations/server";
import { saveTokens } from "@/lib/integrations/tokenStore";
import { markConnected } from "@/lib/integrations/syncState";
import { exchangeCode } from "@/lib/integrations/whoop";

export const runtime = "nodejs";

/** GET ?code&state (or ?error) from the provider. The user is identified ONLY by the server-side state row, which is consumed
 *  atomically (delete ... returning) and must match this browser's HttpOnly nonce cookie. Tokens never reach the browser or the URL.
 *  Always redirects back to /integrations with a short result code. */
export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }): Promise<Response> {
  const { provider } = await ctx.params;
  if (!isOAuthProvider(provider)) return new Response("Unknown provider.", { status: 404 });
  const cfg = oauthConfig(provider, process.env);
  if (!cfg) return new Response("Not configured.", { status: 503 });

  const base = new URL(cfg.redirectUri).origin;                       // the registered origin, never the request's Host header
  const secure = base.startsWith("https:");
  const back = (result: string) => new Response(null, { status: 303, headers: {
    Location: `${base}/integrations?provider=${provider}&result=${result}`, "Set-Cookie": clearStateCookie(provider, secure), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  } });

  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "", code = url.searchParams.get("code") ?? "";
  if (!state || state.length > 128) return back("invalid_state");

  try {
    const db = adminClient();
    const { data, error } = await db.from("oauth_states").delete().eq("state_hash", sha256(state)).select("state_hash,user_id,provider,nonce_hash,expires_at");
    if (error) return back("server_error");
    const row = (Array.isArray(data) ? data[0] : null) as StoredState | null;
    const check = checkState(row, provider, readCookie(req.headers.get("cookie"), cookieName(provider)), new Date());
    if (!check.ok) return back(check.reason === "expired" ? "expired" : "invalid_state");
    if (url.searchParams.get("error")) return back("denied");            // the user declined on the provider's page
    if (!code) return back("invalid_state");

    const tokens = provider === "whoop" ? await exchangeCode(cfg, code) : await exchangeIntervalsCode(cfg, code);
    await saveTokens(db, cryptoOps, check.userId, provider, tokens);
    await markConnected(db, check.userId, provider, "direct", { externalUserId: tokens.externalUserId, scopes: tokens.scopes });
    if (provider === "intervals") {
      // Keep the existing Intervals.icu screens working: they look at intervals_connections (no secret is stored there).
      const id = tokens.externalUserId && /^i?\d{1,12}$/.test(tokens.externalUserId) ? tokens.externalUserId : "0";
      const prev = await db.from("intervals_connections").select("user_id").eq("user_id", check.userId).maybeSingle();
      if (!prev.data) await db.from("intervals_connections").insert({ user_id: check.userId, athlete_id: id, api_key: null });
    }
    return back("connected");
  } catch (e) {
    const x = integrationError(e);
    console.error("integration callback failed", provider, x.status);    // no tokens, codes or bodies are logged
    return back(x.reauth ? "rejected" : "server_error");
  }
}
