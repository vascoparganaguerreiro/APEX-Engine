import { getSupabase } from "./supabase";
import { removableUploads, uploadOutcome } from "./health/report";

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

/** Ask the server to read a lab report that is already uploaded to the private "lab-reports" bucket
 *  (path "<user id>/<sha256>.<ext>"). Nothing is saved: the result must be reviewed first. */
export function extractReport(path: string): Promise<ReportExtractResult> {
  return post("/api/biomarkers/extract", { path });
}

/** Upload a lab report straight to private storage (not through our server, which has a ~4.5 MB body limit).
 *  "created": this call stored the object; "existed": it was already there (e.g. belongs to a saved blood test). */
export async function uploadLabReport(path: string, file: File): Promise<"created" | "existed"> {
  const up = await getSupabase().storage.from("lab-reports").upload(path, file, { contentType: file.type, upsert: false });
  const outcome = uploadOutcome(up.error as { message?: string; statusCode?: string } | null);
  if (outcome === "failed") throw up.error;
  return outcome;
}

/** Delete report objects this page created, except those in `keep` and any a saved blood test references.
 *  If that check cannot be made, nothing is deleted. Errors are ignored: this is best-effort cleanup. */
export async function removeUnusedLabReports(created: Iterable<string>, keep: ReadonlyArray<string | null | undefined> = []): Promise<string[]> {
  const candidates = removableUploads(created, keep, []);
  if (candidates.length === 0) return [];
  const sb = getSupabase();
  const { data, error } = await sb.from("blood_panels").select("report_path").in("report_path", candidates);
  const doomed = removableUploads(candidates, keep, error || !data ? null : data.map((r) => r.report_path as string | null));
  if (doomed.length === 0) return [];
  const { error: rmError } = await sb.storage.from("lab-reports").remove(doomed);
  return rmError ? [] : doomed;
}
