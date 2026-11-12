"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/lib/useAuth";
import { coachRequest } from "@/lib/api";
import { getEngine } from "@/lib/strength/runtime";
import { errText, fmtMin, sdb, useHistory, useLibrary } from "@/lib/strength/hooks";
import { NotSetUp, hsessionFromWorkout, loadWorkout } from "@/lib/strength/data";
import { E1RM_FORMULA, PR_LABEL, compareWithPrevious, durationSeconds, exerciseStats, personalRecords } from "@/lib/strength/analytics";
import { snapshotOf } from "@/lib/strength/actions";
import { setDetails, type Workout } from "@/lib/strength/workout";
import { isUuid } from "@/lib/strength/types";
import type { SyncEngine } from "@/lib/strength/sync";
import WorkoutEditor from "@/components/strength/WorkoutEditor";
import { SetupNotice, StrengthNav, SyncPill } from "@/components/strength/Bits";

const r1 = (n: number) => Math.round(n * 10) / 10;

export default function WorkoutSummaryPage() {
  const { session } = useAuth();
  const router = useRouter();
  const id = String(useParams<{ id: string }>().id);
  const lib = useLibrary();
  const hist = useHistory(lib.custom);
  const engineRef = useRef<SyncEngine | null>(null);
  const [w, setW] = useState<Workout | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "missing" | "not_set_up">("loading");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ai, setAi] = useState<{ consent: boolean; busy: boolean; text: string | null }>({ consent: false, busy: false, text: null });

  useEffect(() => {
    if (!session || !isUuid(id)) { if (!isUuid(id)) setState("missing"); return; }
    (async () => {
      const { engine } = await getEngine();
      engineRef.current = engine;
      const local = engine.local.workouts[id];
      if (local) { setW(local); setState("ok"); return; }
      try {
        const remote = await loadWorkout(sdb(), id, lib.resolve);
        if (!remote) { setState("missing"); return; }
        await engine.adopt(remote);                                   // edits are now diffed against what the server has
        setW(remote); setState("ok");
      } catch (e) { if (e instanceof NotSetUp) setState("not_set_up"); else { setError(errText(e)); setState("missing"); } }
    })().catch((e) => { setError(errText(e)); setState("missing"); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, id]);

  const save = useCallback((next: Workout) => {
    setW(next);
    const eng = engineRef.current; if (!eng) return;
    eng.record(next, { active: false }).then(() => eng.flush()).catch((e) => setError(errText(e)));
  }, []);

  const hs = useMemo(() => (w ? hsessionFromWorkout(w) : null), [w]);
  const others = useMemo(() => (hist.sessions ?? []).filter((s) => s.id !== id), [hist.sessions, id]);
  const pr = useMemo(() => (hs ? personalRecords(hs, [...others, hs]) : null), [hs, others]);
  const cmp = useMemo(() => (hs ? compareWithPrevious(hs, [...others, hs]) : []), [hs, others]);

  async function remove() {
    if (!w || !window.confirm("Delete this workout from your history?") || !window.confirm("This cannot be undone. Delete it?")) return;
    await engineRef.current?.discard(w);
    void engineRef.current?.flush();
    router.push("/strength");
  }
  async function evaluate() {
    if (!w) return;
    setAi({ ...ai, busy: true });
    try {
      const r = await coachRequest({ intent: "chat", domain: "strength", message: "Give me a short, honest evaluation of this finished workout using only the logged data: what went well, what to watch, and one suggestion for next time. Do not invent comparisons.", strength: snapshotOf(w, { elapsedMin: (durationSeconds(hs!) ?? 0) / 60, equipment: [], objective: "", currentId: null }) }, ["strength"]);
      setAi({ consent: true, busy: false, text: r.kind === "chat" ? r.answer : null });
    } catch (e) { setAi({ ...ai, busy: false, text: null }); setError(errText(e)); }
  }

  if (state === "loading") return <><StrengthNav /><p className="muted">Loading…</p></>;
  if (state === "not_set_up") return <><StrengthNav /><SetupNotice what="Viewing saved workouts" /></>;
  if (state === "missing" || !w || !hs) return <><StrengthNav /><div className="notice">{error ?? "Workout not found."} <Link href="/strength" style={{ color: "var(--green)" }}>Back</Link></div></>;

  const stats = hs.exercises.map((e) => ({ e, s: exerciseStats(hs, e) })).filter((x) => x.s.workingSets > 0);
  const workingSets = stats.reduce((n, x) => n + x.s.workingSets, 0), reps = stats.reduce((n, x) => n + x.s.reps, 0);
  return (
    <>
      <div className="eyebrow">Workout summary</div>
      <h1>{w.title}</h1>
      <StrengthNav />
      <p className="muted small">{new Date(w.startedAt).toLocaleString()} {w.source === "hevy_csv" && <span className="badge off">Imported from Hevy</span>} <SyncPill /></p>
      {error && <div className="notice error">{error}</div>}
      <div className="statgrid">
        <div className="kpi"><small>Duration</small><b>{fmtMin(durationSeconds(hs))}</b></div>
        <div className="kpi"><small>Exercises</small><b>{stats.length}</b></div>
        <div className="kpi"><small>Working sets</small><b>{workingSets}</b></div>
        <div className="kpi"><small>Total reps</small><b>{reps}</b></div>
      </div>

      <h2>Personal records</h2>
      {pr && pr.prs.length > 0 ? (
        <div className="card">{pr.prs.map((p, i) => <div key={i} className="doserow">🏆 <b>{p.exerciseName}</b><span>{PR_LABEL[p.kind]}: {r1(p.value)} {p.unit} <span className="muted small">(previous best {r1(p.previous)} {p.unit})</span></span></div>)}</div>
      ) : <div className="notice">No new records compared with your logged history{hist.setUp === false ? " (history is not available until migration 13 is applied)" : ""}.</div>}
      {pr && pr.baselines.length > 0 && <p className="muted small">First time logged, so nothing to compare yet: {pr.baselines.join(", ")}.</p>}

      <h2>Exercises</h2>
      <div className="card tablewrap">
        <table className="tbl">
          <thead><tr><th>Exercise</th><th>Working sets</th><th>Reps</th><th>Best set</th><th>Volume*</th><th>Compared with last time</th></tr></thead>
          <tbody>{stats.map(({ e, s }, i) => (
            <tr key={i}><td>{e.name}</td><td>{s.workingSets}</td><td>{s.reps}</td>
              <td>{s.best ? `${r1(s.best.weight)} ${s.best.unit} × ${s.best.reps}${e.loadMode === "per_hand" ? " per hand" : ""}` : "–"}{s.e1rmKg ? <span className="muted small"> (est. 1RM {r1(s.e1rmKg)} kg)</span> : null}</td>
              <td>{s.volumeKg > 0 ? `${Math.round(s.volumeKg)} kg` : "–"}</td>
              <td className="small">{cmp.find((c) => c.exerciseName === e.name)?.change ?? <span className="muted">no earlier session</span>}</td></tr>
          ))}</tbody>
        </table>
      </div>
      <p className="muted small">*Volume = external load × reps of working sets (dumbbells per hand counted twice), per exercise only. It is a log figure, not a measure of physiological load, and is never added across exercises. {E1RM_FORMULA}</p>

      <h2>Notes and effort</h2>
      <div className="card formgrid">
        <label>Effort (1–10)<select value={w.effort ?? ""} onChange={(e) => save(setDetails(w, { effort: e.target.value ? Number(e.target.value) : null }))}><option value="">–</option>{Array.from({ length: 10 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        <label style={{ gridColumn: "1 / -1" }}>Notes<textarea rows={3} defaultValue={w.notes ?? ""} maxLength={4000} onBlur={(e) => { if ((e.target.value || null) !== w.notes) save(setDetails(w, { notes: e.target.value })); }} /></label>
      </div>

      <h2>AI evaluation (optional)</h2>
      <div className="card">
        {ai.text ? <p style={{ whiteSpace: "pre-wrap", marginTop: 0 }}>{ai.text}</p> : (
          <>
            <label className="check"><input type="checkbox" checked={ai.consent} onChange={(e) => setAi({ ...ai, consent: e.target.checked })} /> Send this workout and my strength history to the AI (Google Gemini) for a short evaluation.</label>
            <button className="btn" disabled={!ai.consent || ai.busy} onClick={() => void evaluate()}>{ai.busy ? "Asking…" : "Evaluate with Ask APEX"}</button>
            <p className="muted small" style={{ marginBottom: 0 }}>No score is produced; the answer only uses the sets logged here and your real history.</p>
          </>
        )}
      </div>

      <h2>Correct this workout</h2>
      {!editing ? (
        <div className="row"><button className="btn ghost" onClick={() => setEditing(true)}>Edit sets and exercises</button><button className="btn ghost" onClick={() => void remove()}>Delete workout</button></div>
      ) : (
        <>
          <div className="notice">You are editing a finished workout. Changes are saved as you make them and replace what was recorded.</div>
          <div className="card formgrid" style={{ marginBottom: 12 }}>
            <label>Start<input type="datetime-local" defaultValue={toLocalInput(w.startedAt)} onBlur={(e) => { try { save(setDetails(w, { startedAt: new Date(e.target.value).toISOString() })); } catch (x) { setError(errText(x)); } }} /></label>
            <label>End<input type="datetime-local" defaultValue={w.endedAt ? toLocalInput(w.endedAt) : ""} onBlur={(e) => { try { save(setDetails(w, { endedAt: new Date(e.target.value).toISOString() })); } catch (x) { setError(errText(x)); } }} /></label>
          </div>
          <WorkoutEditor w={w} save={save} all={lib.all} resolve={lib.resolve} history={others} mode="edit" />
          <button className="btn" style={{ marginTop: 12 }} onClick={() => setEditing(false)}>Done editing</button>
        </>
      )}
    </>
  );
}
function toLocalInput(iso: string) { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
