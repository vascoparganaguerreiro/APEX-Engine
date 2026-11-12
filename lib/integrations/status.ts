// Browser-side read of the user's integration state. Non-secret columns only (credentials tables are not readable by browsers).
// Every read is optional: a missing migration (13 or 14) degrades to "unknown", never to an error page.
//
// What each outcome means (P1.3). "Not set up" is reported ONLY when the database names the missing object itself:
//   Postgres 42P01 / PostgREST PGRST205 naming provider_connections, or 42703 / PGRST204 naming one of the columns this file selects.
//   Network failures, expired sessions, permission errors, timeouts and every other error are real errors: they are shown in plain words, with
//   "Try again" where trying again can help, and they NEVER switch the page to "needs setting up".
import type { Db } from "../connectionStore.ts";
import type { ConnSettings, ConnStatus } from "./syncState.ts";
import { friendlyError, logTechnical, type UserErrorKind } from "../userError.ts";

export interface DirectConn {
  provider: string; status: ConnStatus; connected_at: string | null; last_sync_at: string | null; last_success_at: string | null;
  last_error: string | null; last_error_at: string | null; next_retry_at: string | null; settings: ConnSettings; scopes: string[];
}
/** The state of the direct-connections table: usable, confirmed missing, or "could not be read" (with a safe message and whether to offer retry). */
export type ConnectionsState =
  | { status: "ready" }
  | { status: "not-set-up" }
  | { status: "error"; kind: Exclude<UserErrorKind, "not-set-up">; message: string; retryable: boolean };
export interface IntegrationSnapshot {
  intervals: { connected: boolean; athlete_id: string | null; last_sync_at: string | null };
  direct: DirectConn[];
  /** Kept for the page's gating of connect buttons: true only when provider_connections was read successfully. */
  migrated14: boolean;
  connections: ConnectionsState;
  /** A real (not "missing schema") failure of one of the other optional reads: the page still works, but says some details are missing. */
  partial: { message: string; retryable: boolean } | null;
  seenOrigins: Set<string>;
  latestDaily: string | null; latestByProvider: Record<string, string>;
}

export const PROVIDER_CONNECTION_COLUMNS = ["provider", "status", "connected_at", "last_sync_at", "last_success_at", "last_error", "last_error_at", "next_retry_at", "settings", "scopes"] as const;
const named = (msg: string, word: string) => new RegExp(`(^|[^a-z0-9_])${word}([^a-z0-9_]|$)`, "i").test(msg);
const parts = (e: unknown) => {
  const o = (e && typeof e === "object" ? e : {}) as { code?: unknown; message?: unknown };
  return { code: typeof o.code === "string" ? o.code : "", msg: typeof o.message === "string" ? o.message : "" };
};

/** True ONLY when the failure says provider_connections (or one of the columns selected from it) does not exist. */
export function isMissingProviderSchema(e: unknown): boolean {
  const { code, msg } = parts(e);
  if (code === "42P01" || code === "PGRST205") return named(msg, "provider_connections");
  if (code === "42703" || code === "PGRST204") return PROVIDER_CONNECTION_COLUMNS.some((c) => named(msg, c));
  return false;
}
/** activities.origin arrives with migration 13: its absence is expected and silent; any other failure of that read is real. */
const isMissingOrigin = (e: unknown) => { const { code, msg } = parts(e); return (code === "42703" || code === "PGRST204") && named(msg, "origin"); };

const toError = (e: unknown, what: string, scope: string) => {
  const u = friendlyError(e, what, { scope });
  return { kind: u.kind === "not-set-up" ? "other" : u.kind, message: u.message, retryable: u.retryable } as { kind: Exclude<UserErrorKind, "not-set-up">; message: string; retryable: boolean };
};

export async function loadSnapshot(db: Db): Promise<IntegrationSnapshot> {
  const out: IntegrationSnapshot = {
    intervals: { connected: false, athlete_id: null, last_sync_at: null }, direct: [], migrated14: false, connections: { status: "ready" }, partial: null,
    seenOrigins: new Set(), latestDaily: null, latestByProvider: {},
  };
  const partial = (e: unknown, scope: string) => { if (!out.partial) { const u = toError(e, "Some connection details could not be loaded", scope); out.partial = { message: u.message, retryable: u.retryable }; } };

  try {
    const c = await db.from("intervals_connections").select("athlete_id,last_sync_at").maybeSingle();
    if (c.error) partial(c.error, "integrations.intervals");
    else if (c.data) out.intervals = { connected: true, athlete_id: c.data.athlete_id ?? null, last_sync_at: c.data.last_sync_at ?? null };
  } catch (e) { partial(e, "integrations.intervals"); }

  try {
    const p = await db.from("provider_connections").select(PROVIDER_CONNECTION_COLUMNS.join(","));
    if (!p.error) { out.migrated14 = true; out.direct = (p.data ?? []) as DirectConn[]; }
    else if (isMissingProviderSchema(p.error)) { logTechnical("integrations.provider_connections.missing", p.error); out.connections = { status: "not-set-up" }; }
    else out.connections = { status: "error", ...toError(p.error, "Your connections could not be loaded", "integrations.provider_connections") };
  } catch (e) { out.connections = { status: "error", ...toError(e, "Your connections could not be loaded", "integrations.provider_connections") }; }

  try {   // which brands actually appear in recent activities (13 adds activities.origin)
    const a = await db.from("activities").select("origin").not("origin", "is", null).order("started_at", { ascending: false }).limit(1000);
    if (a.error) { if (!isMissingOrigin(a.error)) partial(a.error, "integrations.origins"); }
    else for (const r of (a.data ?? []) as Array<{ origin: string | null }>) if (r.origin) out.seenOrigins.add(r.origin.toUpperCase());
  } catch (e) { partial(e, "integrations.origins"); }

  try {
    const d = await db.from("daily_metrics").select("day").or("hrv_ms.not.is.null,rhr_bpm.not.is.null,sleep_minutes.not.is.null").order("day", { ascending: false }).limit(1);
    if (d.error) partial(d.error, "integrations.daily");
    else if (d.data?.[0]) out.latestDaily = String(d.data[0].day);
  } catch (e) { partial(e, "integrations.daily"); }

  if (out.migrated14) {
    for (const prov of ["whoop"]) {
      try {
        const o = await db.from("metric_observations").select("measured_at").eq("provider", prov).order("measured_at", { ascending: false }).limit(1);
        if (o.error) partial(o.error, "integrations.observations");
        else if (o.data?.[0]) out.latestByProvider[prov] = String(o.data[0].measured_at);
      } catch (e) { partial(e, "integrations.observations"); }
    }
  }
  return out;
}
