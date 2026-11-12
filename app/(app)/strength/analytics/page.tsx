"use client";
import { useEffect, useMemo, useState } from "react";
import { sdb, useHistory, useLibrary } from "@/lib/strength/hooks";
import { loadLinksOrNone } from "@/lib/strength/data";
import { strengthExcludedIds } from "@/lib/strength/dedup";
import { E1RM_FORMULA, MUSCLE_NOTE, dashboard, exerciseHistory, muscleWeek, type ExerciseSessionStats } from "@/lib/strength/analytics";
import { addDaysIso, weekStart } from "@/lib/activities";
import { MUSCLES, MUSCLE_LABEL } from "@/lib/strength/types";
import { todayIso } from "@/lib/dates";
import { SetupNotice, StrengthNav } from "@/components/strength/Bits";

function Line({ points, unit }: { points: Array<{ x: string; y: number }>; unit: string }) {
  if (points.length < 2) return <p className="muted small">At least two sessions are needed for a trend.</p>;
  const W = 640, H = 180, P = 28, ys = points.map((p) => p.y), lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1;
  const xy = points.map((p, i) => [P + (i * (W - 2 * P)) / (points.length - 1), H - P - ((p.y - lo) / span) * (H - 2 * P)] as const);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Trend from ${points[0].y} to ${points[points.length - 1].y} ${unit}`}>
      <polyline fill="none" stroke="var(--green)" strokeWidth="2.5" points={xy.map((p) => p.join(",")).join(" ")} />
      {xy.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="3.5" fill="var(--green)"><title>{points[i].x}: {points[i].y} {unit}</title></circle>)}
      <text x={P} y={14} fill="var(--muted)" fontSize="11">{Math.round(hi * 10) / 10} {unit}</text>
      <text x={P} y={H - 6} fill="var(--muted)" fontSize="11">{Math.round(lo * 10) / 10} {unit}</text>
    </svg>
  );
}

export default function StrengthAnalyticsPage() {
  const lib = useLibrary();
  const hist = useHistory(lib.custom);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [key, setKey] = useState("");
  const [metric, setMetric] = useState<"e1rm" | "weight" | "volume" | "reps">("e1rm");
  const [week, setWeek] = useState(weekStart(todayIso()));
  useEffect(() => { loadLinksOrNone(sdb()).then((l) => setExcluded(strengthExcludedIds(l))).catch(() => undefined); }, []);
  const sessions = useMemo(() => (hist.sessions ?? []).filter((s) => !excluded.has(s.id)), [hist.sessions, excluded]);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const d = useMemo(() => dashboard(sessions, todayIso(), tz), [sessions, tz]);
  const mw = useMemo(() => muscleWeek(sessions, lib.resolve, week, tz), [sessions, lib, week, tz]);
  const used = useMemo(() => { const m = new Map<string, string>(); for (const s of sessions) for (const e of s.exercises) if (e.key) m.set(e.key, e.name); return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1])); }, [sessions]);
  const series: ExerciseSessionStats[] = useMemo(() => (key ? exerciseHistory(sessions, { key }, tz) : []), [sessions, key, tz]);
  const val = (s: ExerciseSessionStats) => metric === "e1rm" ? s.e1rmKg : metric === "weight" ? s.maxWeightKg : metric === "volume" ? (s.volumeKg || null) : s.maxReps;
  const pts = series.map((s) => ({ x: s.date, y: val(s) })).filter((p): p is { x: string; y: number } => p.y !== null).map((p) => ({ ...p, y: Math.round(p.y * 10) / 10 }));
  const maxSets = Math.max(1, ...MUSCLES.map((m) => mw[m].direct + mw[m].secondary));

  return (
    <>
      <div className="eyebrow">Strength Hub</div>
      <h1>Progress</h1>
      <StrengthNav />
      {hist.setUp === false && <SetupNotice what="Progress analytics" />}
      {hist.sessions === null ? <p className="muted">Loading…</p> : (
        <>
          <div className="statgrid">
            <div className="kpi"><small>Workouts (all time)</small><b>{d.totalWorkouts}</b></div>
            <div className="kpi"><small>Last 30 days</small><b>{d.last30}</b></div>
            <div className="kpi"><small>Per week (12 wk avg)</small><b>{d.perWeek12}</b></div>
            <div className="kpi"><small>Weeks trained (of 12)</small><b>{d.consistency12.weeksTrained}</b></div>
            <div className="kpi"><small>Working sets this week</small><b>{d.thisWeekSets}</b><em>4-wk avg {d.avgWeeklySets4}</em></div>
            <div className="kpi"><small>Average duration</small><b>{d.avgDurationMin === null ? "–" : `${d.avgDurationMin} min`}</b></div>
          </div>
          <p className="muted small">Counts are measured from your logs. A workout merged with its Garmin copy counts once. No combined "load score" is calculated from different exercises.</p>

          <h2>Exercise progression</h2>
          <div className="card">
            <div className="row">
              <select value={key} onChange={(e) => setKey(e.target.value)} aria-label="Exercise" style={{ flex: 2 }}><option value="">Choose an exercise</option>{used.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
              <select value={metric} onChange={(e) => setMetric(e.target.value as typeof metric)} aria-label="Measure" style={{ flex: 1 }}>
                <option value="e1rm">Estimated 1RM (kg)</option><option value="weight">Heaviest weight (kg)</option><option value="volume">Session volume (kg)</option><option value="reps">Most reps in a set</option>
              </select>
            </div>
            {key && <><div className="chart" style={{ marginTop: 10 }}><Line points={pts} unit={metric === "reps" ? "reps" : "kg"} /></div>
              <table className="tbl"><thead><tr><th>Date</th><th>Best set</th><th>Working sets</th><th>Reps</th><th>Volume</th><th>Est. 1RM</th></tr></thead>
                <tbody>{[...series].reverse().map((s) => <tr key={s.sessionId}><td>{s.date}</td><td>{s.best ? `${s.best.weight} ${s.best.unit} × ${s.best.reps}` : "–"}</td><td>{s.workingSets}</td><td>{s.reps}</td><td>{s.volumeKg ? `${Math.round(s.volumeKg)} kg` : "–"}</td><td>{s.e1rmKg ? `${Math.round(s.e1rmKg * 10) / 10} kg` : "–"}</td></tr>)}</tbody></table>
              <p className="muted small">Measured: sets, reps, weights. Calculated: volume (external load × reps) and the estimated 1RM. {E1RM_FORMULA}</p></>}
          </div>

          <h2>Muscles this week</h2>
          <div className="card">
            <div className="week-nav"><button className="btn ghost" onClick={() => setWeek(addDaysIso(week, -7))}>← Previous</button><b>Week of {week}</b><button className="btn ghost" disabled={week >= weekStart(todayIso())} onClick={() => setWeek(addDaysIso(week, 7))}>Next →</button></div>
            {MUSCLES.filter((m) => mw[m].direct || mw[m].secondary).length === 0 ? <p className="muted small">No working sets logged this week.</p> : MUSCLES.filter((m) => mw[m].direct || mw[m].secondary).map((m) => (
              <div key={m} className="musclebar">
                <span>{MUSCLE_LABEL[m]}</span>
                <div className="bar" aria-hidden style={{ display: "flex" }}><i style={{ width: `${(mw[m].direct / maxSets) * 100}%` }} /><i className="sec" style={{ width: `${(mw[m].secondary / maxSets) * 100}%` }} /></div>
                <span className="small">{mw[m].direct} direct · {mw[m].secondary} sec. · {mw[m].sessions}×</span>
              </div>
            ))}
            <p className="muted small" style={{ marginBottom: 0 }}>{MUSCLE_NOTE} "×" is the number of sessions that trained the muscle directly.</p>
          </div>

          <h2>Monthly and yearly</h2>
          <div className="card tablewrap">
            <table className="tbl"><thead><tr><th>Month</th><th>Workouts</th><th>Minutes</th><th>Working sets</th></tr></thead>
              <tbody>{[...d.monthly].reverse().slice(0, 12).map((p) => <tr key={p.key}><td>{p.key}</td><td>{p.workouts}</td><td>{p.minutes}</td><td>{p.workingSets}</td></tr>)}</tbody></table>
            <table className="tbl" style={{ marginTop: 12 }}><thead><tr><th>Year</th><th>Workouts</th><th>Minutes</th><th>Working sets</th></tr></thead>
              <tbody>{[...d.yearly].reverse().map((p) => <tr key={p.key}><td>{p.key}</td><td>{p.workouts}</td><td>{p.minutes}</td><td>{p.workingSets}</td></tr>)}</tbody></table>
          </div>
        </>
      )}
    </>
  );
}
