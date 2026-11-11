"use client";
import { useState } from "react";
import { SPORT_LABEL, formatDistance, formatDuration, localDay, paceLabel, type Activity } from "@/lib/activities";

export default function ActivityCard({ a, busy, onSaveNote, onSummarize }: {
  a: Activity;
  busy: boolean;
  onSaveNote: (id: number, note: string) => Promise<void>;
  onSummarize: (id: number) => Promise<void>;
}) {
  const [note, setNote] = useState(a.note ?? "");
  const [saving, setSaving] = useState(false);
  const dirty = note.trim() !== (a.note ?? "");
  const pace = paceLabel(a.sport, a.duration_s, a.distance_m);
  const label = SPORT_LABEL[a.sport] ?? a.sport;

  async function save() {
    setSaving(true);
    try { await onSaveNote(a.id, note.trim()); } finally { setSaving(false); }
  }

  return (
    <article className="card act">
      <div className="act-head">
        <span className="badge">{label}</span>
        <b>{a.title || label}</b>
        <span className="muted small">{localDay(a.started_at)}</span>
      </div>
      <div className="metrics">
        <div><small>Duration</small><b>{formatDuration(a.duration_s)}</b></div>
        <div><small>Distance</small><b>{formatDistance(a.distance_m)}</b></div>
        <div><small>{a.sport === "bike" ? "Speed" : "Pace"}</small><b>{pace ?? "—"}</b></div>
        <div><small>Avg HR</small><b>{a.avg_hr ? `${a.avg_hr}` : "—"}</b></div>
        <div><small>Load</small><b>{a.load !== null ? Math.round(a.load) : "—"}</b></div>
      </div>

      <label className="note">Anything APEX should know about this session?
        <textarea value={note} maxLength={1000} rows={2} placeholder="e.g. cut the warm-up short, felt tired, hot day…"
          onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="row">
        <button className="btn ghost" type="button" disabled={!dirty || saving} onClick={save}>{saving ? "Saving…" : "Save note"}</button>
        <button className="btn" type="button" disabled={busy || dirty} onClick={() => onSummarize(a.id)}
          title={dirty ? "Save your note first so the summary can use it" : undefined}>
          {busy ? "Writing…" : a.ai_summary ? "Regenerate summary" : "Summarise this session"}
        </button>
      </div>
      {a.ai_summary && (
        <div className="summary">
          <p>{a.ai_summary}</p>
          <small className="muted">AI summary of your data, not medical advice{a.ai_summary_at ? ` · ${localDay(a.ai_summary_at)}` : ""}</small>
        </div>
      )}
    </article>
  );
}
