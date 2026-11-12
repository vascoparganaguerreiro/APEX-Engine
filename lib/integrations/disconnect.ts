// Disconnect a direct OAuth connection: revoke at the provider (best effort), delete the stored tokens, mark the connection
// disconnected. Imported data is KEPT (the user can delete it separately). Testable with fakes.
import type { CryptoOps, Db } from "../connectionStore.ts";
import { deleteTokens, loadTokens } from "./tokenStore.ts";
import { markDisconnected } from "./syncState.ts";

export async function disconnectProvider(a: { admin: Db; ops: CryptoOps; uid: string; provider: string; revoke: (accessToken: string) => Promise<boolean>; freshToken?: () => Promise<string> }): Promise<{ revoked: boolean; hadTokens: boolean }> {
  let tokens = null;
  try { tokens = await loadTokens(a.admin, a.ops, a.uid, a.provider); } catch { tokens = null; }   // unreadable tokens are still deleted
  let revoked = false;
  if (tokens) {
    let access = tokens.accessToken;
    if (a.freshToken) { try { access = await a.freshToken(); } catch { /* revoke with what we have */ } }   // an expired token cannot revoke
    try { revoked = await a.revoke(access); } catch { revoked = false; }
  }
  await deleteTokens(a.admin, a.uid, a.provider);
  await markDisconnected(a.admin, a.uid, a.provider);
  return { revoked, hadTokens: !!tokens };
}
