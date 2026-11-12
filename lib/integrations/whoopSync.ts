// One WHOOP sync, as a plain function with injected stores and fetch (tested end-to-end with fakes).
//   admin = service-role client: credentials + connection status only.
//   user  = the signed-in user's client: observations, daily fills and activities (RLS applies).
import type { CryptoOps, Db } from "../connectionStore.ts";
import type { OAuthConfig } from "./oauth.ts";
import { dailyFromObservations } from "./normalize.ts";
import { fillDaily, saveObservations } from "./observationStore.ts";
import { acquireLease, finishError, finishSuccess } from "./syncState.ts";
import { ReauthRequired, validAccessToken } from "./tokenStore.ts";
import { mapWhoop, readWhoop, refreshTokens, whoopRange, WhoopError, type Deps } from "./whoop.ts";

type UserDb = Db & { rpc?: (fn: string, args: unknown) => PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }> };

export interface WhoopSyncResult {
  ok: true; range: { start: string; end: string }; observations: number; dailyFilled: number; workouts: number; workoutsImported: number;
  pending: number; unscorable: number; notes: string[];
}

export async function runWhoopSync(a: { admin: Db; user: UserDb; ops: CryptoOps; cfg: OAuthConfig; uid: string; deps?: Deps; now?: Date }): Promise<WhoopSyncResult> {
  const now = a.now ?? new Date(), deps = a.deps ?? {};
  const conn = await acquireLease(a.admin, a.uid, "whoop", now);
  try {
    const token = await validAccessToken(a.admin, a.ops, a.uid, "whoop", (rt) => refreshTokens(a.cfg, rt, deps.fetchImpl, now), now);
    const range = whoopRange(now, conn.last_success_at);
    const raw = await readWhoop(token, range, deps);
    const batch = mapWhoop(raw, now);
    const notes: string[] = [];

    const saved = await saveObservations(a.user, a.uid, batch.observations, now);
    if (saved.notSetUp) throw Object.assign(new Error("Connections need a database update (migration 14)."), { status: 503 });
    if (saved.failed) throw Object.assign(new Error("Could not save the WHOOP data."), { status: 500 });

    let dailyFilled = 0;
    if (conn.settings.fill_daily) {
      const d = await fillDaily(a.user, "whoop", dailyFromObservations(batch.observations));
      if (d.failed || d.notSetUp) notes.push("Daily HRV, resting heart rate and sleep could not be filled from WHOOP. The WHOOP values are still saved.");
      dailyFilled = d.saved;
    }

    let workoutsImported = 0;
    if (conn.settings.import_workouts && batch.workouts.length) {
      // load stays null: WHOOP strain is not a TSS-like load and must not enter the load model.
      const rows = batch.workouts.map((w) => ({ ...w, user_id: a.uid, source: "whoop", load: null }));
      let { error } = await a.user.from("activities").upsert(rows.map((r) => ({ ...r, origin: "WHOOP", origin_device: null, elapsed_s: r.duration_s })), { onConflict: "user_id,source,external_id" });
      // Without 13_strength.sql the provenance columns (origin, max_hr, calories, elapsed_s) do not exist yet.
      if (error && /column|schema cache/i.test(error.message ?? "")) ({ error } = await a.user.from("activities").upsert(rows.map(({ max_hr: _m, calories: _c, ...r }) => r), { onConflict: "user_id,source,external_id" }));
      if (error) notes.push("WHOOP workouts could not be added to Activities. Their strain and heart rate are still saved.");
      else workoutsImported = rows.length;
    }
    if (batch.pending) notes.push(`${batch.pending} WHOOP record(s) are still being scored and will be picked up by a later sync.`);

    await finishSuccess(a.admin, a.uid, "whoop", { start: range.start, end: range.end }, now);
    return { ok: true, range, observations: saved.saved, dailyFilled, workouts: batch.workouts.length, workoutsImported, pending: batch.pending, unscorable: batch.unscorable, notes };
  } catch (e) {
    const reauth = e instanceof ReauthRequired || (e instanceof WhoopError && e.reauth);
    const msg = e instanceof ReauthRequired || e instanceof WhoopError ? e.message : e instanceof Error && (e as { status?: number }).status ? e.message : "The WHOOP sync failed.";
    await finishError(a.admin, a.uid, "whoop", conn.failures, msg, { reauth, retryAt: e instanceof WhoopError ? e.retryAt : null }, now).catch(() => undefined);
    throw e;
  }
}
