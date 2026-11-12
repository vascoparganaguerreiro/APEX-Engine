"use client";
// Quick log drawer. Every action reuses an existing write path:
//   wellness     -> apply_manual_metrics (06): only the fields you change are written; synced values elsewhere are untouched
//   supplements  -> supplement_intakes upsert/delete exactly like the Supplements page
//   Intervals    -> /api/intervals/sync (incremental)
// Everything else links to the module that owns the form.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import { syncIntervals } from "@/lib/api";
import { buildManualPatch, type MetricRow } from "@/lib/provenance";
import { SLOT_LABEL } from "@/lib/health/core";
import { SOURCE_TEXT, shortDate, type SupplementSummary } from "@/lib/today/model";

import { friendlyMessage } from "@/lib/userError";
const errMsg = (e: unknown) => friendlyMessage(e, "That could not be saved", { scope: "today.quicklog" });
export type QuickTab = "wellness" | "supplements" | "more";

export default function QuickLog({ open, tab, onTab, onClose, today, uid, sup, intervalsConnected, activeWorkout, onChanged }: {
  open: boolean; tab: QuickTab; onTab: (t: QuickTab) => void; onClose: () => void; today: string; uid: string;
  sup: SupplementSummary | null; intervalsConnected: boolean; activeWorkout: boolean; onChanged: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet td-sheet" role="dialog" aria-modal="true" aria-label="Quick log" onClick={(e) => e.stopPropagation()}>
        <div className="act-head"><h3 style={{ margin: 0 }}>Quick log</h3><button type="button" className="iconbtn" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close" autoFocus>✕</button></div>
        <div className="row" role="tablist" style={{ marginBottom: 14 }}>
          {(["wellness", "supplements", "more"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "chip on" : "chip"} onClick={() => onTab(t)}>
              {t === "wellness" ? "Wellness" : t === "supplements" ? `Supplements${sup?.pending ? ` (${sup.pending})` : ""}` : "More"}
            </button>
          ))}
        </div>
        {tab === "wellness" && <WellnessForm today={today} onSaved={onChanged} />}
        {tab === "supplements" && <SupplementLog today={today} uid={uid} sup={sup} onChanged={onChanged} />}
        {tab === "more" && <More intervalsConnected={intervalsConnected} activeWorkout={activeWorkout} onChanged={onChanged} />}
      </div>
    </div>
  );
}

/** The manual wellness form that used to sit at the bottom of Today, unchanged in behaviour. */
function WellnessForm({ today, onSaved }: { today: string; onSaved: () => void }) {
  const [day, setDay] = useState(today);
  const [existing, setExisting] = useState<MetricRow | null>(null);
  const [hrv, setHrv] = useState(""), [rhr, setRhr] = useState(""), [sleep, setSleep] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error" | "info"; text: string } | null>(null);

  // Selecting a day loads what is really saved for it (empty fields for a new day: no invented values).
  const loadDay = useCallback(async (d: string) => {
    const { data, error } = await getSupabase().from("daily_metrics").select("hrv_ms,rhr_bpm,sleep_minutes,sleep_score,hrv_source,rhr_source,sleep_source,sleep_score_source").eq("day", d).maybeSingle();
    if (error) { setMsg({ kind: "error", text: errMsg(error) }); return; }
    const row = (data as MetricRow | null) ?? null;
    setExisting(row);
    setHrv(row?.hrv_ms != null ? String(row.hrv_ms) : ""); setRhr(row?.rhr_bpm != null ? String(row.rhr_bpm) : "");
    setSleep(row?.sleep_minutes != null ? String(Math.round((row.sleep_minutes / 60) * 100) / 100) : "");
  }, []);
  useEffect(() => { setMsg(null); void loadDay(day); }, [day, loadDay]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const res = buildManualPatch(existing, { hrv, rhr, sleepH: sleep });
    if (res.error !== undefined) { setMsg({ kind: "error", text: res.error }); return; }
    if (Object.keys(res.patch).length === 0) { setMsg({ kind: "info", text: "Nothing to save: no field was filled in or changed." }); return; }
    setSaving(true);
    const { error } = await getSupabase().rpc("apply_manual_metrics", { p_day: day, p_hrv: res.patch.hrv_ms ?? null, p_rhr: res.patch.rhr_bpm ?? null, p_sleep_minutes: res.patch.sleep_minutes ?? null });
    setSaving(false);
    if (error) { setMsg({ kind: "error", text: errMsg(error) }); return; }
    setMsg({ kind: "ok", text: `Saved for ${day === today ? "today" : shortDate(day)}.` });
    await loadDay(day); onSaved();
  }
  const src = (s: string | null | undefined) => (s ? <small>{SOURCE_TEXT[s] ?? s}</small> : null);
  return (
    <form onSubmit={save}>
      <p className="td-meta" style={{ marginTop: 0 }}>{existing ? `Editing the saved entry for ${day}. Only the fields you change are updated; a manual value is never replaced by a sync.` : `New entry for ${day}. Fill in only what you measured; empty fields stay empty.`}</p>
      {msg && <div className={`notice ${msg.kind === "info" ? "" : msg.kind}`} role={msg.kind === "error" ? "alert" : "status"}>{msg.text}</div>}
      <div className="formgrid">
        <label>Date<input type="date" value={day} max={today} onChange={(e) => setDay(e.target.value)} required /></label>
        <label>Overnight HRV (ms){existing?.hrv_ms != null && src(existing.hrv_source)}<input type="number" inputMode="decimal" step="0.1" min="1" value={hrv} onChange={(e) => setHrv(e.target.value)} /></label>
        <label>Resting HR (bpm){existing?.rhr_bpm != null && src(existing.rhr_source)}<input type="number" inputMode="numeric" step="1" min="20" value={rhr} onChange={(e) => setRhr(e.target.value)} /></label>
        <label>Sleep (hours){existing?.sleep_minutes != null && src(existing.sleep_source)}<input type="number" inputMode="decimal" step="0.25" min="0.25" value={sleep} onChange={(e) => setSleep(e.target.value)} /></label>
      </div>
      <button className="btn" style={{ marginTop: 14 }} disabled={saving} type="submit">{saving ? "Saving…" : "Save"}</button>
    </form>
  );
}

