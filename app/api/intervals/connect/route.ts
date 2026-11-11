import { fetchAthlete, normalizeApiKey, normalizeAthleteId } from "@/lib/intervals";
import { authUser, errorResponse } from "@/lib/serverAuth";
import { deleteConnection, saveConnection } from "@/lib/serverConnections";

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
    return Response.json({ ok: true, athlete });
  } catch (e) {
    return errorResponse(e, "intervals connect failed");
  }
}

/** DELETE -> removes the saved connection. */
export async function DELETE(req: Request): Promise<Response> {
  try {
    const { uid } = await authUser(req);
    await deleteConnection(uid);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e, "intervals disconnect failed");
  }
}
