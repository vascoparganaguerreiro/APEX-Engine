// Browser-side read of the user's integration state. Non-secret columns only (credentials tables are not readable by browsers).
// Every read is optional: a missing migration (13 or 14) degrades to "unknown", never to an error page.
import type { Db } from "../connectionStore.ts";
import type { ConnSettings, ConnStatus } from "./syncState.ts";

export interface DirectConn {
  provider: string; status: ConnStatus; connected_at: string | null; last_sync_at: string | null; last_success_at: string | null;
  last_error: string | null; last_error_at: string | null; next_retry_at: string | null; settings: ConnSettings; scopes: string[];
}
export interface IntegrationSnapshot {
  intervals: { connected: boolean; athlete_id: string | null; last_sync_at: string | null };
  direct: DirectConn[]; migrated14: boolean;
  seenOrigins: Set<string>;
  latestDaily: string | null; latestByProvider: Record<string, string>;
}

export async function loadSnapshot(db: Db): Promise<IntegrationSnapshot> {
  const out: IntegrationSnapshot = { intervals: { connected: false, athlete_id: null, last_sync_at: null }, direct: [], migrated14: false, seenOrigins: new Set(), latestDaily: null, latestByProvider: {} };
  try {
    const c = await db.from("intervals_connections").select("athlete_id,last_sync_at").maybeSingle();
    if (c.data) out.intervals = { connected: true, athlete_id: c.data.athlete_id ?? null, last_sync_at: c.data.last_sync_at ?? null };
  } catch { /* optional */ }
  try {
    const p = await db.from("provider_connections").select("provider,status,connected_at,last_sync_at,last_success_at,last_error,last_error_at,next_retry_at,settings,scopes");
    if (!p.error) { out.migrated14 = true; out.direct = (p.data ?? []) as DirectConn[]; }
  } catch { /* migration 14 not applied */ }
  try {   // which brands actually appear in recent activities (13 adds activities.origin)
    const a = await db.from("activities").select("origin").not("origin", "is", null).order("started_at", { ascending: false }).limit(1000);
    if (!a.error) for (const r of (a.data ?? []) as Array<{ origin: string | null }>) if (r.origin) out.seenOrigins.add(r.origin.toUpperCase());
  } catch { /* migration 13 not applied */ }
  try {
    const d = await db.from("daily_metrics").select("day").or("hrv_ms.not.is.null,rhr_bpm.not.is.null,sleep_minutes.not.is.null").order("day", { ascending: false }).limit(1);
    if (!d.error && d.data?.[0]) out.latestDaily = String(d.data[0].day);
  } catch { /* optional */ }
  if (out.migrated14) {
    for (const prov of ["whoop"]) {
      try {
        const o = await db.from("metric_observations").select("measured_at").eq("provider", prov).order("measured_at", { ascending: false }).limit(1);
        if (!o.error && o.data?.[0]) out.latestByProvider[prov] = String(o.data[0].measured_at);
      } catch { /* optional */ }
    }
  }
  return out;
}
