// Client for the durable extraction rate limit. No imports (unit-testable). The limit itself lives in Postgres
// (consume_extraction_quota in 09_biomarker_rate_limit.sql); nothing here counts requests in process memory.

export const DEFAULT_LIMIT = 10;
export const WINDOW_SECONDS = 3600;

export interface RpcDb { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> }
export interface QuotaResult { allowed: boolean; remaining: number; retryAfterSeconds: number }

/** The limiter could not be consulted. Callers must fail closed: no quota check, no Gemini call. */
export class QuotaUnavailableError extends Error {}

/** EXTRACT_HOURLY_LIMIT, validated: a whole number from 1 to 1000, otherwise the default. */
export function limitFromEnv(v: string | undefined): number {
  const n = Number(v);
  return v !== undefined && Number.isInteger(n) && n >= 1 && n <= 1000 ? n : DEFAULT_LIMIT;
}

export async function consumeExtractionQuota(db: RpcDb, uid: string, limit = DEFAULT_LIMIT, windowSeconds = WINDOW_SECONDS): Promise<QuotaResult> {
  let res;
  try { res = await db.rpc("consume_extraction_quota", { p_user: uid, p_limit: limit, p_window_seconds: windowSeconds }); }
  catch { throw new QuotaUnavailableError("rate limiter unreachable"); }
  const row = (Array.isArray(res.data) ? res.data[0] : res.data) as { allowed?: unknown; remaining?: unknown; retry_after_seconds?: unknown } | null | undefined;
  if (res.error || !row || typeof row.allowed !== "boolean") throw new QuotaUnavailableError("rate limiter failed");
  return { allowed: row.allowed, remaining: Number(row.remaining ?? 0), retryAfterSeconds: Number(row.retry_after_seconds ?? 0) };
}

export function retryText(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 90) return `about ${s} second${s === 1 ? "" : "s"}`;
  const m = Math.ceil(s / 60);
  return `about ${m} minute${m === 1 ? "" : "s"}`;
}