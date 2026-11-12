import { authUser } from "@/lib/serverAuth";
import { oauthConfig } from "@/lib/integrations/configs";
import { adminClient, cryptoOps, integrationError, missingTable } from "@/lib/integrations/server";
import { runWhoopSync } from "@/lib/integrations/whoopSync";

export const runtime = "nodejs";
export const maxDuration = 60;

/** POST -> sync now (WHOOP). Intervals.icu keeps its own route, /api/intervals/sync. */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }): Promise<Response> {
  try {
    const { provider } = await ctx.params;
    if (provider !== "whoop") return Response.json({ error: "Sync is not available for this provider here." }, { status: 404 });
    const { sb, uid } = await authUser(req);
    const cfg = oauthConfig("whoop", process.env);
    if (!cfg) return Response.json({ error: "WHOOP is not set up on the server yet." }, { status: 503 });
    const r = await runWhoopSync({ admin: adminClient(), user: sb, ops: cryptoOps, cfg, uid });
    return Response.json(r, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (missingTable(e)) return Response.json({ error: "Connections aren't available right now. Please try again later." }, { status: 503 });
    const x = integrationError(e);
    if (x.status >= 500) console.error("integration sync failed", x.status);
    return Response.json({ error: x.message, reauth: x.reauth, retryAt: x.retryAt }, { status: x.status });
  }
}
