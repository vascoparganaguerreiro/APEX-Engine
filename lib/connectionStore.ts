// Storage logic for Intervals.icu credentials. No imports (testable with a fake database).
// Layout (see 07_*.sql):
//   intervals_connections(user_id, athlete_id, last_sync_at, api_key[legacy plaintext])  -> browser may read non-secret columns
//   intervals_credentials(user_id, api_key_enc, key_version)                             -> server only, no browser access
// Every query is scoped by `uid`, which callers must take from a server-verified JWT, never from request input.
// Nothing here logs or returns the API key except getConnection(), which hands it to server code only.

export class ConnectionError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.name = "ConnectionError"; this.status = status; }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Db { from(table: string): any }
export interface CryptoOps {
  encrypt(plain: string, aad: string): { blob: string; version: number };
  decrypt(blob: string, aad: string): string;
  needsRotation(blob: string): boolean;
}
export interface Connection { athleteId: string; apiKey: string }

const CONN = "intervals_connections", CRED = "intervals_credentials";

/** Encrypt, store and read back to prove it decrypts to the same key. Returns false on any failure. */
async function storeVerified(db: Db, ops: CryptoOps, uid: string, apiKey: string): Promise<boolean> {
  try {
    const { blob, version } = ops.encrypt(apiKey, uid);
    const w = await db.from(CRED).upsert({ user_id: uid, api_key_enc: blob, key_version: version, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    if (w.error) return false;
    const r = await db.from(CRED).select("api_key_enc").eq("user_id", uid).maybeSingle();
    return !r.error && !!r.data?.api_key_enc && ops.decrypt(r.data.api_key_enc, uid) === apiKey;
  } catch { return false; }
}

export async function saveConnection(db: Db, ops: CryptoOps, uid: string, athleteId: string, apiKey: string): Promise<void> {
  if (!(await storeVerified(db, ops, uid, apiKey))) throw new ConnectionError(500, "Could not store the credentials securely (check the encryption settings and 07_intervals_key_security.sql).");
  const c = await db.from(CONN).upsert({ user_id: uid, athlete_id: athleteId, api_key: null }, { onConflict: "user_id" });
  if (c.error) throw new ConnectionError(500, "Could not save the connection.");
}

export async function deleteConnection(db: Db, uid: string): Promise<void> {
  const a = await db.from(CRED).delete().eq("user_id", uid);
  const b = await db.from(CONN).delete().eq("user_id", uid);
  if (a.error || b.error) throw new ConnectionError(500, "Could not remove the connection.");
}

/** Decrypted credentials for `uid`, or null when not connected. Legacy plaintext keys are migrated:
 *  encrypted, read back and verified FIRST, and only then is the plaintext column cleared. If anything
 *  fails the legacy key is still returned and left in place, so a working connection is never lost. */
export async function getConnection(db: Db, ops: CryptoOps, uid: string): Promise<Connection | null> {
  const c = await db.from(CONN).select("athlete_id,api_key").eq("user_id", uid).maybeSingle();
  if (c.error) throw new ConnectionError(500, "Could not read the connection (did you run 07_intervals_key_security.sql?).");
  if (!c.data) return null;
  const athleteId: string = c.data.athlete_id;
  const legacy: string | null = c.data.api_key ?? null;

  const k = await db.from(CRED).select("api_key_enc").eq("user_id", uid).maybeSingle();
  if (k.error) throw new ConnectionError(500, "Could not read the credentials (did you run 07_intervals_key_security.sql?).");

  if (k.data?.api_key_enc) {
    try {
      const apiKey = ops.decrypt(k.data.api_key_enc, uid);
      if (ops.needsRotation(k.data.api_key_enc)) await storeVerified(db, ops, uid, apiKey);   // best effort key rotation
      if (legacy) await db.from(CONN).update({ api_key: null }).eq("user_id", uid);            // encrypted copy is proven good
      return { athleteId, apiKey };
    } catch {
      if (legacy) return { athleteId, apiKey: legacy };                                        // never strand a working connection
      throw new ConnectionError(500, "Saved credentials could not be decrypted. Reconnect Intervals.icu.");
    }
  }
  if (!legacy) return null;
  if (await storeVerified(db, ops, uid, legacy)) await db.from(CONN).update({ api_key: null }).eq("user_id", uid);
  return { athleteId, apiKey: legacy };
}

export async function markSynced(db: Db, uid: string): Promise<void> {
  await db.from(CONN).update({ last_sync_at: new Date().toISOString() }).eq("user_id", uid);
}
