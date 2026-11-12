"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import { disconnectProvider, integrationConfig, saveProviderSettings, startConnection, syncIntervals, syncProvider } from "@/lib/api";
import { CATEGORY_LABEL, PROVIDERS, STATUS_LABEL, cardState, type ProviderInfo, type UserIntegrationState } from "@/lib/integrations/providers";
import { freshness } from "@/lib/integrations/normalize";
import { loadSnapshot, type DirectConn, type IntegrationSnapshot } from "@/lib/integrations/status";

type Db = Parameters<typeof loadSnapshot>[0];

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "never");
const RESULT_TEXT: Record<string, { kind: "ok" | "error"; text: string }> = {
  connected: { kind: "ok", text: "Connected. Press Sync now to import your data." },
  denied: { kind: "error", text: "The connection was cancelled on the provider's page. Nothing was changed." },
  expired: { kind: "error", text: "The connection took too long (over 10 minutes). Please try again." },
  invalid_state: { kind: "error", text: "The connection could not be verified (it must be finished in the same browser that started it). Please try again." },
  rejected: { kind: "error", text: "The provider rejected the authorization. Please try again." },
  server_error: { kind: "error", text: "The connection could not be completed. Please try again later." },
};
const STATUS_CLASS: Record<string, string> = { connected: "badge", via_intervals: "badge", available: "badge off", requires_approval: "badge off", requires_native_app: "badge off", not_supported: "badge off" };

