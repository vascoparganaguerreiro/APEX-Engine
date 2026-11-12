// Writes normalised observations and provider daily fills with the USER's Supabase client (RLS applies: a user can only ever write
// their own rows). No framework imports. Missing migration 14 is reported as `notSetUp` instead of failing the whole sync.
import type { Db } from "../connectionStore.ts";
import type { DailyIncoming, Observation } from "./normalize.ts";

const isMissing = (e: { message?: string; code?: string } | null) => !!e && (e.code === "42P01" || e.code === "PGRST205" || e.code === "PGRST202" || /does not exist|schema cache|could not find/i.test(e.message ?? ""));

export interface StoreResult { saved: number; notSetUp: boolean; failed: boolean }

/** Upsert by (user, provider, transport, record, metric). A re-sync updates the same record's value (e.g. a WHOOP recovery that was
 *  still being scored); imported_at keeps the first import time. Nothing is deleted. */
export async function saveObservations(db: Db, uid: string, obs: Observation[], now = new Date()): Promise<StoreResult> {
  let saved = 0;
  for (let i = 0; i < obs.length; i += 500) {
    const chunk = obs.slice(i, i + 500).map((o) => ({ ...o, user_id: uid, updated_at: now.toISOString() }));
    const { error } = await db.from("metric_observations").upsert(chunk, { onConflict: "user_id,provider,transport,source_record_id,metric" });
    if (error) return { saved, notSetUp: isMissing(error), failed: !isMissing(error) };
    saved += chunk.length;
  }
  return { saved, notSetUp: false, failed: false };
}

/** Fill empty daily fields through apply_provider_daily_metrics (14). Manual and other sources are never overwritten. */
export async function fillDaily(db: Db & { rpc?: (fn: string, args: unknown) => PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }> }, provider: "whoop", rows: Array<DailyIncoming & { day: string }>): Promise<StoreResult> {
  if (!rows.length || !db.rpc) return { saved: 0, notSetUp: false, failed: false };
  let saved = 0;
  for (let i = 0; i < rows.length; i += 400) {
    const { data, error } = await db.rpc("apply_provider_daily_metrics", { p_provider: provider, p_rows: rows.slice(i, i + 400) });
    if (error) return { saved, notSetUp: isMissing(error), failed: !isMissing(error) };
    saved += Number(data ?? 0);
  }
  return { saved, notSetUp: false, failed: false };
}
