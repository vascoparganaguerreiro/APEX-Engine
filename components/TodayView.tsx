import ReadinessRing from "./ReadinessRing";
import type { Readiness, Verdict } from "@/lib/engine";
import type { DailyRow } from "@/lib/types";

const VERDICTS: Record<Verdict, { title: string; color: string; text: string }> = {
  PUSH: { title: "Push", color: "var(--green)", text: "Green light for a quality session." },
  HOLD: { title: "Hold the plan", color: "var(--amber)", text: "Train as planned, no extra intensity." },
  RECOVER: { title: "Recover", color: "var(--red)", text: "Prioritise sleep and easy movement." },
};

export default function TodayView({ result, latest, goal }: { result: Readiness | null; latest: DailyRow | null; goal: number }) {
  if (!latest || !result) {
    return <div className="notice">No data yet. Log your first day below to see your readiness.</div>;
  }
  const v = VERDICTS[result.verdict];
  const sleepH = latest.sleep_minutes ? latest.sleep_minutes / 60 : null;
  return (
    <div className="today-grid">
      <ReadinessRing score={result.score} color={v.color} />
      <div>
        <div className="verdict" style={{ color: v.color }}>{v.title}</div>
        <p>{v.text}</p>
        <p className="muted small">
          Latest entry: {latest.day} · HRV baseline: {result.baselineDays}/14 days
          {result.baselineDays < 3 ? " (still building, score is provisional)" : ""}
        </p>
        <div className="kpis">
          <div className="kpi">
            <small>Overnight HRV</small>
            <b>{latest.hrv_ms !== null ? `${Math.round(Number(latest.hrv_ms))} ms` : "n/a"}</b>
            {result.hrvZ !== null && <em>{result.hrvZ >= 0 ? "▲" : "▼"} {Math.abs(result.hrvZ).toFixed(1)} σ</em>}
          </div>
          <div className="kpi">
            <small>Resting HR</small>
            <b>{latest.rhr_bpm !== null ? `${latest.rhr_bpm} bpm` : "n/a"}</b>
          </div>
          <div className="kpi">
            <small>Sleep</small>
            <b>{sleepH !== null ? `${sleepH.toFixed(1)} h` : "n/a"}</b>
            <em className="muted">goal {goal.toFixed(1)} h</em>
          </div>
        </div>
      </div>
    </div>
  );
}