export default function IntegrationsPage() {
  const { session } = useAuth();
  const [snap, setSnap] = useState<IntegrationSnapshot | null>(null);
  const [configured, setConfigured] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    const [s, c] = await Promise.all([loadSnapshot(getSupabase() as unknown as Db), integrationConfig().catch(() => ({ configured: [] as string[] }))]);
    setSnap(s); setConfigured(new Set(c.configured));
  }, [session]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {   // result of an OAuth round trip (?provider=whoop&result=connected); the URL never carries tokens
    const q = new URLSearchParams(window.location.search), r = q.get("result");
    if (r && RESULT_TEXT[r]) { setMsg(RESULT_TEXT[r]); window.history.replaceState(null, "", "/integrations"); }
  }, []);

  const state: UserIntegrationState | null = useMemo(() => snap && {
    intervalsConnected: snap.intervals.connected, seenOrigins: snap.seenOrigins, configured,
    direct: Object.fromEntries(snap.direct.map((d) => [d.provider, d.status])),
  }, [snap, configured]);

  async function run(key: string, f: () => Promise<string | void>) {
    setBusy(key); setMsg(null);
    try { const t = await f(); if (t) setMsg({ kind: "ok", text: t }); await load(); }
    catch (e) { setMsg({ kind: "error", text: errMsg(e) }); await load(); }
    finally { setBusy(null); }
  }
  const connect = (p: string) => run(`connect:${p}`, async () => { const { url } = await startConnection(p); window.location.assign(url); });
  const disconnect = (p: ProviderInfo) => {
    if (!window.confirm(`Disconnect ${p.name}? APEX revokes its access. Data already imported is kept.`)) return;
    run(`disconnect:${p.id}`, async () => { const r = await disconnectProvider(p.id); return r.revoked ? `${p.name} disconnected and access revoked.` : `${p.name} disconnected. Also remove APEX in ${p.name}'s own app settings to be sure.`; });
  };
  const syncNow = (p: ProviderInfo) => run(`sync:${p.id}`, async () => {
    if (p.id === "intervals") { const r = await syncIntervals(); return `Intervals.icu: ${r.activities} activities and ${r.wellness} wellness days (${r.oldest} to ${r.newest}).${r.notes.length ? " " + r.notes.join(" ") : ""}`; }
    const r = await syncProvider("whoop");
    return `WHOOP: ${r.observations} values saved${r.dailyFilled ? `, ${r.dailyFilled} daily entries filled` : ""}${r.workoutsImported ? `, ${r.workoutsImported} workouts added` : ""}.${r.notes.length ? " " + r.notes.join(" ") : ""}`;
  });
  const setting = (key: "fill_daily" | "import_workouts", value: boolean) => run(`setting:${key}`, async () => { await saveProviderSettings("whoop", { [key]: value }); return "Saved."; });

  if (!snap || !state) return <><div className="eyebrow">Account</div><h1>Connectivity Centre</h1><p className="muted">Loading…</p></>;
  const direct = (id: string): DirectConn | undefined => snap.direct.find((d) => d.provider === id);

  return (
    <>
      <div className="eyebrow">Account</div>
      <h1>Connectivity Centre</h1>
      <p className="muted small">Where your data comes from. <b>Direct</b> connections are made by APEX itself. <b>Through Intervals.icu</b> means the brand sends its activities to Intervals.icu and APEX reads them there. Measurements always keep the device that made them and the route they took; scores from different brands (WHOOP Recovery, Garmin readiness…) are never treated as the same thing. Credentials are never shown on this page.</p>
      {msg && <div className={`notice ${msg.kind}`} role={msg.kind === "error" ? "alert" : "status"}>{msg.text}</div>}
      {!snap.migrated14 && <div className="notice">Sync status and direct connections such as WHOOP need a database update (migration 14) that has not been applied yet. Intervals.icu keeps working as before.</div>}

      {PROVIDERS.map((p) => {
        const c = cardState(p, state), d = direct(p.id);
        const cats = p.id === "intervals" ? p.direct : c.status === "connected" ? p.direct : p.viaIntervals.length ? p.viaIntervals : p.direct;
        const last = p.id === "intervals" ? snap.intervals.last_sync_at : d?.last_success_at ?? null;
        const latest = p.id === "intervals" ? snap.latestDaily : snap.latestByProvider[p.id] ?? null;
        const fresh = c.status === "connected" ? freshness(latest, new Date()) : null;
        return (
          <section key={p.id} className="card psec">
            <div className="act-head">
              <h2 style={{ margin: 0 }}>{p.name}</h2>
              <span className={STATUS_CLASS[c.status]}>{STATUS_LABEL[c.status]}</span>
              <span className="muted small">{c.directLabel}</span>
            </div>
            {c.note && <p className="muted small">{c.note}</p>}
            {c.seenInData && c.status !== "connected" && <p className="muted small">Activities from {p.name} were found in your data.</p>}
            {cats.length > 0 && <p className="small" style={{ margin: "6px 0" }}><span className="muted">Data APEX can receive: </span>{cats.map((k) => CATEGORY_LABEL[k]).join(", ")}</p>}
            <p className="muted small" style={{ margin: "6px 0" }}><b>Permissions:</b> {p.permissions} <b>Limits:</b> {p.limits}</p>
            {c.status === "connected" && (
              <div className="metrics">
                <div><small>Last successful sync</small><b>{when(last)}</b></div>
                <div><small>Latest data</small><b>{latest ? latest.slice(0, 10) : "none yet"}</b>{fresh === "stale" && <small className="muted">older than 36 hours</small>}</div>
                {d?.last_error && <div><small>Last error</small><b style={{ fontSize: 14 }}>{d.last_error}</b><small className="muted">{when(d.last_error_at)}</small></div>}
                {d?.next_retry_at && Date.parse(d.next_retry_at) > Date.now() && <div><small>Paused until</small><b>{when(d.next_retry_at)}</b></div>}
              </div>
            )}
            {c.setupMissing.length > 0 && <p className="muted small">Server set-up needed: {c.setupMissing.join(", ")} (see docs/universal-connect.md).</p>}
            <div className="row">
              {p.id === "intervals" && (
                <>
                  {snap.intervals.connected && <button className="btn" disabled={busy !== null} onClick={() => syncNow(p)}>{busy === "sync:intervals" ? "Syncing…" : "Sync now"}</button>}
                  <Link className="btn ghost" href="/import">{snap.intervals.connected ? "Manage API key" : "Connect with API key"}</Link>
                  {!snap.intervals.connected && configured.has("INTERVALS_CLIENT_ID") && snap.migrated14 &&
                    <button className="btn ghost" disabled={busy !== null} onClick={() => connect("intervals")}>Sign in with Intervals.icu</button>}
                  {d && d.status !== "disconnected" && d.scopes.some((s) => s !== "personal_key") &&
                    <button className="btn ghost" disabled={busy !== null} onClick={() => disconnect(p)}>Disconnect sign-in</button>}
                </>
              )}
              {p.id === "whoop" && (
                <>
                  {c.canConnect && snap.migrated14 && <button className="btn" disabled={busy !== null} onClick={() => connect("whoop")}>{busy === "connect:whoop" ? "Opening WHOOP…" : c.status === "connected" ? "Connect again" : "Connect WHOOP"}</button>}
                  {c.status === "connected" && d && d.status !== "reauth_required" && <button className="btn" disabled={busy !== null} onClick={() => syncNow(p)}>{busy === "sync:whoop" ? "Syncing…" : "Sync now"}</button>}
                  {c.status === "connected" && <button className="btn ghost" disabled={busy !== null} onClick={() => disconnect(p)}>Disconnect</button>}
                </>
              )}
            </div>
            {p.id === "whoop" && c.status === "connected" && d && (
              <div style={{ marginTop: 10 }}>
                <label className="row small"><input type="checkbox" checked={!!d.settings.fill_daily} disabled={busy !== null} onChange={(e) => setting("fill_daily", e.target.checked)} />
                  Use WHOOP HRV, resting heart rate and sleep for days that have no value yet (your own entries and other sources are never replaced)</label>
                <label className="row small"><input type="checkbox" checked={!!d.settings.import_workouts} disabled={busy !== null} onChange={(e) => setting("import_workouts", e.target.checked)} />
                  Add WHOOP workouts to Activities (leave off if your watch already records them; duplicates can be merged under Strength → Duplicates)</label>
              </div>
            )}
          </section>
        );
      })}
      <p className="muted small">Details, sources and what each provider really offers: see the provider audit in the project documentation (docs/universal-connect.md).</p>
    </>
  );
}
