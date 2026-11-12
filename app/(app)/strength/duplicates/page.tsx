"use client";
import { useCallback, useEffect, useState } from "react";
import { errText, fmtMin, sdb } from "@/lib/strength/hooks";
import { NotSetUp, activitySources, keepSeparate, loadDecisions, loadLinks, mergeSources, revertDecision, strengthSources, unmerge } from "@/lib/strength/data";
import { findCandidates, interval, mergedView, sourceLabel, trainingItems, type Candidate, type Link, type Source, type TrainingItem } from "@/lib/strength/dedup";
import { SetupNotice, StrengthNav } from "@/components/strength/Bits";

const t = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
function Side({ s }: { s: Source }) {
  const i = interval(s);
  return (
    <div className="factbox" style={{ margin: 0 }}>
      <div className="factrow"><span className="muted">Source</span><b>{sourceLabel(s)}{s.kind === "activity" && s.device ? ` · ${s.device}` : ""}</b></div>
      <div className="factrow"><span className="muted">Name</span><b>{s.title ?? "–"}</b></div>
      <div className="factrow"><span className="muted">Start</span><b>{t(s.startedAt)}</b></div>
      <div className="factrow"><span className="muted">End</span><b>{i.end ? t(new Date(i.end).toISOString()) : "not recorded"}</b></div>
      <div className="factrow"><span className="muted">Duration</span><b>{i.end ? fmtMin(Math.round((i.end - i.start) / 1000)) : "–"}</b></div>
      {s.kind === "activity" ? <>
        <div className="factrow"><span className="muted">Heart rate</span><b>{s.avgHr ? `avg ${s.avgHr}${s.maxHr ? `, max ${s.maxHr}` : ""} bpm` : "not available"}</b></div>
        <div className="factrow"><span className="muted">Calories</span><b>{s.calories ?? "–"}</b></div>
        <div className="factrow"><span className="muted">Training load</span><b>{s.load ?? "–"}</b></div>
        <div className="factrow"><span className="muted">Sport</span><b>{s.sport}</b></div>
      </> : <>
        <div className="factrow"><span className="muted">Exercises</span><b>{s.exercises}</b></div>
        <div className="factrow"><span className="muted">Sets</span><b>{s.sets}</b></div>
        <div className="small muted">{s.exerciseNames.slice(0, 8).join(" · ")}</div>
      </>}
    </div>
  );
}

