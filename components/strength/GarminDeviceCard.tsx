"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { errText, sdb } from "@/lib/strength/hooks";
import { NotSetUp, garminSyncStatus, loadDevice, saveDevice, type Device } from "@/lib/strength/data";
import { ADAPTERS } from "@/lib/strength/garmin/adapters";
import { WORKOUT_SPORTS } from "@/lib/strength/garmin/structured";
import { useSyncStatus } from "@/lib/strength/runtime";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");
const MODELS: Record<Device["model"], string> = { forerunner_965: "Garmin Forerunner 965", other_garmin: "Another Garmin watch", other: "Another device" };

/** Profile section: the wearable APEX is set up for, how its data arrives, and what can (and cannot yet) be sent to it. No credentials. */
export default function GarminDeviceCard({ uid, intervals }: { uid: string; intervals: { connected: boolean; last_sync_at: string | null } | null }) {
  const [device, setDevice] = useState<Device | null>(null);
  const [setUp, setSetUp] = useState<boolean | null>(null);
  const [garmin, setGarmin] = useState<{ lastGarminActivity: string | null; provenance: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { status } = useSyncStatus();
  useEffect(() => {
    loadDevice(sdb()).then((d) => { setDevice(d); setSetUp(true); }).catch((e) => { if (e instanceof NotSetUp) setSetUp(false); else setError(errText(e)); });
    garminSyncStatus(sdb()).then(setGarmin).catch(() => setGarmin({ lastGarminActivity: null, provenance: false }));
  }, []);
  async function choose(model: Device["model"]) {
    try { await saveDevice(sdb(), uid, { model }); setDevice({ ...(device ?? { lastExportAt: null, lastExportKind: null, lastExportNote: null }), model }); }
    catch (e) { setError(e instanceof NotSetUp ? e.message : errText(e)); }
  }
  const model = device?.model ?? "forerunner_965";
  return (
    <section className="card psec">
      <h2>Wearable device</h2>
      {error && <div className="notice error">{error}</div>}
      {setUp === false && <div className="notice">Device settings aren&apos;t set up for your account yet. Until they are, the Forerunner 965 is assumed and nothing is saved.</div>}
      <label>Device<select value={model} disabled={setUp !== true} onChange={(e) => void choose(e.target.value as Device["model"])}>{(Object.keys(MODELS) as Device["model"][]).map((m) => <option key={m} value={m}>{MODELS[m]}</option>)}</select></label>
      <div className="intlist">
        <div className="doserow"><b>Garmin connection</b>
          <span className={intervals?.connected ? "badge" : "badge off"}>{intervals?.connected ? "Through Intervals.icu" : "Not connected"}</span>
          <span className="muted small">APEX has no direct Garmin Connect link. Activities from the watch reach APEX through Intervals.icu (Garmin Connect → Intervals.icu → APEX).</span></div>
        <div className="doserow"><b>Last successful sync</b><span className="muted small">Intervals.icu: {fmt(intervals?.last_sync_at ?? null)}{garmin?.provenance ? ` · newest activity marked as from Garmin: ${fmt(garmin.lastGarminActivity)}` : " · the activity origin is recorded once your account is fully set up"}</span></div>
        <div className="doserow"><b>Workout export</b>
          <span className="muted small">{ADAPTERS.map((a) => `${a.label.split(" (")[0]}: ${a.status === "available" ? "available" : a.status === "experimental" ? "experimental, not yet confirmed on the watch" : "not available (needs Garmin Training API approval)"}`).join(" · ")}.
            {device?.lastExportAt ? ` Last download: ${fmt(device.lastExportAt)} (${device.lastExportKind}). APEX cannot see whether it reached the watch.` : ""}</span>
          <Link className="chip" href="/strength/export" style={{ marginLeft: "auto" }}>Export</Link></div>
        <div className="doserow"><b>Workout types</b><span className="muted small">{WORKOUT_SPORTS.join(", ")} (structured steps with targets, repeats, rest)</span></div>
        <div className="doserow"><b>Sync errors</b><span className="muted small">{status ? (status.failed ? `${status.failed} workout change(s) could not be saved: ${status.message ?? ""}` : status.message ?? "None for workouts on this device.") : "Checking…"} Intervals.icu sync errors are shown on the Import page when you sync.</span></div>
      </div>
      <p className="muted small" style={{ marginBottom: 0 }}>Garmin activity history in APEX is never edited or deleted. Duplicates (e.g. the same session in Hevy) are linked, not removed, on the Strength → Duplicates page.</p>
    </section>
  );
}
