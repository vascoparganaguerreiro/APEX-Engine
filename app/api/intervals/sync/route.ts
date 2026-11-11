import { IntervalsError, fetchActivities, fetchWellness } from "@/lib/intervals";
import { mergeSync, sameMetrics, type MetricRow } from "@/lib/provenance";
import { authUser, errorResponse } from "@/lib/serverAuth";
import { getConnection, markSynced } from "@/lib/serverConnections";

export const runtime = "nodejs";
export const maxDuration = 60;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** POST { days? } (default 14, max 180) -> imports wellness into daily_metrics and
 *  activities into activities (deduplicated by external_id). Notes and AI summaries are kept. */
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
      fetchActivities(conn.athleteId, conn.apiKey, oldest, newest),
    ]);

    // Field-level merge: manual (or legacy/unknown-source) values are never overwritten by sync,
    // and rows that would not change are not written at all.
    let metricsSaved = 0;
    if (wellness.length) {
      const { data: existing, error: eErr } = await sb.from("daily_metrics")
        .select("day,source,hrv_ms,rhr_bpm,sleep_minutes,sleep_score,hrv_source,rhr_source,sleep_source,sleep_score_source")
        .gte("day", oldest).lte("day", newest);
      if (eErr) throw new IntervalsError(500, "Could not read existing wellness data (did you run 06_metric_provenance.sql?).");
      const byDay = new Map<string, MetricRow & { source: string | null }>((existing ?? []).map((r) => [r.day as string, r as MetricRow & { source: string | null }]));
      const rows = [];
      for (const w of wellness) {
        const old = byDay.get(w.day) ?? null;
        const merged = mergeSync(old, w);
        if (sameMetrics(old, merged)) continue;
        rows.push({ user_id: uid, day: w.day, source: old?.source ?? "intervals", ...merged });
      }
      if (rows.length) {
        const { error } = await sb.from("daily_metrics").upsert(rows, { onConflict: "user_id,day" });
        if (error) throw new IntervalsError(500, "Could not save wellness data.");
      }
      metricsSaved = rows.length;
    }

    if (acts.length) {
      const { error } = await sb.from("activities").upsert(
        acts.map((a) => ({ user_id: uid, ...a })), { onConflict: "user_id,external_id" });
      if (error) throw new IntervalsError(500, "Could not save activities (did you run 05_intervals.sql?).");
    }

    await markSynced(uid);
    return Response.json({ ok: true, days, wellness: metricsSaved, activities: acts.length });
  } catch (e) {
    return errorResponse(e, "intervals sync failed");
  }
}
