"use client";
import type { DailyResult, SessionResult } from "@/lib/coach/engine";
import type { Fact } from "@/lib/coach/context";
import { CATEGORY_INFO, type Category } from "@/lib/coach/schema";

export const Facts = ({ title, facts }: { title: string; facts: Fact[] }) => (
  <div className="factbox">
    <small className="tag measured">{title}</small>
    {facts.map((f, i) => <div key={i} className="factrow"><span className="muted small">{f.label}</span><b>{f.value}</b></div>)}
  </div>
);
const Sent = ({ cats }: { cats: string[] }) => (
  <p className="muted small" style={{ margin: "10px 0 0" }}>{cats.length ? `Data sent to the AI: ${cats.map((c) => CATEGORY_INFO[c as Category]?.label ?? c).join(", ")}.` : "No personal data was sent to the AI."}</p>
);
const List = ({ title, items }: { title: string; items: string[] }) => !items.length ? null : (
  <div style={{ marginTop: 10 }}><b className="small">{title}</b><ul className="small" style={{ margin: "4px 0 0", paddingLeft: 18 }}>{items.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
);
const BASIS = { measured: "measured", reported: "reported", interpretation: "AI interpretation" } as const;

export function SessionCard({ r }: { r: SessionResult }) {
  return (
    <article className="card assess">
      <div className="act-head">
        <span className="badge">{r.mode === "planned" ? "Planned session" : "Completed session"}</span>
        <b>{r.sport}</b>
        <span className={`pill conf-${r.confidence}`}>Confidence: {r.confidence}</span>
      </div>
      <Facts title={`Measured or reported (not AI)`} facts={r.facts} />
      {r.status === "scored" && r.score !== null ? (
        <>
          <div className="scoreline"><div className="bigscore">{r.score}<small>/100</small></div><div><b>{r.category}</b><div className="muted small">{r.mode === "planned" ? "Design score: how well the plan fits its objective" : "Quality score: how well the session fits its objective"}</div></div></div>
          <small className="tag ai">AI interpretation</small>
          {r.summary && <p style={{ margin: "6px 0 10px" }}>{r.summary}</p>}
          <div>
            {r.breakdown.map((b) => (
              <div key={b.key} className="catrow">
                <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}><span className="small"><b>{b.label}</b> <span className="muted">({BASIS[b.basis]})</span></span><span className="small">{b.points} / {b.max}</span></div>
                <div className="bar"><i style={{ width: `${Math.round((b.points / b.max) * 100)}%` }} /></div>
                <div className="muted small">{b.reason}</div>
              </div>
            ))}
            {r.excluded.length > 0 && <p className="muted small" style={{ marginBottom: 0 }}>Not scored (no evidence, so it did not lower the score): {r.excluded.map((e) => `${e.label}: ${e.why}`).join(" ")}</p>}
          </div>
        </>
      ) : (
        <div className="notice" style={{ marginTop: 12 }}><b>No score yet.</b> The Coach needs more information before it can score this session.
          {r.summary && <p className="small" style={{ margin: "6px 0 0" }}>{r.summary}</p>}</div>
      )}
      {r.questions.length > 0 && <List title="The Coach needs to know" items={r.questions} />}
      <List title="Strengths" items={r.strengths} /><List title="What could be better" items={r.weaknesses} /><List title="Next time" items={r.recommendations} />
      <div style={{ marginTop: 10 }}>
        <b className="small">History</b>
        <p className="small" style={{ margin: "4px 0" }}>{r.history.note}</p>
        {r.history.changes.length > 0 && <Facts title="Measured comparison (not AI)" facts={r.history.changes} />}
        {r.history.comment && <><small className="tag ai">AI interpretation</small><p className="small" style={{ margin: "4px 0 0" }}>{r.history.comment}</p></>}
      </div>
      <p className="muted small" style={{ margin: "12px 0 0" }}>{r.rubricNote} AI-generated guidance, not medical advice.</p>
      <Sent cats={r.categories_sent} />
    </article>
  );
}

export function DailyCard({ r }: { r: DailyResult }) {
  return (
    <article className="card assess">
      <div className="act-head"><span className="badge">Daily Coach</span><span className={`pill conf-${r.confidence}`}>Confidence: {r.confidence}</span></div>
      {r.facts.length > 0 && <Facts title="Your data (measured, not AI)" facts={r.facts} />}
      {r.status === "ok" ? (
        <>
          <small className="tag ai">AI interpretation</small>
          <p style={{ margin: "6px 0" }}><b>{r.summary}</b></p>
          <p className="small" style={{ margin: "0 0 8px" }}>{r.recovery}</p>
          {r.vs_baseline.length > 0 && <div className="small">{r.vs_baseline.map((v, i) => <div key={i}><b>{v.topic}:</b> {v.note}</div>)}</div>}
          {r.load_trend && <p className="small" style={{ margin: "8px 0 0" }}><b>Load:</b> {r.load_trend}</p>}
          <List title="Suggestions for today (you decide)" items={r.suggestions} />
          {r.caution && <div className="notice" style={{ marginTop: 10 }}>{r.caution}</div>}
        </>
      ) : <div className="notice" style={{ marginTop: 12 }}>There is not enough data for a daily analysis yet.</div>}
      <List title="Missing or limited data" items={r.missing} />
      <p className="muted small" style={{ margin: "12px 0 0" }}>Suggestions only, never a diagnosis. No readiness score is shown because one metric cannot decide it.</p>
      <Sent cats={r.categories_sent} />
    </article>
  );
}