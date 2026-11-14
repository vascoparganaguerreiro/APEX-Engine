// Server-only wiring for the AI usage ledger (lib/aiUsage.ts + 09_ai_usage.sql). Import this ONLY from route handlers.
// Usage: const out = await withAiUsage(uid, "summary", () => doTheAiCall());   // uid from the verified token only
import { serviceClient } from "@/lib/serverConnections";
import * as usage from "@/lib/aiUsage";

export { AiLimitError, AiUsageError, dailyLimit, type AiKind, type AiUsageHandle } from "@/lib/aiUsage";

function db(): usage.Db {
  try { return serviceClient(); }
  catch (e) { throw new usage.AiUsageError(500, e instanceof Error ? e.message : "The server is missing the Supabase settings."); }
}

/** Record one use. Throws AiLimitError (status 429) at the daily limit, AiUsageError (status 500/401) otherwise. */
export const consumeAiUsage = (uid: string, kind: usage.AiKind): Promise<usage.AiUsageHandle> => usage.consume(db(), uid, kind);

/** Give one use back after a failure. Best effort: never throws, resolves to whether it worked. */
export async function releaseAiUsage(handle: usage.AiUsageHandle): Promise<boolean> {
  try { return await usage.release(db(), handle); } catch { return false; }
}

/** consumeAiUsage, run `fn`, and releaseAiUsage if `fn` throws (fn's error is rethrown unchanged). */
export async function withAiUsage<T>(uid: string, kind: usage.AiKind, fn: () => Promise<T>): Promise<T> {
  return usage.withUsage(db(), uid, kind, fn);
}
