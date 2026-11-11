import { IntervalsError, fetchAthlete } from "@/lib/intervals";
import { authUser, errorResponse } from "@/lib/serverAuth";

export const runtime = "nodejs";

/** POST { athleteId, apiKey } -> validates against Intervals.icu, then saves in intervals_connections.
 *  The key is never returned or logged. */
export async function POST(req: Request): Promise<Response> {
  try {
    const { sb, uid } = await authUser(req);
    const body = (await req.json().catch(() => null)) as { athleteId?: unknown; apiKey?: unknown } | null;
    const athlete = await fetchAthlete(String(body?.athleteId ?? ""), String(body?.apiKey ?? ""));
    const { error } = await sb.from("intervals_connections").upsert(
      { user_id: uid, athlete_id: String(body?.athleteId).trim(), api_key: String(body?.apiKey).trim() },
      { onConflict: "user_id" });
    if (error) throw new IntervalsError(500, "Could not save the connection.");
    return Response.json({ ok: true, athlete });
  } catch (e) {
    return errorResponse(e, "intervals connect failed");
  }
}

/** DELETE -> removes the saved connection. */
export async function DELETE(req: Request): Promise<Response> {
  try {
    const { sb, uid } = await authUser(req);
    const { error } = await sb.from("intervals_connections").delete().eq("user_id", uid);
    if (error) throw new IntervalsError(500, "Could not remove the connection.");
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e, "intervals disconnect failed");
  }
}
