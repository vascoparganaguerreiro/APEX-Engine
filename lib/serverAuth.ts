import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { IntervalsError } from "@/lib/intervals";
import { ConnectionError } from "@/lib/connectionStore";
import { CryptoConfigError } from "@/lib/crypto";

/** Server-side: identify the caller from the Bearer token and return a Supabase client
 *  that acts as that user (row-level security applies). */
export async function authUser(req: Request): Promise<{ sb: SupabaseClient; uid: string }> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new IntervalsError(401, "Please sign in again.");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new IntervalsError(500, "The server is missing the Supabase settings.");
  const sb = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user) throw new IntervalsError(401, "Please sign in again.");
  return { sb, uid: data.user.id };
}

export function errorResponse(e: unknown, label: string): Response {
  if (e instanceof IntervalsError || e instanceof ConnectionError) return Response.json({ error: e.message }, { status: e.status });
  if (e instanceof CryptoConfigError) {
    console.error(label, "encryption is not configured");
    return Response.json({ error: "The server encryption settings are missing or invalid." }, { status: 500 });
  }
  console.error(label, e instanceof Error ? e.message : "unknown");
  return Response.json({ error: "Unexpected error." }, { status: 500 });
}
