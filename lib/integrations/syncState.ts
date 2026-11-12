// Connection and sync status per (user, provider), table provider_connections (14_universal_connect.sql).
// Written only by the server (service role); the browser may read the non-secret columns. No framework imports: testable with a fake db.
// Error messages stored here are short fixed texts chosen by APEX: never provider bodies, tokens or health values.
import type { Db } from "../connectionStore.ts";

const T = "provider_connections";
export type ConnStatus = "connected" | "reauth_required" | "error" | "disconnected";
export interface ConnSettings { fill_daily?: boolean; import_workouts?: boolean }
export interface ConnRow {
  status: ConnStatus; failures: number; next_retry_at: string | null; last_success_at: string | null; cursor: Record<string, unknown> | null; settings: ConnSettings;
}
export const LEASE_MS = 3 * 60_000;

export class SyncBusy extends Error { status = 409; constructor() { super("A sync for this connection is already running. Try again in a few minutes."); } }
export class SyncDeferred extends Error {
  status = 429; retryAt: string;
  constructor(retryAt: string) { super(`Paused after repeated errors or a rate limit. Try again after ${new Date(retryAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC.`); this.retryAt = retryAt; }
}

/** After 3 consecutive failures, wait 5 min, then 10, 20 ... up to 6 h. */
export function backoffUntil(failures: number, now: Date): string | null {
  if (failures < 3) return null;
  return new Date(now.getTime() + Math.min(6 * 3_600_000, 5 * 60_000 * 2 ** (failures - 3))).toISOString();
}

export async function readConn(db: Db, uid: string, provider: string): Promise<ConnRow | null> {
  const r = await db.from(T).select("status,failures,next_retry_at,last_success_at,cursor,settings").eq("user_id", uid).eq("provider", provider).maybeSingle();
  if (r.error) throw new Error("provider_connections unavailable");
  if (!r.data) return null;
  return { status: r.data.status, failures: Number(r.data.failures ?? 0), next_retry_at: r.data.next_retry_at ?? null, last_success_at: r.data.last_success_at ?? null,
    cursor: r.data.cursor ?? null, settings: (r.data.settings ?? {}) as ConnSettings };
}

/** New connection or reconnection: status connected, errors cleared. User settings and the sync cursor are kept. */
export async function markConnected(db: Db, uid: string, provider: string, transport: string, info: { externalUserId: string | null; scopes: string[] }, now = new Date()): Promise<void> {
  const w = await db.from(T).upsert({
    user_id: uid, provider, transport, status: "connected", external_user_id: info.externalUserId, scopes: info.scopes, connected_at: now.toISOString(),
    failures: 0, last_error: null, last_error_at: null, next_retry_at: null, lease_until: null,
  }, { onConflict: "user_id,provider" });
  if (w.error) throw new Error("Could not save the connection status.");
}

/** Take the per-connection lease so two syncs never run at once (a WHOOP refresh invalidates the previous token). */
export async function acquireLease(db: Db, uid: string, provider: string, now = new Date(), opts: { create?: string } = {}): Promise<ConnRow> {
  if (opts.create) await db.from(T).upsert({ user_id: uid, provider, transport: opts.create, status: "connected" }, { onConflict: "user_id,provider", ignoreDuplicates: true });
  const row = await readConn(db, uid, provider);
  if (!row || row.status === "disconnected") throw Object.assign(new Error("This provider is not connected."), { status: 404 });
  if (row.next_retry_at && Date.parse(row.next_retry_at) > now.getTime()) throw new SyncDeferred(row.next_retry_at);
  const nowIso = now.toISOString();
  const u = await db.from(T).update({ lease_until: new Date(now.getTime() + LEASE_MS).toISOString(), last_sync_started_at: nowIso })
    .eq("user_id", uid).eq("provider", provider).or(`lease_until.is.null,lease_until.lt.${nowIso}`).select("provider");
  if (u.error) throw new Error("Could not start the sync.");
  if (!u.data || u.data.length === 0) throw new SyncBusy();
  return row;
}

export async function finishSuccess(db: Db, uid: string, provider: string, cursor: Record<string, unknown>, now = new Date()): Promise<void> {
  await db.from(T).update({
    status: "connected", lease_until: null, last_sync_at: now.toISOString(), last_success_at: now.toISOString(), failures: 0,
    last_error: null, last_error_at: null, next_retry_at: null, cursor,
  }).eq("user_id", uid).eq("provider", provider);
}

/** Record a failure. `retryAt` (e.g. from a 429) wins over the computed back-off. reauth marks the connection as needing the user. */
export async function finishError(db: Db, uid: string, provider: string, prevFailures: number, message: string, o: { reauth?: boolean; retryAt?: string | null } = {}, now = new Date()): Promise<void> {
  const failures = prevFailures + 1;
  await db.from(T).update({
    status: o.reauth ? "reauth_required" : "error", lease_until: null, last_sync_at: now.toISOString(), failures,
    last_error: message.slice(0, 200), last_error_at: now.toISOString(), next_retry_at: o.retryAt ?? backoffUntil(failures, now),
  }).eq("user_id", uid).eq("provider", provider);
}

export async function markDisconnected(db: Db, uid: string, provider: string, now = new Date()): Promise<void> {
  await db.from(T).update({ status: "disconnected", lease_until: null, next_retry_at: null, last_error: null, disconnected_at: now.toISOString() }).eq("user_id", uid).eq("provider", provider);
}

export async function saveSettings(db: Db, uid: string, provider: string, patch: ConnSettings): Promise<ConnSettings> {
  const row = await readConn(db, uid, provider);
  if (!row) throw Object.assign(new Error("This provider is not connected."), { status: 404 });
  const next: ConnSettings = { ...row.settings };
  if (typeof patch.fill_daily === "boolean") next.fill_daily = patch.fill_daily;
  if (typeof patch.import_workouts === "boolean") next.import_workouts = patch.import_workouts;
  const u = await db.from(T).update({ settings: next }).eq("user_id", uid).eq("provider", provider);
  if (u.error) throw new Error("Could not save the settings.");
  return next;
}
