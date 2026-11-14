"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/useAuth";
import { errMsg, loadPanels, loadResults } from "@/lib/health/load";
import { STATUS_CLASS, STATUS_TEXT, rangeStatus, seriesKey, seriesLabel, splitByUnit, change, type Panel, type ResultPoint } from "@/lib/health/core";


export default function BiomarkersPage() {
  const { session } = useAuth();
  const [results, setResults] = useState<ResultPoint[] | null>(null);
  const [panels, setPanels] = useState<Panel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [abnormal, setAbnormal] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    if (!session) return;
    Promise.all([loadResults(), loadPanels()]).then(([r, p]) => { setResults(r); setPanels(p); }).catch((e) => setError(errMsg(e)));
  }, [session]);

  const markers = useMemo(() => {
    const groups = new Map<string, ResultPoint[]>();
    for (const r of results ?? []) {
      if ((from && r.collected_on < from) || (to && r.collected_on > to)) continue;
      const k = seriesKey(r);
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const needle = q.trim().toLowerCase();
    return [...groups.entries()].map(([key, pts]) => {
      const sorted = [...pts].sort((a, b) => a.collected_on.localeCompare(b.collected_on));
      const latest = sorted[sorted.length - 1];
      const sameUnit = splitByUnit(sorted).find((s) => s.points.includes(latest))!.points;
      const prev = sameUnit.length > 1 ? sameUnit[sameUnit.length - 2] : null;
      return { key, label: seriesLabel(key, latest.original_name), latest, count: sorted.length, status: rangeStatus(latest.value, latest.ref_low, latest.ref_high), prev };
    })
      .filter((m) => (!needle || m.label.toLowerCase().includes(needle) || m.latest.original_name.toLowerCase().includes(needle)) && (!abnormal || m.status === "below" || m.status === "above"))
      .sort((a, b) => b.latest.collected_on.localeCompare(a.latest.collected_on) || a.label.localeCompare(b.label));
  }, [results, q, abnormal, from, to]);

  return (
    <>
      <div className="eyebrow">Health</div>
      <h1>Blood biomarkers</h1>
      <p className="muted small">Your laboratory results, shown with each laboratory&apos;s own units and reference ranges. APEX does not diagnose or interpret results medically.</p>
      {error && <div className="notice error">{error}</div>}
      <div className="row" style={{ marginBottom: 14 }}>
        <Link className="btn" href="/biomarkers/panels/new">+ New blood test</Link>
        <Link className="btn ghost" href="/timeline">Health timeline</Link>
      </div>

      {results === null && !error && <p className="muted">Loading…</p>}
      {results !== null && results.length === 0 && panels.length === 0 && (
        <div className="notice">No blood tests yet. Add one manually or upload a laboratory report to get started.</div>
      )}

      {results !== null && results.length > 0 && (
        <>
          <div className="card formgrid" style={{ marginBottom: 14 }}>
            <label>Search marker<input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. ferritin" /></label>
            <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            <label className="check" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={abnormal} onChange={(e) => setAbnormal(e.target.checked)} style={{ width: "auto" }} /> Outside lab range only
            </label>
          </div>
          {markers.length === 0 && <div className="notice">No markers match these filters.</div>}
          <div className="markergrid">
            {markers.map((m) => {
              const d = m.prev ? change(m.prev.value, m.latest.value) : null;
              return (
                <Link key={m.key} href={`/biomarkers/${encodeURIComponent(m.key)}`} className="card markercard">
                  <div className="act-head"><b>{m.label}</b><span className={`pill ${STATUS_CLASS[m.status]}`}>{STATUS_TEXT[m.status]}</span></div>
                  <div className="markervalue">{m.latest.value} <small>{m.latest.unit}</small></div>
                  <div className="muted small">
                    {m.latest.collected_on}
                    {m.latest.ref_low !== null || m.latest.ref_high !== null ? ` · lab range ${m.latest.ref_low ?? "–"} to ${m.latest.ref_high ?? "–"}` : ""}
                  </div>
                  <div className="muted small">
                    {m.count} measurement{m.count === 1 ? "" : "s"}
                    {d && d.abs !== 0 ? ` · ${d.abs > 0 ? "▲" : "▼"} ${Math.abs(d.abs).toFixed(Math.abs(d.abs) < 10 ? 2 : 1)} since ${m.prev!.collected_on}` : ""}
                  </div>
                </Link>
              );
            })}
          </div>
        </>
      )}

      {panels.length > 0 && (
        <>
          <h2>Blood tests</h2>
          <div className="card">
            {panels.map((p) => (
              <Link key={p.id} href={`/biomarkers/panels/${p.id}`} className="doserow" style={{ textDecoration: "none", color: "inherit" }}>
                <b>{p.collected_on}</b><span>{p.lab_name ?? <span className="muted">Laboratory not recorded</span>}</span>
                <span className="muted small">{(results ?? []).filter((r) => r.panel_id === p.id).length} results{p.source === "document" ? " · from report" : ""}</span>
              </Link>
            ))}
          </div>
        </>
      )}
    </>
  );
}
