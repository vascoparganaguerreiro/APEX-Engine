import { authUser } from "@/lib/serverAuth";
import { isOAuthProvider, oauthConfig, revokeIntervals } from "@/lib/integrations/configs";
import { disconnectProvider } from "@/lib/integrations/disconnect";
import { adminClient, cryptoOps, integrationError, missingTable } from "@/lib/integrations/server";
import { saveSettings } from "@/lib/integrations/syncState";
import { validAccessToken } from "@/lib/integrations/tokenStore";
import { refreshTokens, revoke as revokeWhoop } from "@/lib/integrations/whoop";

export const runtime = "nodejs";

const fail = (e: unknown) => {
  if (missingTable(e)) return Response.json({ error: "Connections aren't available right now. Please try again later." }, { status: 503 });
  const x = integrationError(e);
  return Response.json({ error: x.message }, { status: x.status });
};

/** DELETE -> revoke at the provider (best effort), delete the stored tokens and mark the connection disconnected. Data already
 *  imported is kept. For Intervals.icu this removes only the OAuth connection; the API-key connection has its own route. */
export async function DELETE(req: Request, ctx: { params: Promise<{ provider: string }> }): Promise<Response> {
  try {
    const { provider } = await ctx.params;
    if (!isOAuthProvider(provider)) return Response.json({ error: "Unknown provider." }, { status: 404 });
    const { uid } = await authUser(req);
    const admin = adminClient(), cfg = oauthConfig(provider, process.env);
    const r = await disconnectProvider({
      admin, ops: cryptoOps, uid, provider,
      revoke: provider === "whoop" ? (t) => revokeWhoop(t) : (t) => revokeIntervals(t),
      freshToken: provider === "whoop" && cfg ? () => validAccessToken(admin, cryptoOps, uid, "whoop", (rt) => refreshTokens(cfg, rt)) : undefined,
    });
    return Response.json({ ok: true, revoked: r.revoked });
  } catch (e) { return fail(e); }
}

/** PATCH { fill_daily?, import_workouts? } -> per-connection choices. Both default to off. */
export async function PATCH(req: Request, ctx: { params: Promise<{ provider: string }> }): Promise<Response> {
  try {
    const { provider } = await ctx.params;
    if (provider !== "whoop") return Response.json({ error: "No settings for this provider." }, { status: 404 });
    const { uid } = await authUser(req);
    const body = (await req.json().catch(() => null)) as { fill_daily?: unknown; import_workouts?: unknown } | null;
    const patch = {
      ...(typeof body?.fill_daily === "boolean" ? { fill_daily: body.fill_daily } : {}),
      ...(typeof body?.import_workouts === "boolean" ? { import_workouts: body.import_workouts } : {}),
    };
    return Response.json({ ok: true, settings: await saveSettings(adminClient(), uid, provider, patch) });
  } catch (e) { return fail(e); }
}
