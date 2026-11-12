import { authUser } from "@/lib/serverAuth";
import { isOAuthProvider, oauthConfig } from "@/lib/integrations/configs";
import { STATE_TTL_MS, authorizeUrl, randomNonce, randomState, sha256, stateCookie } from "@/lib/integrations/oauth";
import { adminClient, integrationError, missingTable } from "@/lib/integrations/server";

export const runtime = "nodejs";

/** POST -> { url }. Starts an OAuth connection for the signed-in user. The state is stored hashed and server-side, bound to this
 *  browser through an HttpOnly cookie nonce; the client then navigates to `url`. */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }): Promise<Response> {
  try {
    const { provider } = await ctx.params;
    if (!isOAuthProvider(provider)) return Response.json({ error: "Unknown provider." }, { status: 404 });
    const { uid } = await authUser(req);
    const cfg = oauthConfig(provider, process.env);
    if (!cfg) return Response.json({ error: "This connection is not set up on the server yet (app registration pending)." }, { status: 503 });

    const db = adminClient(), now = Date.now();
    await db.from("oauth_states").delete().lt("expires_at", new Date(now).toISOString());          // housekeeping
    await db.from("oauth_states").delete().eq("user_id", uid).eq("provider", provider);             // one pending flow per provider
    const state = randomState(cfg.stateLength), nonce = randomNonce();
    const { error } = await db.from("oauth_states").insert({ state_hash: sha256(state), user_id: uid, provider, nonce_hash: sha256(nonce), expires_at: new Date(now + STATE_TTL_MS).toISOString() });
    if (error) {
      if (missingTable(error)) return Response.json({ error: "Connections need a database update (migration 14) that has not been applied yet." }, { status: 503 });
      return Response.json({ error: "Could not start the connection." }, { status: 500 });
    }
    const secure = new URL(cfg.redirectUri).protocol === "https:";
    return Response.json({ url: authorizeUrl(cfg, state) }, { headers: { "Set-Cookie": stateCookie(provider, nonce, secure), "Cache-Control": "no-store" } });
  } catch (e) {
    const x = integrationError(e);
    return Response.json({ error: x.message }, { status: x.status });
  }
}
