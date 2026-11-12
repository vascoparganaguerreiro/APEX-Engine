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

export interface ReportExtractResult {
  sha256: string;
  duplicate?: { id: string; collected_on: string };
  extraction?: import("./health/core").Extraction;
}

/** Send a lab report to the server for automatic reading. Nothing is saved: the result must be reviewed first. */
export async function extractReport(file: File): Promise<ReportExtractResult> {
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in again.");
  const form = new FormData();
  form.append("file", file);
  const r = await fetch("/api/biomarkers/extract", { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Report-Consent": "yes" }, body: form });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
  return j as ReportExtractResult;
}

export type CoachApiResult = import("./coach/engine").CoachResult;
/** Ask the Coach. Sends the data categories the user switched on; the server enforces consent, limits and the context actually used. */
export async function coachRequest(body: Record<string, unknown>, categories: string[]): Promise<CoachApiResult> {
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in again.");
  const r = await fetch("/api/coach", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(categories.length ? { "X-Coach-Consent": "yes" } : {}) },
    body: JSON.stringify({ ...body, categories, today: new Date().toLocaleDateString("sv-SE") }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
  return j as CoachApiResult;
}