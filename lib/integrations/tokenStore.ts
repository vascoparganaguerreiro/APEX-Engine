// OAuth token storage for direct provider connections. No framework imports: testable with a fake database.
// Table provider_credentials (14_universal_connect.sql) is server-only (RLS on, no policies, no grants to browser roles).
// Tokens are AES-256-GCM encrypted (lib/crypto.ts) with AAD "<user>|<provider>|<kind>": a blob copied to another user, another provider
// or from the refresh slot to the access slot fails authentication. Every query is scoped by a server-verified user id.
// Nothing here logs or returns token values except to server code that calls the provider.
import type { CryptoOps, Db } from "../connectionStore.ts";
import { OAuthError, needsRefresh, type TokenSet } from "./oauth.ts";

const CRED = "provider_credentials";
export const aad = (uid: string, provider: string, kind: "access" | "refresh") => `${uid}|${provider}|${kind}`;

export class ReauthRequired extends Error { constructor() { super("Access expired or was revoked. Connect again."); this.name = "ReauthRequired"; } }
export class TokenStoreError extends Error { status = 500; }

export interface StoredTokens { accessToken: string; refreshToken: string | null; expiresAt: string | null; rev: number; scopes: string[] }

function encryptSet(ops: CryptoOps, uid: string, provider: string, t: TokenSet) {
  const a = ops.encrypt(t.accessToken, aad(uid, provider, "access"));
  const r = t.refreshToken ? ops.encrypt(t.refreshToken, aad(uid, provider, "refresh")) : null;
  return { access_token_enc: a.blob, refresh_token_enc: r?.blob ?? null, key_version: a.version, expires_at: t.expiresAt, scopes: t.scopes };
}

/** Insert or replace the tokens (new connection or reconnection), then read back and prove they decrypt. */
export async function saveTokens(db: Db, ops: CryptoOps, uid: string, provider: string, t: TokenSet, now = new Date()): Promise<void> {
  const prev = await db.from(CRED).select("rev").eq("user_id", uid).eq("provider", provider).maybeSingle();
  const rev = (prev.data?.rev ?? 0) + 1;
  const w = await db.from(CRED).upsert({ user_id: uid, provider, ...encryptSet(ops, uid, provider, t), rev, updated_at: now.toISOString() }, { onConflict: "user_id,provider" });
  if (w.error) throw new TokenStoreError("Could not store the connection securely (did you run 14_universal_connect.sql?).");
  const back = await loadTokens(db, ops, uid, provider).catch(() => null);
  if (!back || back.accessToken !== t.accessToken) throw new TokenStoreError("Could not verify the stored connection. Check the encryption settings.");
}

export async function loadTokens(db: Db, ops: CryptoOps, uid: string, provider: string): Promise<StoredTokens | null> {
  const r = await db.from(CRED).select("access_token_enc,refresh_token_enc,expires_at,rev,scopes").eq("user_id", uid).eq("provider", provider).maybeSingle();
  if (r.error) throw new TokenStoreError("Could not read the connection (did you run 14_universal_connect.sql?).");
  if (!r.data) return null;
  try {
    return {
      accessToken: ops.decrypt(r.data.access_token_enc, aad(uid, provider, "access")),
      refreshToken: r.data.refresh_token_enc ? ops.decrypt(r.data.refresh_token_enc, aad(uid, provider, "refresh")) : null,
      expiresAt: r.data.expires_at ?? null, rev: Number(r.data.rev ?? 0), scopes: Array.isArray(r.data.scopes) ? r.data.scopes : [],
    };
  } catch { throw new ReauthRequired(); }   // unreadable (wrong key / tampered / copied): the safe answer is to connect again
}

export async function deleteTokens(db: Db, uid: string, provider: string): Promise<void> {
  const d = await db.from(CRED).delete().eq("user_id", uid).eq("provider", provider);
  if (d.error) throw new TokenStoreError("Could not remove the stored connection.");
}

/** A usable access token. Refreshes when it is about to expire. Refresh tokens rotate (WHOOP invalidates the old pair), so the new
 *  pair is written with a compare-and-set on `rev`: if another request refreshed first, its stored pair is used instead. */
export async function validAccessToken(db: Db, ops: CryptoOps, uid: string, provider: string, refresh: (refreshToken: string) => Promise<TokenSet>, now = new Date()): Promise<string> {
  const cur = await loadTokens(db, ops, uid, provider);
  if (!cur) throw new ReauthRequired();
  if (!needsRefresh(cur.expiresAt, now)) return cur.accessToken;
  if (!cur.refreshToken) throw new ReauthRequired();

  let next: TokenSet;
  try { next = await refresh(cur.refreshToken); }
  catch (e) {
    if (e instanceof OAuthError && e.status === 401) {
      const again = await loadTokens(db, ops, uid, provider);                 // lost a race? the winner already stored a fresh pair
      if (again && again.rev !== cur.rev && !needsRefresh(again.expiresAt, now)) return again.accessToken;
      throw new ReauthRequired();
    }
    throw e;
  }
  const keep = { ...next, refreshToken: next.refreshToken ?? cur.refreshToken, scopes: next.scopes.length ? next.scopes : cur.scopes };
  const u = await db.from(CRED).update({ ...encryptSet(ops, uid, provider, keep), rev: cur.rev + 1, updated_at: now.toISOString() })
    .eq("user_id", uid).eq("provider", provider).eq("rev", cur.rev).select("rev");
  if (u.error) throw new TokenStoreError("Could not store the refreshed connection.");
  if (!u.data || u.data.length === 0) {                                     // someone else refreshed meanwhile: use theirs
    const again = await loadTokens(db, ops, uid, provider);
    if (!again) throw new ReauthRequired();
    return again.accessToken;
  }
  return keep.accessToken;
}
