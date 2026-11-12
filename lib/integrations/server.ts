// Server-only wiring for Universal Connect. Import ONLY from route handlers.
import { adminClient } from "@/lib/serverConnections";
import { decryptSecret, encryptSecret, needsRotation } from "@/lib/crypto";
import type { CryptoOps } from "@/lib/connectionStore";
import { OAuthError } from "./oauth";
import { ReauthRequired, TokenStoreError } from "./tokenStore";
import { SyncBusy, SyncDeferred } from "./syncState";
import { WhoopError } from "./whoop";

export { adminClient };
export const cryptoOps: CryptoOps = {
  encrypt: (plain, aad) => encryptSecret(plain, aad),
  decrypt: (blob, aad) => decryptSecret(blob, aad),
  needsRotation: (blob) => needsRotation(blob),
};

/** True when the error means migration 14 has not been applied (table or function missing). */
export const missingTable = (e: unknown) => {
  const x = e as { code?: string; message?: string } | null;
  return !!x && (x.code === "42P01" || x.code === "PGRST205" || x.code === "PGRST202" || /does not exist|schema cache|could not find the table|provider_connections unavailable/i.test(x.message ?? ""));
};

/** Status + fixed user-facing message for integration errors. Never includes provider bodies, tokens or health values. */
export function integrationError(e: unknown): { status: number; message: string; reauth: boolean; retryAt: string | null } {
  if (e instanceof ReauthRequired) return { status: 401, message: e.message, reauth: true, retryAt: null };
  if (e instanceof WhoopError) return { status: e.status, message: e.message, reauth: e.reauth, retryAt: e.retryAt };
  if (e instanceof OAuthError) return { status: e.status, message: e.message, reauth: e.status === 401, retryAt: null };
  if (e instanceof SyncBusy || e instanceof SyncDeferred) return { status: e.status, message: e.message, reauth: false, retryAt: e instanceof SyncDeferred ? e.retryAt : null };
  if (e instanceof TokenStoreError) return { status: 500, message: e.message, reauth: false, retryAt: null };
  const s = (e as { status?: unknown })?.status;
  if (typeof s === "number" && s >= 400 && s < 600 && e instanceof Error) return { status: s, message: e.message, reauth: s === 401, retryAt: null };
  return { status: 500, message: "Unexpected error.", reauth: false, retryAt: null };
}
