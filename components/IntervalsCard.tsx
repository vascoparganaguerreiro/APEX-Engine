"use client";
import { useCallback, useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { errMsg } from "@/lib/errors";
import { connectIntervals, disconnectIntervals, syncIntervals } from "@/lib/api";

type Conn = { athlete_id: string; last_sync_at: string | null };
type Msg = { kind: "ok" | "error"; text: string } | null;
type Busy = "connect" | "disconnect" | "sync" | null;

const SYNC_DAYS = 120;

export default function IntervalsCard() {
  const [conn, setConn] = useState<Conn | null | undefined>(undefined); // undefined = loading
  const [athleteId, setAthleteId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(async () => {
    // Only non-secret columns: the browser just needs to know that a connection exists.
    const { data, error } = await getSupabase().from("intervals_connections").select("athlete_id,last_sync_at").maybeSingle();
    if (error) { setMsg({ kind: "error", text: error.message }); setConn(null); return; }
    setConn((data as Conn | null) ?? null);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy("connect"); setMsg(null);
    try {
      const r = await connectIntervals(athleteId, apiKey);
      setApiKey("");
      setMsg({ kind: "ok", text: `Connected${r.athlete.name ? ` as ${r.athlete.name}` : ""}.` });
      await load();
    } catch (err) {
      setMsg({ kind: "error", text: errMsg(err) });
    } finally { setBusy(null); }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect Intervals.icu? Imported data is kept.")) return;
    setBusy("disconnect"); setMsg(null);
    try {
      await disconnectIntervals();
      setMsg({ kind: "ok", text: "Disconnected." });
      await load();
    } catch (err) {
      setMsg({ kind: "error", text: errMsg(err) });
    } finally { setBusy(null); }
  }

  async function sync() {
    setBusy("sync"); setMsg(null);
    try {
      const r = await syncIntervals(SYNC_DAYS);
      setMsg({ kind: "ok", text: `Synced the last ${r.days} days: ${r.activities} activities and ${r.wellness} wellness days.` });
      await load();
    } catch (err) {
      setMsg({ kind: "error", text: errMsg(err) });
    } finally { setBusy(null); }
  }

  const connected = !!conn;
  return (
    <div className="card">
      <div className="act-head">
        <h2 style={{ margin: 0 }}>Intervals.icu</h2>
        {conn === undefined
          ? <span className="muted small">Loading…</span>
          : <span className="badge" style={connected ? undefined : { color: "var(--muted)" }}>{connected ? "Connected" : "Not connected"}</span>}
      </div>

      {msg && <div className={`notice ${msg.kind}`} role={msg.kind === "error" ? "alert" : "status"}>{msg.text}</div>}

      {conn === undefined ? null : connected ? (
        <>
          <div className="metrics">
            <div><small>Athlete ID</small><b>{conn.athlete_id}</b></div>
            <div><small>Last sync</small><b>{conn.last_sync_at ? new Date(conn.last_sync_at).toLocaleString() : "Never"}</b></div>
          </div>
          <div className="row">
            <button className="btn" onClick={sync} disabled={busy !== null}>
              {busy === "sync" ? `Syncing ${SYNC_DAYS} days…` : `Sync last ${SYNC_DAYS} days`}
            </button>
            <button className="btn ghost" onClick={disconnect} disabled={busy !== null}>
              {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
          {busy === "sync" && <p className="muted small">This can take up to a minute. Keep this page open.</p>}
        </>
      ) : (
        <form onSubmit={connect}>
          <p className="muted small">Find both in Intervals.icu under Settings → Developer Settings.</p>
          <label>Athlete ID
            <input value={athleteId} onChange={(e) => setAthleteId(e.target.value)} placeholder="i12345" autoComplete="off" required />
          </label>
          <label>API Key
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" required />
          </label>
          <button className="btn" type="submit" disabled={busy !== null}>
            {busy === "connect" ? "Validating…" : "Save and validate"}
          </button>
        </form>
      )}
    </div>
  );
}
