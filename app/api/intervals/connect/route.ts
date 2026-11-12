import { fetchAthlete, normalizeApiKey, normalizeAthleteId } from "@/lib/intervals";
import { authUser, errorResponse } from "@/lib/serverAuth";
import { adminClient, deleteConnection, saveConnection } from "@/lib/serverConnections";
import { markConnected, markDisconnected } from "@/lib/integrations/syncState";

export const runtime = "nodejs";

/** POST { athleteId, apiKey } -> validates against Intervals.icu, then saves the key encrypted.
 *  The key is never returned or logged. */
export async function POST(req: Request): Promise<Response> {
  try {
    const { uid } = await authUser(req);
    const body = (await req.json().catch(() => null)) as { athleteId?: unknown; apiKey?: unknown } | null;
    const athleteId = normalizeAthleteId(body?.athleteId), apiKey = normalizeApiKey(body?.apiKey);
    const athlete = await fetchAthlete(athleteId, apiKey);
    await saveConnection(uid, athleteId, apiKey);
    // Sync status for the Connectivity Centre (14). Best effort: without migration 14 the connection works exactly as before.
    await markConnected(adminClient(), uid, "intervals", "direct", { externalUserId: athleteId, scopes: ["personal_key"] }).catch(() => undefined);
    return Response.json({ ok: true, athlete });
  } catch (e) {
    return errorResponse(e, "intervals connect failed");
  }
}

/** DELETE -> removes the saved API-key connection. Imported data is kept. */
export async function DELETE(req: Request): Promise<Response> {
  try {
    const { uid } = await authUser(req);
    await deleteConnection(uid);
    await markDisconnected(adminClient(), uid, "intervals").catch(() => undefined);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e, "intervals disconnect failed");
  }
}
