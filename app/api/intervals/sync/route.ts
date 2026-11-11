import { IntervalsError, fetchActivities, fetchWellness, type WellnessRow } from "@/lib/intervals";
import { authUser, errorResponse } from "@/lib/serverAuth";

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

    const { data: conn, error: cErr } = await sb.from("intervals_connections").select("athlete_id,api_key").eq("user_id", uid).maybeSingle();
    if (cErr) throw new IntervalsError(500, "Could not read the connection.");
    if (!conn) throw new IntervalsError(404, "Intervals.icu is not connected.");

    const newest = isoDay(new Date());
    const oldest = isoDay(new Date(Date.now() - days * 86400000));
    const [wellness, acts] = await Promise.all([
      fetchWellness(conn.athlete_id, conn.api_key, oldest, newest),
      fetchActivities(conn.athlete_id, conn.api_key, oldest, newest),
    ]);

    // Merge with existing rows so a missing value in Intervals never erases one we already have (e.g. manual entry).
    let metricsSaved = 0;
    if (wellness.length) {
      const { data: existing } = await sb.from("daily_metrics").select("day,hrv_ms,rhr_bpm,sleep_minutes,sleep_score").gte("day", oldest).lte("day", newest);
      const byDay = new Map<string, Partial<WellnessRow>>((existing ?? []).map((r) => [r.day as string, r as Partial<WellnessRow>]));
      const rows = wellness.map((w) => {
        const o = byDay.get(w.day) ?? {};
        return {
          user_id: uid, day: w.day, source: "intervals",
          hrv_ms: w.hrv_ms ?? o.hrv_ms ?? null,
          rhr_bpm: w.rhr_bpm ?? o.rhr_bpm ?? null,
          sleep_minutes: w.sleep_minutes ?? o.sleep_minutes ?? null,
          sleep_score: w.sleep_score ?? o.sleep_score ?? null,
        };
      });
      const { error } = await sb.from("daily_metrics").upsert(rows, { onConflict: "user_id,day" });
      if (error) throw new IntervalsError(500, "Could not save wellness data.");
      metricsSaved = rows.length;
    }

    if (acts.length) {
      const { error } = await sb.from("activities").upsert(
        acts.map((a) => ({ user_id: uid, ...a })), { onConflict: "user_id,external_id" });
      if (error) throw new IntervalsError(500, "Could not save activities (did you run 05_intervals.sql?).");
    }

    await sb.from("intervals_connections").update({ last_sync_at: new Date().toISOString() }).eq("user_id", uid);
    return Response.json({ ok: true, days, wellness: metricsSaved, activities: acts.length });
  } catch (e) {
    return errorResponse(e, "intervals sync failed");
  }
}