export default function DuplicatesPage() {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [links, setLinks] = useState<Link[]>([]);
  const [decisions, setDecisions] = useState<Awaited<ReturnType<typeof loadDecisions>>>([]);
  const [cands, setCands] = useState<Candidate[]>([]);
  const [merged, setMerged] = useState<TrainingItem[]>([]);
  const [notSetUp, setNotSetUp] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const since = new Date(Date.now() - 365 * 86_400_000).toISOString();
      const [acts, str, l, d] = await Promise.all([activitySources(sdb(), since), strengthSources(sdb(), since), loadLinks(sdb()), loadDecisions(sdb())]);
      const all: Source[] = [...acts, ...str];
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      setSources(all); setLinks(l); setDecisions(d);
      setCands(findCandidates(all, l, d, tz));
      setMerged(trainingItems(all, l).filter((x) => x.merged));
    } catch (e) { if (e instanceof NotSetUp) setNotSetUp(true); else setMsg({ ok: false, text: errText(e) }); setSources([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function merge(c: Candidate, primary: Source) {
    const v = mergedView(c.a, c.b, primary);
    if (!window.confirm(`Merge into one workout?\n\nTitle and time from: ${v.title.source}\nHeart rate and calories from: ${v.avgHr?.source ?? "none"}\nExercises and sets from: ${v.sets?.source ?? "none"}\n\nBoth original records are kept unchanged, and you can undo this later.`)) return;
    setBusy(c.key);
    try { await mergeSources(sdb(), [{ kind: c.a.kind, id: c.a.id }, { kind: c.b.kind, id: c.b.id }], primary === c.a ? 0 : 1, c.confidence); setMsg({ ok: true, text: "Merged. It now counts as one workout." }); await load(); }
    catch (e) { setMsg({ ok: false, text: errText(e) }); } finally { setBusy(null); }
  }
  async function separate(c: Candidate) {
    setBusy(c.key);
    try { await keepSeparate(sdb(), c.key, c.confidence); setMsg({ ok: true, text: "Kept as two separate workouts." }); await load(); } catch (e) { setMsg({ ok: false, text: errText(e) }); } finally { setBusy(null); }
  }
  async function undoMerge(item: TrainingItem) {
    if (!window.confirm("Undo this merge? Both original records come back as separate workouts.")) return;
    try { await unmerge(sdb(), item.key.replace(/^ts:/, "")); setMsg({ ok: true, text: "Merge undone." }); await load(); } catch (e) { setMsg({ ok: false, text: errText(e) }); }
  }
  async function undoSeparate(id: string) { try { await revertDecision(sdb(), id); await load(); } catch (e) { setMsg({ ok: false, text: errText(e) }); } }

  return (
    <>
      <div className="eyebrow">Strength Hub</div>
      <h1>Duplicate workouts</h1>
      <StrengthNav />
      <p className="muted small">The same gym session recorded twice (for example on your Forerunner 965 for heart rate and in Hevy for sets, sometimes also copied through Strava) is detected by real time overlap, not just the date. Nothing is merged without your decision, original records are never changed or deleted, and every decision can be undone.</p>
      {notSetUp && <SetupNotice what="Duplicate detection" />}
      {msg && <div className={msg.ok ? "notice ok" : "notice error"}>{msg.text}</div>}
      {sources === null ? <p className="muted">Loading…</p> : !notSetUp && (
        <>
          <h2>Possible duplicates ({cands.length})</h2>
          {cands.length === 0 && <div className="notice">No likely duplicates in the last 12 months. Sessions that merely fall on the same day are not flagged.</div>}
          {cands.map((c) => {
            const hevy = [c.a, c.b].find((s) => s.kind === "strength"), act = [c.a, c.b].find((s) => s.kind === "activity");
            return (
              <div key={c.key} className="card" style={{ marginBottom: 14, borderColor: c.confidence === "high" ? "var(--green)" : undefined }}>
                <div className="act-head"><span className={`pill ${c.confidence === "high" ? "st-ok" : "st-low"}`}>{c.confidence === "high" ? "High confidence" : "Medium confidence: please check"}</span><span className="muted small">{c.reasons.join(" · ")}</span></div>
                <div className="cmp"><Side s={c.a} /><Side s={c.b} /></div>
                <div className="row" style={{ marginTop: 10 }}>
                  {act && hevy ? <>
                    <button className="btn tiny" disabled={busy === c.key} onClick={() => void merge(c, act)}>Merge · {sourceLabel(act)} as primary</button>
                    <button className="btn tiny" disabled={busy === c.key} onClick={() => void merge(c, hevy)}>Merge · {sourceLabel(hevy)} as primary</button>
                  </> : <>
                    <button className="btn tiny" disabled={busy === c.key} onClick={() => void merge(c, c.a)}>Merge · {sourceLabel(c.a)} as primary</button>
                    <button className="btn tiny" disabled={busy === c.key} onClick={() => void merge(c, c.b)}>Merge · {sourceLabel(c.b)} as primary</button>
                  </>}
                  <button className="btn ghost tiny" disabled={busy === c.key} onClick={() => void separate(c)}>Keep both separately</button>
                </div>
              </div>
            );
          })}

          <h2>Merged workouts ({merged.length})</h2>
          {merged.length === 0 ? <p className="muted small">None yet.</p> : (
            <div className="card">{merged.map((m) => (
              <div key={m.key} className="doserow"><span className="muted small tl-date">{m.startedAt.slice(0, 10)}</span><span style={{ flex: 1 }}><b>{m.title}</b> <span className="muted small">· {m.sources.join(" + ")}{m.detail ? ` · ${m.detail}` : ""}</span></span><button className="btn ghost tiny" onClick={() => void undoMerge(m)}>Undo merge</button></div>
            ))}</div>
          )}
          {decisions.some((d) => d.decision === "separate" && !d.revertedAt) && (
            <>
              <h2>Kept separate</h2>
              <div className="card">{decisions.filter((d) => d.decision === "separate" && !d.revertedAt).map((d) => (
                <div key={d.id} className="doserow"><span className="muted small">{d.createdAt.slice(0, 10)}</span><span style={{ flex: 1 }} className="small">{d.pairKey.replace("|", " and ")}</span><button className="btn ghost tiny" onClick={() => void undoSeparate(d.id)}>Ask me again</button></div>
              ))}</div>
            </>
          )}
          <p className="muted small">Strava copies are only linked inside APEX; nothing is changed or deleted in Strava, Garmin Connect or Intervals.icu. {links.length} source link(s) stored.</p>
        </>
      )}
    </>
  );
}