function SupplementLog({ today, uid, sup, onChanged }: { today: string; uid: string; sup: SupplementSummary | null; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!sup || sup.due.length === 0) return <p className="td-empty">Nothing is scheduled for today. Manage schedules in <Link href="/supplements">Supplements</Link>.</p>;
  async function mark(supId: string, slot: string, dose: number, unit: string, status: "taken" | "skipped" | null) {
    const k = `${supId}|${slot}`; setBusy(k); setError(null);
    const sb = getSupabase();
    const { error: err } = status
      ? await sb.from("supplement_intakes").upsert({ user_id: uid, supplement_id: supId, slot, day: today, status, dose, dose_unit: unit }, { onConflict: "user_id,supplement_id,slot,day" })
      : await sb.from("supplement_intakes").delete().eq("supplement_id", supId).eq("slot", slot).eq("day", today);
    setBusy(null);
    if (err) { setError(errMsg(err)); return; }
    onChanged();
  }
  return (
    <div>
      {error && <div className="notice error" role="alert">{error}</div>}
      {sup.due.map((d) => {
        const k = `${d.supplement_id}|${d.slot}`;
        return (
          <div key={k} className={`doserow${d.status ? " off" : ""}`}>
            <span style={{ flex: 1, minWidth: 140 }}><b>{d.name}</b><br /><span className="td-meta">{SLOT_LABEL[d.slot as keyof typeof SLOT_LABEL] ?? d.slot} · {d.dose} {d.dose_unit}{d.status ? ` · ${d.status}` : ""}</span></span>
            {d.status ? <button type="button" className="chip" disabled={busy === k} onClick={() => void mark(d.supplement_id, d.slot, d.dose, d.dose_unit, null)}>Undo</button> : (
              <>
                <button type="button" className="chip on" disabled={busy === k} onClick={() => void mark(d.supplement_id, d.slot, d.dose, d.dose_unit, "taken")}>Taken</button>
                <button type="button" className="chip" disabled={busy === k} onClick={() => void mark(d.supplement_id, d.slot, d.dose, d.dose_unit, "skipped")}>Skipped</button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function More({ intervalsConnected, activeWorkout, onChanged }: { intervalsConnected: boolean; activeWorkout: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  async function sync() {
    setBusy(true); setMsg(null);
    try { const r = await syncIntervals(); setMsg({ kind: "ok", text: `Synced: ${r.activities} activities and ${r.wellness} wellness days.` }); onChanged(); }
    catch (e) { setMsg({ kind: "error", text: errMsg(e) }); } finally { setBusy(false); }
  }
  return (
    <div className="td-actions">
      {msg && <div className={`notice ${msg.kind}`} role={msg.kind === "error" ? "alert" : "status"}>{msg.text}</div>}
      <Link className="pickrow" href="/strength"><span><b>{activeWorkout ? "Continue workout" : "Start a workout"}</b><br /><span className="td-meta">Strength Hub · works offline</span></span><span aria-hidden>→</span></Link>
      {intervalsConnected
        ? <button type="button" className="pickrow" disabled={busy} onClick={() => void sync()}><span><b>{busy ? "Syncing…" : "Sync Intervals.icu"}</b><br /><span className="td-meta">import new activities and wellness</span></span><span aria-hidden>↻</span></button>
        : <Link className="pickrow" href="/integrations"><span><b>Connect a device</b><br /><span className="td-meta">Intervals.icu, WHOOP and more</span></span><span aria-hidden>→</span></Link>}
      <Link className="pickrow" href="/coach"><span><b>Evaluate a session</b><br /><span className="td-meta">APEX Coach</span></span><span aria-hidden>→</span></Link>
      <Link className="pickrow" href="/biomarkers"><span><b>Add a blood test</b><br /><span className="td-meta">upload a report or enter results</span></span><span aria-hidden>→</span></Link>
      <Link className="pickrow" href="/races"><span><b>Add a race</b><br /><span className="td-meta">Races</span></span><span aria-hidden>→</span></Link>
    </div>
  );
}
