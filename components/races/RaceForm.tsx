"use client";
import { useEffect, useRef, useState } from "react";
import { friendlyMessage } from "@/lib/userError";
import {
  DISTANCE_UNITS, FORMATS, PRIORITIES, PRIORITY_LABEL, SPORTS, SPORT_LABEL, STATUSES, STATUS_LABEL,
  LEGACY_SPORTS, formatDuration, parseDuration, validateRace, type Race, type RaceInput, type Sport,
} from "@/lib/races";

interface Draft { name: string; sport: Sport; race_type: string; race_date: string; location: string; distance: string; unit: string; time: string; priority: string; status: string; goal: string; notes: string }

/** Create or edit a race. Fields are stored exactly as entered: no result or finish time is ever suggested. */
export default function RaceForm({ initial, today, defaultUnit, legacy, onSave, onCancel }: {
  initial?: Race; today: string; defaultUnit?: "km" | "mi"; legacy?: boolean; onSave: (r: RaceInput) => Promise<void>; onCancel: () => void;
}) {
  // `legacy`: the account does not store the extra race details yet. Those fields are not offered (so nothing typed is ever lost), the
  // sport list is the one that can be stored faithfully, and the extra values stay at their defaults.
  const sports = legacy ? SPORTS.filter((s) => LEGACY_SPORTS.includes(s)) : SPORTS;
  const [d, setD] = useState<Draft>({
    name: initial?.name ?? "", sport: initial?.sport ?? "running", race_type: initial?.race_type ?? FORMATS[initial?.sport ?? "running"][0].value,
    race_date: initial?.race_date ?? "", location: initial?.location ?? "", distance: initial?.distance != null ? String(initial.distance) : "",
    unit: initial?.distance_unit ?? defaultUnit ?? "km", time: formatDuration(initial?.target_time_s ?? null), priority: initial?.priority ?? "B",
    status: initial?.status ?? "planned", goal: initial?.goal ?? "", notes: initial?.notes ?? "",
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => { ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }, []);   // the form can open far from its button
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setD({ ...d, [k]: e.target.value });

  function changeSport(e: React.ChangeEvent<HTMLSelectElement>) {
    const sport = e.target.value as Sport;
    setD({ ...d, sport, race_type: FORMATS[sport].some((f) => f.value === d.race_type) ? d.race_type : FORMATS[sport][0].value });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const dist = !legacy && d.distance.trim() ? Number(d.distance.replace(",", ".")) : null;
    const time = !legacy && d.time.trim() ? parseDuration(d.time) : null;
    if (!legacy && d.time.trim() && time === null) { setErr("Target time must look like 3:45:00 (or 45:30 for minutes:seconds)."); return; }
    const input: RaceInput = {
      name: d.name.trim(), sport: d.sport, race_type: d.race_type, race_date: d.race_date, location: legacy ? null : d.location.trim() || null,
      distance: dist, distance_unit: dist === null ? null : d.unit, target_time_s: time, priority: d.priority as RaceInput["priority"],
      status: legacy ? "planned" : (d.status as RaceInput["status"]), goal: d.goal.trim() || null, notes: d.notes.trim() || null,
    };
    const v = validateRace(input, today);
    if (v) { setErr(v); return; }
    setErr(null); setBusy(true);
    try { await onSave(input); } catch (x) { setErr(friendlyMessage(x, "The race could not be saved", { scope: "races.form" })); } finally { setBusy(false); }
  }

  return (
    <form ref={ref} className="card" onSubmit={submit}>
      <h2 style={{ marginTop: 0 }}>{initial ? "Edit race" : "Add a race"}</h2>
      <div className="formgrid">
        <label>Name<input value={d.name} onChange={set("name")} maxLength={120} required placeholder="e.g. Lisbon Half Marathon" /></label>
        <label>Event date<input type="date" value={d.race_date} onChange={set("race_date")} required /></label>
        <label>Sport<select value={d.sport} onChange={changeSport}>{sports.map((s) => <option key={s} value={s}>{SPORT_LABEL[s]}</option>)}</select></label>
        <label>Format<select value={d.race_type} onChange={set("race_type")}>{FORMATS[d.sport].map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</select></label>
        {!legacy && <label>Location<input value={d.location} onChange={set("location")} maxLength={120} placeholder="optional" /></label>}
        {!legacy && <label>Distance<input inputMode="decimal" value={d.distance} onChange={set("distance")} placeholder="optional" /></label>}
        {!legacy && <label>Unit<select value={d.unit} onChange={set("unit")}>{DISTANCE_UNITS.map((u) => <option key={u}>{u}</option>)}</select></label>}
        {!legacy && <label>Target finish time<input value={d.time} onChange={set("time")} placeholder="h:mm:ss, optional" /></label>}
        <label>Priority<select value={d.priority} onChange={set("priority")}>{PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}</select></label>
        {!legacy && <label>Status<select value={d.status} onChange={set("status")}>{STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></label>}
      </div>
      {legacy && <p className="muted small">Location, distance, target time and status aren&apos;t available on your account yet, so they are not shown here.</p>}
      <label>Personal goal<input value={d.goal} onChange={set("goal")} maxLength={300} placeholder="e.g. Finish strong and enjoy it" /></label>
      <label>Notes<textarea rows={3} maxLength={2000} value={d.notes} onChange={set("notes")} /></label>
      {err && <div className="notice error">{err}</div>}
      <div className="row">
        <button className="btn" disabled={busy} type="submit">{busy ? "Saving..." : initial ? "Save changes" : "Add race"}</button>
        <button className="btn ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}