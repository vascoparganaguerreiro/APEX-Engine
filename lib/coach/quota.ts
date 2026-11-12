// Durable per-user Coach rate limit. The counting lives in Postgres (consume_coach_quota in 12_coach.sql); this is only the client.
// It is separate from the biomarker extraction limit. No imports.
export const COACH_HOURLY_DEFAULT = 30, COACH_DAILY_DEFAULT = 150;
export interface RpcDb { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> }
export interface CoachQuota { allowed: boolean; remainingHour: number; retryAfterSeconds: number; usageId: string | null }
export class QuotaUnavailable extends Error {}
export const limitFrom = (v: string | undefined, dflt: number, max: number) => { const n = Number(v); return v !== undefined && Number.isInteger(n) && n >= 1 && n <= max ? n : dflt; };

export async function consumeCoachQuota(db: RpcDb, uid: string, kind: string, hourLimit = COACH_HOURLY_DEFAULT, dayLimit = COACH_DAILY_DEFAULT): Promise<CoachQuota> {
  let res;
  try { res = await db.rpc("consume_coach_quota", { p_user: uid, p_kind: kind, p_hour_limit: hourLimit, p_day_limit: dayLimit }); } catch { throw new QuotaUnavailable("limiter unreachable"); }
  const row = (Array.isArray(res.data) ? res.data[0] : res.data) as { allowed?: unknown; remaining_hour?: unknown; retry_after_seconds?: unknown; usage_id?: unknown } | null | undefined;
  if (res.error || !row || typeof row.allowed !== "boolean") throw new QuotaUnavailable("limiter failed");
  return { allowed: row.allowed, remainingHour: Number(row.remaining_hour ?? 0), retryAfterSeconds: Number(row.retry_after_seconds ?? 0), usageId: typeof row.usage_id === "string" ? row.usage_id : null };
}
export const retryText = (s: number) => { const n = Math.max(1, Math.ceil(s)); return n < 90 ? `about ${n} second${n === 1 ? "" : "s"}` : `about ${Math.ceil(n / 60)} minutes`; };