// One Intervals.icu sync as a plain function (stores and fetch injected; tested end-to-end with fakes).
//   admin (optional) = service role, only for provider_connections (sync status, lease, cursor). Without migration 14 it is skipped
//                      and the sync behaves as before.
//   user             = the signed-in user's client: daily_metrics (through 06's apply_synced_metrics), activities, observations.
import type { Db } from "../connectionStore.ts";
import { readRange, syncRange, type HttpDeps, type IntervalsAuth } from "./intervalsGateway.ts";
import { saveObservations } from "./observationStore.ts";
import { acquireLease, finishError, finishSuccess, SyncBusy, SyncDeferred, type ConnRow } from "./syncState.ts";

type UserDb = Db & { rpc(fn: string, args: unknown): PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }> };
export class SyncFailure extends Error { status: number; constructor(status: number, m: string) { super(m); this.status = status; } }

export interface IntervalsSyncResult {
  ok: true; days: number; oldest: string; newest: string; incremental: boolean; wellness: number; activities: number; observations: number;
  skipped: { strava: number; noTime: number }; latestWellnessDay: string | null; statusTracked: boolean; notes: string[];
}

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function runIntervalsSync(a: {
  admin: Db | null; user: UserDb; uid: string; athleteId: string; auth: IntervalsAuth;
  requestedDays: number | null; lastSyncFallback: string | null; deps?: HttpDeps; now?: Date;
}): Promise<IntervalsSyncResult> {
  const now = a.now ?? new Date();
  let conn: ConnRow | null = null;
  if (a.admin) {
    try { conn = await acquireLease(a.admin, a.uid, "intervals", now, { create: "direct" }); }
    catch (e) { if (e instanceof SyncBusy || e instanceof SyncDeferred) throw e; conn = null; }   // no migration 14: run without status
  }
  const status = !!(a.admin && conn);
  try {
    // "today" is taken one day ahead of UTC so users east of UTC still get their local today; future days are simply empty.
    const range = syncRange(isoDay(now.getTime() + DAY), { requestedDays: a.requestedDays, lastSuccessAt: conn?.last_success_at ?? a.lastSyncFallback });
    const r = await readRange(a.athleteId, a.auth, range.oldest, range.newest, a.deps);
    const notes: string[] = [];

    // 06 rules, one atomic statement in Postgres: manual / legacy_unknown / other providers' values are never overwritten.
    let wellness = 0;
    if (r.wellness.length) {
      const { data, error } = await a.user.rpc("apply_synced_metrics", { p_rows: r.wellness });
      if (error) throw new SyncFailure(500, "Could not save wellness data (did you run 06_metric_provenance.sql?).");
      wellness = Number(data ?? 0);
    }

    if (r.activities.length) {
      // Provenance columns (origin, device, max HR, calories, elapsed time) exist once 13_strength.sql is applied; until then the
      // activities are saved exactly as before, without them. `source` is set AFTER the spread so it can never be overridden.
      let { error } = await a.user.from("activities").upsert(
        r.activities.map((x) => ({ ...x, user_id: a.uid, source: "intervals" })), { onConflict: "user_id,source,external_id" });
      if (error && /column|schema cache/i.test(error.message ?? "")) {
        ({ error } = await a.user.from("activities").upsert(
          r.activities.map(({ origin: _o, origin_device: _d, elapsed_s: _e, max_hr: _m, calories: _c, ...x }) => ({ ...x, user_id: a.uid, source: "intervals" })), { onConflict: "user_id,source,external_id" }));
      }
      if (error) throw new SyncFailure(500, "Could not save activities.");
    }

    const obs = await saveObservations(a.user, a.uid, r.observations, now);
    if (obs.notSetUp) notes.push("Extra wellness fields (VO2 max, SpO2, readiness, steps…) are kept once migration 14 is applied.");
    else if (obs.failed) notes.push("Extra wellness fields could not be saved this time; the main data was saved.");
    if (r.skippedStrava) notes.push(`${r.skippedStrava} Strava-recorded activit${r.skippedStrava === 1 ? "y was" : "ies were"} skipped: Intervals.icu does not share Strava data through its API.`);
    if (r.skippedNoTime) notes.push(`${r.skippedNoTime} activit${r.skippedNoTime === 1 ? "y has" : "ies have"} no usable start time and ${r.skippedNoTime === 1 ? "was" : "were"} skipped.`);

    if (status) await finishSuccess(a.admin!, a.uid, "intervals", { oldest: range.oldest, newest: range.newest, latest_wellness_day: r.latestWellnessDay }, now);
    const days = Math.round((Date.parse(range.newest) - Date.parse(range.oldest)) / DAY);
    return { ok: true, days, oldest: range.oldest, newest: range.newest, incremental: range.incremental, wellness, activities: r.activities.length,
      observations: obs.saved, skipped: { strava: r.skippedStrava, noTime: r.skippedNoTime }, latestWellnessDay: r.latestWellnessDay, statusTracked: status, notes };
  } catch (e) {
    if (status) {
      const s = (e as { status?: number }).status ?? 500;
      const msg = e instanceof Error && s < 500 ? e.message : e instanceof SyncFailure ? e.message : s === 502 ? "Could not reach Intervals.icu." : "The Intervals.icu sync failed.";
      const retryS = (e as { retryAfterS?: number }).retryAfterS;
      await finishError(a.admin!, a.uid, "intervals", conn!.failures, msg, { reauth: s === 401, retryAt: retryS ? new Date(now.getTime() + retryS * 1000).toISOString() : null }, now).catch(() => undefined);
    }
    throw e;
  }
}
