import { getSupabase } from "./supabase";
import { consentRequestHeaders } from "./consentOwner";

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

export interface SummarizeResult { summary: string; model: string; weekStart?: string; used: string[]; notShared: string[] }
/** Ask the server to write an AI summary. Sends the data categories the user switched on in Coach (same consent, re-checked by the
 *  server); categories that are not switched on are never read or sent to the AI. `consentUser` is the account that consent was loaded
 *  for: nothing is sent if the signed-in session is another account, and the server re-checks it (lib/consentOwner.ts). */
export async function summarize(body: SummarizeRequest, categories: string[], consentUser: string | null): Promise<SummarizeResult> {
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in again.");
  const r = await fetch("/api/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...consentRequestHeaders(categories, consentUser, data.session?.user?.id) },
    body: JSON.stringify({ ...body, categories }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
  return j as SummarizeResult;
}

/** Check Intervals.icu credentials through the server. */
export function connectIntervals(athleteId: string, apiKey: string): Promise<IntervalsConnectResult> {
  return post("/api/intervals/connect", { athleteId, apiKey });
}

/** Remove the saved Intervals.icu connection. */
export function disconnectIntervals(): Promise<{ ok: true }> {
  return post("/api/intervals/connect", undefined, "DELETE");
}

export type IntervalsSyncResult = import("./integrations/intervalsSync").IntervalsSyncResult;

/** Import wellness and activities from Intervals.icu. Without `days`: incremental since the last successful sync (first time: 120
 *  days). With `days` (1-180): re-read that whole range. */
export function syncIntervals(days?: number): Promise<IntervalsSyncResult> {
  return post("/api/intervals/sync", days === undefined ? {} : { days });
}

/** Universal Connect: start an OAuth connection; resolves with the provider's authorization URL to navigate to. */
export function startConnection(provider: string): Promise<{ url: string }> {
  return post(`/api/integrations/${encodeURIComponent(provider)}/start`);
}
export function disconnectProvider(provider: string): Promise<{ ok: true; revoked: boolean }> {
  return post(`/api/integrations/${encodeURIComponent(provider)}`, undefined, "DELETE");
}
export type WhoopSyncResult = import("./integrations/whoopSync").WhoopSyncResult;
export function syncProvider(provider: "whoop"): Promise<WhoopSyncResult> {
  return post(`/api/integrations/${provider}/sync`);
}
export function saveProviderSettings(provider: "whoop", settings: { fill_daily?: boolean; import_workouts?: boolean }): Promise<{ ok: true; settings: { fill_daily?: boolean; import_workouts?: boolean } }> {
  return post(`/api/integrations/${provider}`, settings, "PATCH");
}
export async function integrationConfig(): Promise<{ configured: string[] }> {
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in again.");
  const r = await fetch("/api/integrations", { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
  return j as { configured: string[] };
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
/** Ask the Coach. Sends the data categories the user switched on; the server enforces consent, limits and the context actually used.
 *  `consentUser` is the account those choices belong to (checked here and on the server, like summarize). */
export async function coachRequest(body: Record<string, unknown>, categories: string[], consentUser: string | null): Promise<CoachApiResult> {
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in again.");
  const r = await fetch("/api/coach", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...consentRequestHeaders(categories, consentUser, data.session?.user?.id) },
    body: JSON.stringify({ ...body, categories, today: new Date().toLocaleDateString("sv-SE") }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
  return j as CoachApiResult;
}