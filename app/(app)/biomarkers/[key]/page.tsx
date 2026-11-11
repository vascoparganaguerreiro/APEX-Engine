"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAuth } from "@/lib/useAuth";
import { errMsg, loadResults, loadSupplementsAndSchedules } from "@/lib/health/load";
import {
  ASSOCIATION_NOTE, activeOn, beforeAfter, change, observations, rangeStatus, sameRange, seriesKey, seriesLabel, splitByUnit, supplementEvents,
  type ResultPoint, type Schedule, type Supplement,
} from "@/lib/health/core";
import BiomarkerChart from "@/components/health/BiomarkerChart";

const STATUS_TEXT = { below: "Below lab range", within: "Within lab range", above: "Above lab range", unknown: "No range printed" } as const;
const STATUS_CLASS = { below: "st-low", within: "st-ok", above: "st-high", unknown: "st-na" } as const;

export default function MarkerPage() {
  const { session } = useAuth();
  const params = useParams<{ key: string }>();
  const key = decodeURIComponent(params.key);
  const [all, setAll] = useState<ResultPoint[] | null>(null);
  const [sup, setSup] = useState<{ supplements: Supplement[]; schedules: Schedule[] }>({ supplements: [], schedules: [] });
  const [error, setError] = useState<string | null>(null);
  const [unitIdx, setUnitIdx] = useState(0);

  useEffect(() => {
    if (!session) return;
    Promise.all([loadResults(), loadSupplementsAndSchedules()]).then(([r, s]) => { setAll(r); setSup(s); }).catch((e) => setError(errMsg(e)));
  }, [session]);

  const points = useMemo(() => (all ?? []).filter((r) => seriesKey(r) === key), [all, key]);
  const series = useMemo(() => splitByUnit(points), [points]);
  const cur = series[Math.min(unitIdx, Math.max(series.length - 1, 0))];
  const events = useMemo(() => supplementEvents(sup.supplements, sup.schedules), [sup]);
  const label = points.length ? seriesLabel(key, points[0].original_name) : key;
  const names = [...new Set(points.map((p) => p.original_name))];
  const notes = useMemo(() => (cur ? observations(cur, sup.supplements) : []), [cur, sup.supplements]);
  const ba = useMemo(() => (cur ? beforeAfter(cur, sup.supplements) : []), [cur, sup.supplements]);
  const taking = (d: string) => { const n = sup.supplements.filter((s) => activeOn(s, d)).map((s) => s.name); return n.length ? n.join(", ") : "none recorded"; };
  const rangeChanges = cur ? cur.points.slice(1).some((p, i) => !sameRange(cur.points[i], p)) : false;

  return (
    <>
      <div className="eyebrow"><Link href="/biomarkers" style={{ color: "inherit" }}>← Biomarkers</Link></div>
      <h1>{label}</h1>
      {error && <div className="notice error">{error}</div>}
      {all === null && !error && <p className="muted">Loading…</p>}
      {all !== null && points.length === 0 && <div className="notice">No results stored for this marker.</div>}

      {cur && (
        <>
          <p className="muted small">
            Laboratory name{names.length > 1 ? "s" : ""}: {names.join(" · ")}. Values, units and ranges are exactly as each laboratory reported them.
          </p>
          {series.length > 1 && (
            <div className="notice">
              This marker was reported in {series.length} different units. They are not converted or combined, so each unit has its own chart.
              <div className="row" style={{ marginTop: 8 }}>
                {series.map((s, i) => <button key={s.key} className={i === unitIdx ? "chip on" : "chip"} onClick={() => setUnitIdx(i)}>{s.unit} ({s.points.length})</button>)}
              </div>
            </div>
          )}
          <div className="card chart">
            <div className="act-head"><b>{cur.unit}</b>
              <span className="legend muted small"><span><i style={{ background: "var(--green)" }} />within range</span><span><i style={{ background: "var(--amber)" }} />below</span><span><i style={{ background: "var(--red)" }} />above</span><span>▲ started · ■ stopped · ◆ schedule</span></span>
            </div>
            {cur.points.length < 2 && <p className="muted small">Only one measurement so far. A trend needs at least two tests in the same unit.</p>}
            <BiomarkerChart series={cur} events={events} />
            <p className="muted small" style={{ marginBottom: 0 }}>
              The green bar at each date is the laboratory range printed on that report.
              {rangeChanges ? " Dashed lines mean the reference range differed between those two tests, so compare them with care." : ""}
            </p>
          </div>

          <h2>Measurements</h2>
          <div className="card tablewrap">
            <table className="tbl">
              <thead><tr><th>Date</th><th>Result</th><th>Lab range</th><th>Status</th><th>Change</th><th>Laboratory</th><th>Supplements recorded as active</th></tr></thead>
              <tbody>
                {[...cur.points].reverse().map((p, idx, arr) => {
                  const prev = arr[idx + 1]; const d = prev ? change(prev.value, p.value) : null; const st = rangeStatus(p.value, p.ref_low, p.ref_high);
                  return (
                    <tr key={p.id}>
                      <td>{p.collected_on}</td><td><b>{p.value}</b> {p.unit}{p.flag ? <span className="muted small"> · lab flag {p.flag}</span> : null}</td>
                      <td>{p.ref_low !== null || p.ref_high !== null ? `${p.ref_low ?? "–"} to ${p.ref_high ?? "–"}` : "not printed"}</td>
                      <td><span className={`pill ${STATUS_CLASS[st]}`}>{STATUS_TEXT[st]}</span></td>
                      <td>{d ? `${d.abs > 0 ? "+" : ""}${d.abs.toFixed(Math.abs(d.abs) < 10 ? 2 : 1)}${d.pct !== null ? ` (${d.pct > 0 ? "+" : ""}${d.pct.toFixed(0)}%)` : ""}` : "–"}</td>
                      <td>{p.lab_name ?? "–"} <Link href={`/biomarkers/panels/${p.panel_id}`} className="muted small">open</Link></td>
                      <td className="small">{taking(p.collected_on)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {ba.length > 0 && (
            <>
              <h2>Before and after supplement changes</h2>
              <div className="card tablewrap">
                <table className="tbl">
                  <thead><tr><th>Supplement</th><th>Event</th><th>Last test up to then</th><th>First test after</th><th>Difference</th></tr></thead>
                  <tbody>
                    {ba.map((r) => (
                      <tr key={`${r.supplement_id}-${r.type}-${r.date}`}>
                        <td>{r.name}</td><td>{r.type === "start" ? "Started" : "Stopped"} {r.date}</td>
                        <td>{r.before ? `${r.before.value} ${cur.unit} (${r.before.collected_on})` : "no earlier test"}</td>
                        <td>{r.after ? `${r.after.value} ${cur.unit} (${r.after.collected_on})` : "no later test yet"}</td>
                        <td>{r.change ? `${r.change.abs > 0 ? "+" : ""}${r.change.abs.toFixed(Math.abs(r.change.abs) < 10 ? 2 : 1)}${r.change.pct !== null ? ` (${r.change.pct > 0 ? "+" : ""}${r.change.pct.toFixed(0)}%)` : ""}` : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <h2>Supplements around these tests</h2>
          {notes.length === 0 ? <div className="notice">Not enough comparable measurements yet (two or more tests in the same unit are needed).</div> : (
            <div className="card"><ul style={{ margin: 0, paddingLeft: 18 }}>{notes.map((n) => <li key={n} className="small" style={{ marginBottom: 6 }}>{n}</li>)}</ul></div>
          )}
          <div className="notice" role="note"><b>Timing only.</b> {ASSOCIATION_NOTE}</div>
        </>
      )}
    </>
  );
}
