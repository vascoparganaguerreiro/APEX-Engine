// Server-only access to intervals_connections. The API key is encrypted at rest and only this module
// (using the service-role client) can read it; browsers can read athlete_id/last_sync_at only (see 07_*.sql).
// Callers must pass a user id that was verified from the caller's JWT. Nothing here logs credentials.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { IntervalsError } from "@/lib/intervals";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

function admin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new IntervalsError(500, "The server is missing SUPABASE_SERVICE_ROLE_KEY.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function encrypt(apiKey: string): string {
  try { return encryptSecret(apiKey); } catch { throw new IntervalsError(500, "The server is missing a valid INTERVALS_ENCRYPTION_KEY."); }
}

export async function saveConnection(uid: string, athleteId: string, apiKey: string): Promise<void> {
  const { error } = await admin().from("intervals_connections").upsert(
    { user_id: uid, athlete_id: athleteId, api_key_enc: encrypt(apiKey), api_key: null }, { onConflict: "user_id" });
  if (error) throw new IntervalsError(500, "Could not save the connection (did you run 07_intervals_key_security.sql?).");
}

export async function deleteConnection(uid: string): Promise<void> {
  const { error } = await admin().from("intervals_connections").delete().eq("user_id", uid);
  if (error) throw new IntervalsError(500, "Could not remove the connection.");
}

/** Returns the decrypted credentials. Legacy plaintext rows are encrypted on first use. */
export async function getConnection(uid: string): Promise<{ athleteId: string; apiKey: string } | null> {
  const sb = admin();
  const { data, error } = await sb.from("intervals_connections").select("athlete_id,api_key,api_key_enc").eq("user_id", uid).maybeSingle();
  if (error) throw new IntervalsError(500, "Could not read the connection (did you run 07_intervals_key_security.sql?).");
  if (!data) return null;
  if (data.api_key_enc) {
    try { return { athleteId: data.athlete_id, apiKey: decryptSecret(data.api_key_enc) }; }
    catch { throw new IntervalsError(500, "Saved credentials could not be decrypted. Reconnect Intervals.icu."); }
  }
  if (!data.api_key) return null;
  await sb.from("intervals_connections").update({ api_key_enc: encrypt(data.api_key), api_key: null }).eq("user_id", uid);
  return { athleteId: data.athlete_id, apiKey: data.api_key };
}

export async function markSynced(uid: string): Promise<void> {
  await admin().from("intervals_connections").update({ last_sync_at: new Date().toISOString() }).eq("user_id", uid);
}
