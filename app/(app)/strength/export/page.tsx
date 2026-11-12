"use client";
import { useMemo, useState } from "react";
import { useAuth } from "@/lib/useAuth";
import { errText, sdb, useLibrary, useRoutines } from "@/lib/strength/hooks";
import { saveDevice } from "@/lib/strength/data";
import { ADAPTERS, type ExportAdapter } from "@/lib/strength/garmin/adapters";
import { describe, intervalWorkout, routineToStructured, validateStructured, type StructuredWorkout, type Target, type WorkoutSport } from "@/lib/strength/garmin/structured";
import { SetupNotice, StrengthNav } from "@/components/strength/Bits";

function download(name: string, mime: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const STATUS = { available: "Available", experimental: "Experimental", requires_approval: "Needs Garmin approval" } as const;

export default function ExportPage() {
  const { session } = useAuth();
  const lib = useLibrary();
  const rts = useRoutines();
  const [source, setSource] = useState<"routine" | "intervals">("routine");
  const [rid, setRid] = useState("");
  const [date, setDate] = useState("");
  const [iv, setIv] = useState({ name: "Intervals", sport: "running" as Exclude<WorkoutSport, "strength">, warmupMin: 15, cooldownMin: 10, repeats: 5, workMin: 3, recoveryMin: 2, target: "pace" as "pace" | "heart_rate" | "power" | "open", lo: 240, hi: 255 });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const workout: StructuredWorkout | null = useMemo(() => {
    if (source === "routine") { const r = rts.routines?.find((x) => x.id === rid); return r ? { ...routineToStructured(r, lib.custom), scheduledDate: date || null } : null; }
    const target: Target = iv.target === "pace" ? { type: "pace", fastSPerKm: Math.min(iv.lo, iv.hi), slowSPerKm: Math.max(iv.lo, iv.hi) } : iv.target === "heart_rate" ? { type: "heart_rate", low: Math.min(iv.lo, iv.hi), high: Math.max(iv.lo, iv.hi) } : iv.target === "power" ? { type: "power", low: Math.min(iv.lo, iv.hi), high: Math.max(iv.lo, iv.hi) } : { type: "open" };
    return intervalWorkout({ name: iv.name, sport: iv.sport, warmupMin: iv.warmupMin, cooldownMin: iv.cooldownMin, repeats: iv.repeats, work: { type: "time", seconds: Math.round(iv.workMin * 60) }, recovery: { type: "time", seconds: Math.round(iv.recoveryMin * 60) }, target, scheduledDate: date || null });
  }, [source, rid, rts.routines, lib.custom, date, iv]);
  const problem = workout ? validateStructured(workout) : null;

  async function run(a: ExportAdapter) {
    if (!workout) return;
    try {
      const f = a.export(workout, new Date());
      download(f.filename, f.mime, f.bytes);
      setMsg({ ok: true, text: `${f.filename} downloaded. ${a.instructions}` });
      if (session) await saveDevice(sdb(), session.user.id, { last_export_at: new Date().toISOString(), last_export_kind: a.id as "fit" | "ics" | "json", last_export_note: `${workout.name} (${a.id}) downloaded; transfer to the watch not confirmed by APEX` }).catch(() => undefined);
    } catch (e) { setMsg({ ok: false, text: errText(e) }); }
  }
  const n = (v: string) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  return (
    <>
      <div className="eyebrow">Strength Hub</div>
      <h1>Garmin &amp; calendar export</h1>
      <StrengthNav />
      <div className="notice">
        <b>What works today, honestly:</b> APEX builds structured workouts and gives you a calendar file (.ics), a JSON copy, and an <b>experimental</b> workout file (.fit) for a Forerunner 965 that you copy over USB.
        Pushing workouts straight to Garmin Connect needs Garmin&apos;s Training API, which is only open to approved business developers, so APEX does not do it and never claims a watch sync it has not seen.
      </div>
      {rts.setUp === false && <SetupNotice what="Saved routines" />}
      {msg && <div className={msg.ok ? "notice ok" : "notice error"}>{msg.text}</div>}
      <div className="card formgrid" style={{ marginBottom: 12 }}>
        <label>Workout<select value={source} onChange={(e) => setSource(e.target.value as "routine" | "intervals")}><option value="routine">A strength routine</option><option value="intervals">An endurance interval session</option></select></label>
        {source === "routine" && <label>Routine<select value={rid} onChange={(e) => setRid(e.target.value)}><option value="">Choose…</option>{(rts.routines ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>}
        <label>Date (for the calendar)<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      </div>
      {source === "intervals" && (
        <div className="card formgrid" style={{ marginBottom: 12 }}>
          <label>Name<input value={iv.name} maxLength={60} onChange={(e) => setIv({ ...iv, name: e.target.value })} /></label>
          <label>Sport<select value={iv.sport} onChange={(e) => setIv({ ...iv, sport: e.target.value as typeof iv.sport })}>{["running", "cycling", "swimming", "hiit", "cardio", "custom"].map((s) => <option key={s}>{s}</option>)}</select></label>
          <label>Warm-up (min)<input inputMode="decimal" value={iv.warmupMin} onChange={(e) => setIv({ ...iv, warmupMin: n(e.target.value) })} /></label>
          <label>Repeats<input inputMode="numeric" value={iv.repeats} onChange={(e) => setIv({ ...iv, repeats: Math.round(n(e.target.value)) })} /></label>
          <label>Work (min)<input inputMode="decimal" value={iv.workMin} onChange={(e) => setIv({ ...iv, workMin: n(e.target.value) })} /></label>
          <label>Recovery (min)<input inputMode="decimal" value={iv.recoveryMin} onChange={(e) => setIv({ ...iv, recoveryMin: n(e.target.value) })} /></label>
          <label>Cool-down (min)<input inputMode="decimal" value={iv.cooldownMin} onChange={(e) => setIv({ ...iv, cooldownMin: n(e.target.value) })} /></label>
          <label>Work target<select value={iv.target} onChange={(e) => setIv({ ...iv, target: e.target.value as typeof iv.target })}><option value="pace">Pace (s/km)</option><option value="heart_rate">Heart rate (bpm)</option><option value="power">Power (W)</option><option value="open">None</option></select></label>
          {iv.target !== "open" && <><label>From<input inputMode="numeric" value={iv.lo} onChange={(e) => setIv({ ...iv, lo: n(e.target.value) })} /></label><label>To<input inputMode="numeric" value={iv.hi} onChange={(e) => setIv({ ...iv, hi: n(e.target.value) })} /></label></>}
        </div>
      )}
      {workout && (
        <>
          <h2>Steps</h2>
          <div className="card"><pre className="small" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{describe(workout)}</pre></div>
          {problem && <div className="notice error">{problem}</div>}
          <h2>Export</h2>
          {ADAPTERS.map((a) => (
            <div key={a.id} className="card" style={{ marginBottom: 10 }}>
              <div className="act-head"><b>{a.label}</b><span className={`pill ${a.status === "available" ? "st-ok" : a.status === "experimental" ? "st-low" : "st-na"}`}>{STATUS[a.status]}</span></div>
              <p className="small muted" style={{ marginTop: 0 }}>{a.instructions}</p>
              <button className="btn tiny" disabled={a.status === "requires_approval" || Boolean(problem) || (a.id === "ics" && !date)} onClick={() => void run(a)}>{a.status === "requires_approval" ? "Not available" : a.id === "ics" && !date ? "Choose a date first" : "Download"}</button>
            </div>
          ))}
          <p className="muted small">Manual alternative that always works: in Garmin Connect, create the workout (Training → Workouts → Create) using the step list above, then send it to your Forerunner 965 from the app.</p>
        </>
      )}
    </>
  );
}
