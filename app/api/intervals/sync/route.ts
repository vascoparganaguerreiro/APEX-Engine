import { IntervalsError, fetchActivitiesDetailed, fetchWellness } from "@/lib/intervals";
import { authUser, errorResponse } from "@/lib/serverAuth";
import { getConnection, markSynced } from "@/lib/serverConnections";

export const runtime = "nodejs";
export const maxDuration = 60;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** POST { days? } (default 14, max 180) -> imports wellness into daily_metrics and
 *  activities into activities (deduplicated by user_id, source, external_id). Notes and AI summaries are kept. */
export async function POST(req: Request): Promise<Response> {
  try {
    const { sb, uid } = await authUser(req);
    const body = (await req.json().catch(() => null)) as { days?: unknown } | null;
    const days = Math.min(180, Math.max(1, Math.floor(Number(body?.days ?? 14)) || 14));

    const conn = await getConnection(uid);
    if (!conn) throw new IntervalsError(404, "Intervals.icu is not connected.");

    const newest = isoDay(new Date());
    const oldest = isoDay(new Date(Date.now() - days * 86400000));
    const [wellness, acts] = await Promise.all([
      fetchWellness(conn.athleteId, conn.apiKey, oldest, newest),
      fetchActivitiesDetailed(conn.athleteId, conn.apiKey, oldest, newest),
    ]);

    // One atomic statement in Postgres (06_metric_provenance.sql): manual and legacy_unknown values are never
    // overwritten, even by a manual edit that commits while this sync is running. No read-then-write here.
    let metricsSaved = 0;
    if (wellness.length) {
      const { data, error } = await sb.rpc("apply_synced_metrics", { p_rows: wellness });
      if (error) throw new IntervalsError(500, "Could not save wellness data (did you run 06_metric_provenance.sql?).");
      metricsSaved = Number(data ?? 0);
    }

    if (acts.length) {
      // Provenance columns (origin, device, max HR, calories, elapsed time) exist once 13_strength.sql is applied. Until then the
      // activities are saved exactly as before, without them.
      let { error } = await sb.from("activities").upsert(
        acts.map((a) => ({ ...a, user_id: uid, source: "intervals" })), { onConflict: "user_id,source,external_id" });
      if (error && /column|schema cache/i.test(error.message ?? "")) {
        ({ error } = await sb.from("activities").upsert(
          acts.map(({ origin: _o, origin_device: _d, elapsed_s: _e, max_hr: _m, calories: _c, ...a }) => ({ ...a, user_id: uid, source: "intervals" })), { onConflict: "user_id,source,external_id" }));
      }
      if (error) throw new IntervalsError(500, "Could not save activities.");
    }

    await markSynced(uid);
    return Response.json({ ok: true, days, wellness: metricsSaved, activities: acts.length });
  } catch (e) {
    return errorResponse(e, "intervals sync failed");
  }
}
