// Per-user scoping of every Strength item kept on this device. The authenticated user id is part of every storage name, so one
// account can never read another account's workouts, upload queue or caches, and signing out keeps each user's offline data.
//
// Legacy, unscoped data (written before scoping existed: IndexedDB "apex-strength", localStorage "apex-strength-*") has no known owner.
// It is never read, migrated or uploaded automatically: it stays untouched on the device (quarantined) until an explicit recovery exists.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only a well-formed auth user id may scope storage; anything else is refused instead of producing a shared name. */
export function assertUserId(userId: string | null | undefined): string {
  if (typeof userId !== "string" || !UUID.test(userId)) throw new Error("A signed-in user is required for local Strength data.");
  return userId.toLowerCase();
}

/** "apex-strength-history-v1" + user -> "apex-strength-history-v1:u:<id>". */
export const scopedKey = (base: string, userId: string): string => `${base}:u:${assertUserId(userId)}`;

export const LOCAL_KEY = "apex-strength-local-v1";
export const REST_KEY = "apex-strength-rest";
export const CUSTOM_KEY = "apex-strength-custom";
export const HIST_KEY = "apex-strength-history-v1";
export const ROUT_KEY = "apex-strength-routines-v1";
export const GYM_KEY = "apex-gym-equipment-v1";

/** The legacy, unscoped names. Never read by the app; listed here so tests can prove they stay isolated. */
export const LEGACY_KEYS = [LOCAL_KEY, REST_KEY, CUSTOM_KEY, HIST_KEY, ROUT_KEY, GYM_KEY] as const;
export const LEGACY_DB = "apex-strength";
export const scopedDb = (userId: string): string => `${LEGACY_DB}-u-${assertUserId(userId)}`;

/** Small per-user JSON preference on a device storage. Never reads the legacy unscoped key; with no user nothing is read or written. */
export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void }
export function readScoped<T>(kv: KV | null, base: string, userId: string | null | undefined, fallback: T): T {
  try { if (!kv || !userId) return fallback; const s = kv.getItem(scopedKey(base, userId)); return s === null ? fallback : (JSON.parse(s) as T); } catch { return fallback; }
}
export function writeScoped(kv: KV | null, base: string, userId: string | null | undefined, value: unknown): void {
  try { if (kv && userId) kv.setItem(scopedKey(base, userId), JSON.stringify(value)); } catch { /* optional */ }
}
