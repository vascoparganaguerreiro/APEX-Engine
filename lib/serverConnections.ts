// Server-only wiring: service-role Supabase client + real encryption. Import this ONLY from route handlers.
// The service-role key is read here and nowhere else.
import { createClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret, needsRotation } from "@/lib/crypto";
import * as store from "@/lib/connectionStore";

/** The one server-side privileged client (service role). Import only from route handlers. */
export function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("[apex] server configuration incomplete: the privileged database key is not set for this deployment");   // operator log only; the person using the app gets a neutral message
    throw new store.ConnectionError(500, "This service isn't available right now. Please try again later.");
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const ops: store.CryptoOps = {
  encrypt: (plain, aad) => encryptSecret(plain, aad),
  decrypt: (blob, aad) => decryptSecret(blob, aad),
  needsRotation: (blob) => needsRotation(blob),
};

export const saveConnection = (uid: string, athleteId: string, apiKey: string) => store.saveConnection(adminClient(), ops, uid, athleteId, apiKey);
export const getConnection = (uid: string) => store.getConnection(adminClient(), ops, uid);
export const deleteConnection = (uid: string) => store.deleteConnection(adminClient(), uid);
export const markSynced = (uid: string) => store.markSynced(adminClient(), uid);
