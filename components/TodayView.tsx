"use client";
import { useState } from "react";
import Link from "next/link";
import ReadinessRing from "./ReadinessRing";
import TrendChart from "./TrendChart";
import { tsbState, type Readiness, type TrendPoint, type Verdict } from "@/lib/engine";
import type { DailyRow } from "@/lib/types";

const VERDICTS: Record<Verdict, { title: string; color: string; text: string }> = {
  PUSH: { title: "Push", color: "var(--green)", text: "Green light for a quality session." },
  HOLD: { title: "Hold the plan", color: "var(--amber)", text: "Train as planned, no extra intensity." },
  RECOVER: { title: "Recover", color: "var(--red)", text: "Prioritise sleep and easy movement." },
};

const RANGES = [7, 14, 30] as const;

export default function TodayView({ result, latest, goal, today, trend }: {
  result: Readiness | null; latest: DailyRow | null; goal: number; today: string; trend: TrendPoint[];
}) {
  const [range, setRange] = useState<(typeof RANGES)[number]>(14);
  const hasLoad = trend.some((p) => p.load > 0);
  const form = hasLoad ? trend[trend.length - 1] ?? null : null;
  const view = trend.slice(-range);
  const days = view.map((p) => p.day);
  const stale = !latest || latest.day !== today;

  const sleepH = latest?.sleep_minutes ? latest.sleep_minutes / 60 : null;
  const v = result ? VERDICTS[result.verdict] : null;
  const na = "n/a";

  return (
    <>
      {stale && (
        <div className="notice">
          {latest ? `No wellness data for today yet (latest: ${latest.day}).` : "No wellness data yet."}{" "}
          Sync Intervals.icu on the <Link href="/import" style={{ color: "var(--green)" }}>Import page</Link>, or log a day below.
        </div>
      )}

      {result && v && latest && (
        <div className="today-grid">
          <ReadinessRing score={result.score} color={v.color} />
          <div>
            <div className="verdict" style={{ color: v.color }}>{v.title}</div>
            <p>{v.text}</p>
            <p className="muted small">
              Latest entry: {latest.day} · HRV baseline: {result.baselineDays}/14 days
              {result.baselineDays < 3 ? " (still building, score is provisional)" : ""}
            </p>
          </div>
        </div>
      )}

      {(latest || form) && (
        <div className="kpis">
          <div className="kpi">
            <small>HRV (rMSSD)</small>
            <b>{latest?.hrv_ms != null ? `${Math.round(Number(latest.hrv_ms))} ms` : na}</b>
            {result?.hrvZ != null && <em>{result.hrvZ >= 0 ? "▲" : "▼"} {Math.abs(result.hrvZ).toFixed(1)} σ</em>}
          </div>
          <div className="kpi">
            <small>Resting HR</small>
            <b>{latest?.rhr_bpm != null ? `${latest.rhr_bpm} bpm` : na}</b>
          </div>
          <div className="kpi">
            <small>Sleep</small>
            <b>{sleepH !== null ? `${sleepH.toFixed(1)} h` : na}</b>
            <em className="muted">{latest?.sleep_score != null ? `score ${Math.round(Number(latest.sleep_score))} · ` : ""}goal {goal.toFixed(1)} h</em>
          </div>
          <div className="kpi">
            <small>Fatigue (ATL)</small>
            <b>{form ? form.atl.toFixed(0) : na}</b>
            <em className="muted">7-day load</em>
          </div>
          <div className="kpi">
            <small>Form (TSB)</small>
            <b style={form ? { color: form.tsb >= 5 ? "var(--green)" : form.tsb < -30 ? "var(--red)" : form.tsb < -10 ? "var(--amber)" : undefined } : undefined}>
              {form ? `${form.tsb > 0 ? "+" : ""}${form.tsb.toFixed(0)}` : na}
            </b>
            <em className="muted">{form ? tsbState(form.tsb) : "needs activities"}</em>
          </div>
          <div className="kpi">
            <small>Fitness (CTL)</small>
            <b>{form ? form.ctl.toFixed(0) : na}</b>
            <em className="muted">42-day load</em>
          </div>
        </div>
      )}

      {(latest || hasLoad) && (
        <>
          <div className="act-head" style={{ marginTop: 28 }}>
            <h2 style={{ margin: 0 }}>Trends</h2>
            <div className="row" role="group" aria-label="Trend range">
              {RANGES.map((r) => (
                <button key={r} type="button" className={range === r ? "chip on" : "chip"} aria-pressed={range === r} onClick={() => setRange(r)}>{r} days</button>
              ))}
            </div>
          </div>
          <div className="charts">
            <TrendChart title="HRV (ms)" days={days} unit=""
              lines={[{ label: "HRV", color: "var(--green)", values: view.map((p) => p.hrv) }]} />
            {hasLoad ? (
              <TrendChart title="Fitness, fatigue and form" days={days} zero
                lines={[
                  { label: "CTL fitness", color: "var(--blue)", values: view.map((p) => p.ctl) },
                  { label: "ATL fatigue", color: "var(--amber)", values: view.map((p) => p.atl) },
                  { label: "TSB form", color: "var(--green)", values: view.map((p) => p.tsb), dashed: true },
                ]} />
            ) : (
              <div className="card chart">
                <b>Fitness, fatigue and form</b>
                <p className="muted small">Needs activities with a training load. Sync them on the <Link href="/import" style={{ color: "var(--green)" }}>Import page</Link>.</p>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
