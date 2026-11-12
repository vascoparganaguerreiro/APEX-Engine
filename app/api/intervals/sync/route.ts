import { IntervalsError } from "@/lib/intervals";
import { safeText } from "@/lib/userError";
import { authUser, errorResponse } from "@/lib/serverAuth";
import { getConnection, markSynced } from "@/lib/serverConnections";
import { adminClient, cryptoOps, integrationError } from "@/lib/integrations/server";
import { loadTokens } from "@/lib/integrations/tokenStore";
import { runIntervalsSync } from "@/lib/integrations/intervalsSync";
import type { IntervalsAuth } from "@/lib/integrations/intervalsGateway";
import { SyncBusy, SyncDeferred } from "@/lib/integrations/syncState";

export const runtime = "nodejs";
export const maxDuration = 60;

/** POST { days? }.
 *  Without `days`: incremental, from the last successful sync minus 3 days (first sync: 120 days).
 *  With `days` (1-180): a full re-read of that range.
 *  Wellness goes to daily_metrics through 06's provenance rules; activities upsert on (user_id, source, external_id); every wellness
 *  field is also kept as an observation with origin "unknown" (Intervals.icu does not say which device measured it). */
export async function POST(req: Request): Promise<Response> {
  try {
    const { sb, uid } = await authUser(req);
    const body = (await req.json().catch(() => null)) as { days?: unknown } | null;
    const requestedDays = body?.days === undefined || body?.days === null ? null : Math.min(180, Math.max(1, Math.floor(Number(body.days)) || 14));

    const admin = adminClient();
    const conn = await getConnection(uid);                     // API-key connection (07), preferred when present
    let auth: IntervalsAuth | null = conn ? { kind: "key", apiKey: conn.apiKey } : null;
    let athleteId = conn?.athleteId ?? "";
    const row = await sb.from("intervals_connections").select("athlete_id,last_sync_at").maybeSingle();
    if (!auth) {                                               // OAuth connection (14), if the Intervals.icu app was approved
      const t = await loadTokens(admin, cryptoOps, uid, "intervals").catch(() => null);
      if (t) { auth = { kind: "bearer", token: t.accessToken }; athleteId = row.data?.athlete_id ?? "0"; }
    }
    if (!auth) throw new IntervalsError(404, "Intervals.icu is not connected.");

    const r = await runIntervalsSync({ admin, user: sb, uid, athleteId, auth, requestedDays, lastSyncFallback: row.data?.last_sync_at ?? null });
    await markSynced(uid);
    return Response.json(r, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof SyncBusy || e instanceof SyncDeferred) { const x = integrationError(e); return Response.json({ error: x.message }, { status: x.status }); }
    if (e instanceof Error && typeof (e as { status?: unknown }).status === "number" && !(e instanceof IntervalsError)) {
      const s = (e as unknown as { status: number }).status;
      return Response.json({ error: s < 600 ? safeText(e.message, "Unexpected error.") : "Unexpected error." }, { status: s });
    }
    return errorResponse(e, "intervals sync failed");
  }
}
