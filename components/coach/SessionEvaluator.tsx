"use client";
import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { coachRequest } from "@/lib/api";
import { friendlyMessage } from "@/lib/userError";
import { COACH_SPORTS, SPORT_NAME, type Category, type CoachSport } from "@/lib/coach/schema";
import type { SessionResult } from "@/lib/coach/engine";
import { SessionCard } from "./AssessmentCards";

interface Act { id: number; started_at: string; sport: string; title: string | null; duration_s: number | null }
const today = () => new Date().toLocaleDateString("sv-SE");
const parsePace = (t: string, sport: CoachSport): number | null => {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(t.trim());
  if (!m) return null;
  const s = Number(m[1]) * 60 + Number(m[2]);
  return sport === "swim" ? s * 10 : s;          // swim pace is entered per 100 m; stored per km
};
const num = (s: string) => (s.trim() === "" ? null : Number(s.replace(",", ".")));

export default function SessionEvaluator({ authorized, consentUser, onSaved }: { authorized: Category[]; consentUser: string | null; onSaved: () => void }) {
  const [source, setSource] = useState<"imported" | "manual">("imported");
  const [acts, setActs] = useState<Act[] | null>(null);
  const [activityId, setActivityId] = useState("");
  const [objective, setObjective] = useState("");
  const [clarification, setClarification] = useState("");
  const [m, setM] = useState({ sport: "run" as CoachSport, mode: "completed", date: today(), duration: "", distance: "", avg_hr: "", max_hr: "", pace: "", power: "", rpe: "", structure: "", notes: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SessionResult | null>(null);

  useEffect(() => {
    getSupabase().from("activities").select("id,started_at,sport,title,duration_s").order("started_at", { ascending: false }).limit(40)
      .then(({ data }) => setActs((data ?? []) as Act[]), () => setActs([]));
  }, []);
  const set = (k: keyof typeof m) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setM({ ...m, [k]: e.target.value });

  async function run(extra = "") {
    setBusy(true); setError(null);
    const clar = [clarification, extra].filter(Boolean).join("\n");
    try {
      const body = source === "imported"
        ? { intent: "session", activityId: Number(activityId), objective, clarification: clar }
        : { intent: "session", clarification: clar, manual: { sport: m.sport, mode: m.mode, date: m.date, duration_min: num(m.duration), distance_km: num(m.distance), objective, avg_hr: num(m.avg_hr), max_hr: num(m.max_hr), pace_s_per_km: m.pace.trim() ? parsePace(m.pace, m.sport) : null, power_w: num(m.power), rpe: num(m.rpe), structure: m.structure, notes: m.notes } };
      if (source === "manual" && m.pace.trim() && body && (body as { manual: { pace_s_per_km: number | null } }).manual.pace_s_per_km === null) { setError("Pace must look like 4:35."); setBusy(false); return; }
      const r = await coachRequest(body, authorized, consentUser);
      if (r.kind !== "session") throw new Error("Unexpected answer from the Coach.");
      setResult(r); if (r.saved) onSaved();
    } catch (e) { setError(friendlyMessage(e, "The evaluation could not be completed", { scope: "coach.evaluator" })); } finally { setBusy(false); }
  }
  const canRun = source === "imported" ? activityId !== "" : m.duration.trim() !== "";

  return (
    <div>
      <div className="row" role="group" aria-label="Workout source" style={{ marginBottom: 12 }}>
        <button type="button" className={source === "imported" ? "chip on" : "chip"} aria-pressed={source === "imported"} onClick={() => { setSource("imported"); setResult(null); }}>Imported activity</button>
        <button type="button" className={source === "manual" ? "chip on" : "chip"} aria-pressed={source === "manual"} onClick={() => { setSource("manual"); setResult(null); }}>Describe a workout</button>
      </div>
      <form className="card" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        {source === "imported" ? (
          <>
            <label>Activity<select value={activityId} onChange={(e) => setActivityId(e.target.value)}>
              <option value="">{acts === null ? "Loading..." : acts.length ? "Choose an activity" : "No imported activities yet"}</option>
              {(acts ?? []).map((a) => <option key={a.id} value={a.id}>{new Date(a.started_at).toLocaleDateString()} · {a.sport}{a.duration_s ? ` · ${Math.round(a.duration_s / 60)} min` : ""}{a.title ? ` · ${a.title}` : ""}</option>)}
            </select></label>
            <p className="muted small" style={{ marginTop: 0 }}>The Coach reads what is stored (it never changes or copies your activity). Elevation and laps are not stored in APEX yet, so they are not used.</p>
            <label>What was the objective? (optional, but needed for a score)<input value={objective} maxLength={300} onChange={(e) => setObjective(e.target.value)} placeholder="e.g. easy aerobic, threshold intervals, long run" /></label>
            <label>Anything else the Coach should know about how it was structured or how it felt<textarea rows={2} maxLength={1000} value={clarification} onChange={(e) => setClarification(e.target.value)} /></label>
          </>
        ) : (
          <>
            <div className="formgrid">
              <label>Sport<select value={m.sport} onChange={set("sport")}>{COACH_SPORTS.map((s) => <option key={s} value={s}>{SPORT_NAME[s]}</option>)}</select></label>
              <label>This session is<select value={m.mode} onChange={set("mode")}><option value="completed">Completed</option><option value="planned">Planned</option></select></label>
              <label>Date<input type="date" value={m.date} onChange={set("date")} required /></label>
              <label>Duration (min)<input inputMode="decimal" value={m.duration} onChange={set("duration")} required /></label>
              <label>Distance (km)<input inputMode="decimal" value={m.distance} onChange={set("distance")} placeholder="optional" /></label>
              <label>{m.sport === "swim" ? "Pace (min per 100 m)" : "Pace (min per km)"}<input value={m.pace} onChange={set("pace")} placeholder="m:ss, optional" /></label>
              <label>Power (W)<input inputMode="numeric" value={m.power} onChange={set("power")} placeholder="optional" /></label>
              <label>Average HR<input inputMode="numeric" value={m.avg_hr} onChange={set("avg_hr")} placeholder="optional" /></label>
              <label>Max HR<input inputMode="numeric" value={m.max_hr} onChange={set("max_hr")} placeholder="optional" /></label>
              <label>RPE (1-10)<input inputMode="numeric" value={m.rpe} onChange={set("rpe")} placeholder="optional" /></label>
            </div>
            <label>Objective<input value={objective} maxLength={300} onChange={(e) => setObjective(e.target.value)} placeholder="what the session is meant to achieve" /></label>
            <label>Structure (warm-up, main set, rests, cool-down) or a free description<textarea rows={3} maxLength={1500} value={m.structure} onChange={set("structure")} /></label>
            <label>Notes<textarea rows={2} maxLength={1500} value={m.notes} onChange={set("notes")} /></label>
          </>
        )}
        {error && <div className="notice error">{error}</div>}
        <div className="row"><button className="btn" type="submit" disabled={busy || !canRun}>{busy ? "Evaluating..." : source === "manual" && m.mode === "planned" ? "Assess this plan" : "Evaluate session"}</button></div>
        {authorized.length === 0 && <p className="muted small" style={{ marginBottom: 0 }}>No personal data is shared, so history and recovery context will be left out. Choose what the Coach can see above for a fuller evaluation.</p>}
      </form>
      {result && (
        <div style={{ marginTop: 14 }}>
          <SessionCard r={result} />
          {result.status === "needs_info" && (
            <form className="card" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); const t = (e.currentTarget.elements.namedItem("answers") as HTMLTextAreaElement).value; void run(t); }}>
              <label>Your answers<textarea name="answers" rows={3} maxLength={1000} placeholder="Answer the questions above, then evaluate again" /></label>
              <div className="row"><button className="btn" type="submit" disabled={busy}>{busy ? "Evaluating..." : "Evaluate again"}</button></div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}