import { formatDuration, type WeekTotals } from "@/lib/activities";

const fmt = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

export default function WeekCard({ start, end, totals, summary, busy, canNext, onPrev, onNext, onSummarize }: {
  start: string; end: string; totals: WeekTotals; summary: string | null; busy: boolean; canNext: boolean;
  onPrev: () => void; onNext: () => void; onSummarize: () => void;
}) {
  const km = Object.entries(totals.km).map(([s, v]) => `${s} ${v.toFixed(1)} km`).join(" · ");
  return (
    <section className="card">
      <div className="week-nav">
        <button className="btn ghost" type="button" onClick={onPrev} aria-label="Previous week">‹</button>
        <b>Week of {fmt(start)} – {fmt(end)}</b>
        <button className="btn ghost" type="button" onClick={onNext} disabled={!canNext} aria-label="Next week">›</button>
      </div>
      <div className="metrics week-metrics">
        <div><small>Sessions</small><b>{totals.sessions}</b></div>
        <div><small>Time</small><b>{formatDuration(totals.minutes * 60)}</b></div>
        <div><small>Load</small><b>{totals.load}</b></div>
        <div><small>Distance</small><b>{km || "—"}</b></div>
      </div>
      <div className="row">
        <button className="btn" type="button" disabled={busy || totals.sessions === 0} onClick={onSummarize}>
          {busy ? "Writing…" : summary ? "Regenerate weekly summary" : "Summarise my week"}
        </button>
      </div>
      {summary && (
        <div className="summary">
          <p>{summary}</p>
          <small className="muted">AI summary of your data, not medical advice</small>
        </div>
      )}
    </section>
  );
}
