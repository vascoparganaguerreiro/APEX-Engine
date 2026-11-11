import { getSupabase } from "./supabase";

export type SummarizeRequest = { kind: "activity"; id: number } | { kind: "week"; weekStart: string };

export interface IntervalsConnectResult {
  ok: true;
  athlete: { id: string; name: string | null };
}

/** POST JSON to one of our own API routes with the user's Supabase token. */
async function post<T>(path: string, body?: unknown, method = "POST"): Promise<T> {
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in again.");
  const r = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
  return j as T;
}

/** Ask the server to write an AI summary. The server checks your login and keeps the AI key secret. */
export function summarize(body: SummarizeRequest): Promise<{ summary: string; model: string }> {
  return post("/api/summarize", body);
}

/** Check Intervals.icu credentials through the server. */
export function connectIntervals(athleteId: string, apiKey: string): Promise<IntervalsConnectResult> {
  return post("/api/intervals/connect", { athleteId, apiKey });
}

/** Remove the saved Intervals.icu connection. */
export function disconnectIntervals(): Promise<{ ok: true }> {
  return post("/api/intervals/connect", undefined, "DELETE");
}

export interface IntervalsSyncResult { ok: true; days: number; wellness: number; activities: number }

/** Import the last `days` days (1-180) of wellness and activities from Intervals.icu. */
export function syncIntervals(days = 14): Promise<IntervalsSyncResult> {
  return post("/api/intervals/sync", { days });
}
