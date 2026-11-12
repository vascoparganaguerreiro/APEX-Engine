"use client";
import { useState } from "react";
import { friendlyMessage } from "@/lib/userError";
import { ENDURANCE_SPORTS, KINDS, kindLocked, KIND_LABEL, SPORT_NAME, normalizePlanned, validatePlanned, type PlannedInput, type PlannedKind, type PlannedWorkout } from "@/lib/calendar/model";

interface Draft { date: string; kind: PlannedKind; sport: string; title: string; minutes: string; km: string; intensity: string; notes: string }

/** Create or edit a planned entry. Deliberately simple: date, type, title and optional duration/distance/intensity/notes. A stored
 *  structured workout (warm-up, intervals...) is kept untouched when a plan is edited; this form does not edit steps yet. */
export default function PlannedForm({ initial, date, onSave, onCancel }: {
  initial?: PlannedWorkout; date: string; onSave: (i: PlannedInput) => Promise<void>; onCancel: () => void;
}) {
  const [d, setD] = useState<Draft>({
    date: initial?.planned_date ?? date, kind: initial?.kind ?? "endurance", sport: initial?.sport && initial.sport !== "strength" ? initial.sport : "run",
    title: initial?.title ?? "", minutes: initial?.duration_min != null ? String(initial.duration_min) : "",
    km: initial?.distance_m != null ? String(Number((initial.distance_m / 1000).toFixed(2))) : "", intensity: initial?.intensity ?? "", notes: initial?.notes ?? "",
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setD({ ...d, [k]: e.target.value });
  const timed = d.kind === "endurance" || d.kind === "strength";
  const locked = initial ? kindLocked(initial) : false;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const mins = timed && d.minutes.trim() ? Number(d.minutes.replace(",", ".")) : null;
    const km = d.kind === "endurance" && d.km.trim() ? Number(d.km.replace(",", ".")) : null;
    const input = normalizePlanned({
      planned_date: d.date, kind: initial && kindLocked(initial) ? initial.kind : d.kind, sport: (initial && kindLocked(initial) ? initial.kind : d.kind) === "endurance" ? d.sport : null, title: d.title, duration_min: mins, distance_m: km === null ? null : Math.round(km * 1000),
      intensity: d.intensity, routine_id: initial?.kind === "strength" && d.kind === "strength" ? initial.routine_id : null, notes: d.notes, structure: initial?.structure ?? null,
    });
    const v = validatePlanned(input);
    if (v) { setErr(v); return; }
    setErr(null); setBusy(true);
    try { await onSave(input); } catch (x) { setErr(friendlyMessage(x, "The planned workout could not be saved", { scope: "calendar.form" })); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="card" aria-label={initial ? "Edit planned workout" : "Add planned workout"}>
      <div className="formgrid">
        <label>Date<input type="date" value={d.date} onChange={set("date")} required /></label>
        <label>Type
          <select value={d.kind} onChange={set("kind")} disabled={locked} aria-describedby={locked ? "kind-locked" : undefined}>{KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>
          {locked && <small id="kind-locked" className="muted">The type can't be changed while this plan is linked to a recorded session. Use “Reopen” on the plan first to unlink it.</small>}
        </label>
        {d.kind === "endurance" && (
          <label>Sport<select value={d.sport} onChange={set("sport")}>{ENDURANCE_SPORTS.map((s) => <option key={s} value={s}>{SPORT_NAME[s]}</option>)}</select></label>
        )}
      </div>
      <label style={{ marginTop: 12 }}>Title<input value={d.title} onChange={set("title")} maxLength={120} placeholder={d.kind === "rest" ? "Rest day" : d.kind === "milestone" ? "e.g. 10k time trial" : "e.g. Easy run"} required /></label>
      {timed && (
        <div className="formgrid">
          <label>Duration (min)<input inputMode="numeric" value={d.minutes} onChange={set("minutes")} placeholder="optional" /></label>
          {d.kind === "endurance" && <label>Distance (km)<input inputMode="decimal" value={d.km} onChange={set("km")} placeholder="optional" /></label>}
          <label>Intensity<input value={d.intensity} onChange={set("intensity")} maxLength={200} placeholder="e.g. easy, Z2 or RPE 7" /></label>
        </div>
      )}
      <label style={{ marginTop: 12 }}>Notes<textarea value={d.notes} onChange={set("notes")} maxLength={2000} rows={2} /></label>
      {err && <div className="notice error" role="alert">{err}</div>}
      <div className="td-actions" style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn" disabled={busy}>{busy ? "Saving…" : initial ? "Save changes" : "Add to calendar"}</button>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
