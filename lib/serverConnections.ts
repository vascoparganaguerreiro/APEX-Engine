// Server-only wiring: service-role Supabase client + real encryption. Import this ONLY from route handlers.
// The service-role key is read here and nowhere else.
import { createClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret, needsRotation } from "@/lib/crypto";
import * as store from "@/lib/connectionStore";

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new store.ConnectionError(500, "The server is missing SUPABASE_SERVICE_ROLE_KEY.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const ops: store.CryptoOps = {
  encrypt: (plain, aad) => encryptSecret(plain, aad),
  decrypt: (blob, aad) => decryptSecret(blob, aad),
  needsRotation: (blob) => needsRotation(blob),
};

export const saveConnection = (uid: string, athleteId: string, apiKey: string) => store.saveConnection(admin(), ops, uid, athleteId, apiKey);
export const getConnection = (uid: string) => store.getConnection(admin(), ops, uid);
export const deleteConnection = (uid: string) => store.deleteConnection(admin(), uid);
export const markSynced = (uid: string) => store.markSynced(admin(), uid);
