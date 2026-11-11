import { getSupabase } from "./supabase";

export type SummarizeRequest = { kind: "activity"; id: number } | { kind: "week"; weekStart: string };

/** Ask the server to write an AI summary. The server checks your login and keeps the AI key secret. */
export async function summarize(body: SummarizeRequest): Promise<{ summary: string; model: string }> {
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in again.");
  const r = await fetch("/api/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
  return j;
}
