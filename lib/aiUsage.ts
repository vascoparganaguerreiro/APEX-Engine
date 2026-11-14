// Per-user daily limits for AI calls. No imports (testable with a fake database); server wiring is in
// lib/serverAiUsage.ts. Storage is the server-only table + atomic function from 09_ai_usage.sql:
//   consume_ai_usage(p_user, p_kind, p_limit) -> new event id, or null when today's (UTC) limit is reached
//   ai_usage_events(id, user_id, kind, created_at)  -> browsers have no access at all
// `uid` must always come from a server-verified JWT, never from request input.

export type AiKind = "summary" | "report_extract";

export const AI_LIMITS: Readonly<Record<AiKind, { env: string; fallback: number; noun: string }>> = {
  summary: { env: "SUMMARY_DAILY_LIMIT", fallback: 30, noun: "AI summaries" },
  report_extract: { env: "REPORT_DAILY_LIMIT", fallback: 10, noun: "lab report readings" },
};

/** Highest accepted configured limit (also keeps the value inside Postgres `integer`). */
export const MAX_DAILY_LIMIT = 100_000;

export class AiUsageError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.name = "AiUsageError"; this.status = status; }
}

/** The user has used up today's allowance for `kind`. Always HTTP 429. */
export class AiLimitError extends AiUsageError {
  kind: AiKind;
  limit: number;
  constructor(kind: AiKind, limit: number) {
    super(429, `Daily limit of ${limit} ${AI_LIMITS[kind].noun} reached. Try again tomorrow (the limit resets at 00:00 UTC).`);
    this.name = "AiLimitError"; this.kind = kind; this.limit = limit;
  }
}

export type Env = Record<string, string | undefined>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Db { from(table: string): any; rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> }
export interface AiUsageHandle { readonly id: number | string; readonly uid: string; readonly kind: AiKind }

const TABLE = "ai_usage_events", FN = "consume_ai_usage";

export const isAiKind = (k: unknown): k is AiKind => typeof k === "string" && Object.hasOwn(AI_LIMITS, k);

/** A whole number 0..MAX_DAILY_LIMIT, otherwise `fallback`. A bad value (typo, negative, "NaN", "1.5", "")
 *  never disables the limit. "0" is accepted and blocks the feature entirely (it does NOT mean unlimited). */
export function parseLimit(raw: string | undefined, fallback: number): number {
  if (typeof raw !== "string" || !/^\s*\d+\s*$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n <= MAX_DAILY_LIMIT ? n : fallback;
}

export function dailyLimit(kind: AiKind, env: Env = process.env): number {
  const { env: name, fallback } = AI_LIMITS[kind];
  return parseLimit(env[name], fallback);
}

/** Atomically record one use of `kind` for `uid`. Throws AiLimitError (429) when the limit is reached and
 *  AiUsageError (500) when the ledger cannot be reached: it fails closed, never open. */
export async function consume(db: Db, uid: string, kind: AiKind, env: Env = process.env): Promise<AiUsageHandle> {
  if (typeof uid !== "string" || !uid) throw new AiUsageError(401, "Please sign in again.");
  if (!isAiKind(kind)) throw new AiUsageError(500, "Unknown AI usage kind.");
  const limit = dailyLimit(kind, env);
  let res: { data: unknown; error: unknown };
  try { res = await db.rpc(FN, { p_user: uid, p_kind: kind, p_limit: limit }); }
  catch { res = { data: null, error: true }; }
  if (res.error) throw new AiUsageError(500, "Could not check the daily AI limit (did you run 09_ai_usage.sql?).");
  const id = res.data;
  if (id === null || id === undefined) throw new AiLimitError(kind, limit);
  if (typeof id !== "number" && typeof id !== "string") throw new AiUsageError(500, "Could not check the daily AI limit.");
  return { id, uid, kind };
}

/** Give one use back (e.g. the AI call or saving its result failed). Best effort: never throws, returns success. */
export async function release(db: Db, handle: AiUsageHandle): Promise<boolean> {
  try {
    const r = await db.from(TABLE).delete().eq("id", handle.id).eq("user_id", handle.uid);
    return !r?.error;
  } catch { return false; }
}

/** consume, run `fn`, and release the use if `fn` throws (the original error is rethrown). */
export async function withUsage<T>(db: Db, uid: string, kind: AiKind, fn: () => Promise<T>, env: Env = process.env): Promise<T> {
  const handle = await consume(db, uid, kind, env);
  try {
    return await fn();
  } catch (e) {
    if (!(await release(db, handle))) console.error("ai usage: could not release event", handle.kind);
    throw e;
  }
}
