"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/useAuth";
import { getEngine, newId } from "@/lib/strength/runtime";
import { useHistory, useLibrary, useRoutines, fmtClock, fmtMin, errText } from "@/lib/strength/hooks";
import { TEMPLATES, fromTemplate, toPlan, type Routine } from "@/lib/strength/routines";
import { GYM_KEY, readScoped, writeScoped } from "@/lib/strength/scope";
import { snapshotOf } from "@/lib/strength/actions";
import { durationSeconds, workingExercises, workingSetCount } from "@/lib/strength/analytics";
import { EQUIPMENT, EQUIPMENT_LABEL, type Equipment } from "@/lib/strength/types";
import { currentExercise, elapsedSeconds, finish, nextExercise, pause, progress, resume, setDetails, startWorkout, type Workout } from "@/lib/strength/workout";
import type { SyncEngine } from "@/lib/strength/sync";
import WorkoutEditor from "@/components/strength/WorkoutEditor";
import RestTimer, { loadRest, saveRest, type RestState } from "@/components/strength/RestTimer";
import AskApex from "@/components/strength/AskApex";
import WorkoutHeader from "@/components/strength/WorkoutHeader";
import EmptyState, { LoadProblem } from "@/components/ui/EmptyState";
import { EMPTY } from "@/lib/emptyStates";
import { loadView } from "@/lib/emptyStates";
import { SetupNotice, StrengthNav, SyncPill } from "@/components/strength/Bits";


export default function StrengthPage() {
  const { session } = useAuth();
  const router = useRouter();
  const lib = useLibrary();
  const hist = useHistory(lib.custom);
  const rts = useRoutines();
  const engineRef = useRef<SyncEngine | null>(null);
  const [w, setW] = useState<Workout | null>(null);
  const [ready, setReady] = useState(false);
  const [unsynced, setUnsynced] = useState<Workout[]>([]);
  const [rest, setRest] = useState<RestState | null>(null);
  const [now, setNow] = useState(() => new Date().toISOString());
  const [finishing, setFinishing] = useState(false);
  const [ask, setAsk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const flushTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!session) return;
    getEngine().then(async ({ engine }) => {
      engineRef.current = engine;
      await engine.prune().catch(() => undefined);              // forget local copies of finished workouts that are fully uploaded
      const local = engine.local;
      setW(local.activeId ? local.workouts[local.activeId] ?? null : null);
      setUnsynced(engine.pendingWorkouts().filter((x) => x.status === "completed"));
      setReady(true);
    }).catch((e) => { setError(errText(e)); setReady(true); });
    setRest(loadRest(session.user.id));
    setEquipment(readScoped<Equipment[]>(typeof localStorage === "undefined" ? null : localStorage, GYM_KEY, session.user.id, []));
  }, [session]);
  // While a workout is active the page marks the document, so the global Quick actions button steps aside for the whole workout (app/globals.css: html.workout-live).
  const workoutLive = w?.status === "active";
  useEffect(() => { document.documentElement.classList.toggle("workout-live", workoutLive); return () => document.documentElement.classList.remove("workout-live"); }, [workoutLive]);
  useEffect(() => { if (!w || w.status !== "active") return; const t = window.setInterval(() => setNow(new Date().toISOString()), 1000); return () => window.clearInterval(t); }, [w]);

  /** Every change is written to the device first (IndexedDB), then uploaded shortly after. */
  const save = useCallback((next: Workout, o: { active?: boolean } = { active: true }) => {
    setW(next);
    const eng = engineRef.current;
    if (!eng) return;
    eng.record(next, o).catch((e) => setError(`Could not save on this device: ${errText(e)}`));
    if (flushTimer.current) window.clearTimeout(flushTimer.current);
    flushTimer.current = window.setTimeout(() => { void eng.flush(); }, 1200);
  }, []);

  const start = (routine?: Routine) => {
    try {
      let plan, skipped: string[] = [];
      if (routine) ({ plan, skipped } = toPlan(routine, lib.custom));
      const next = startWorkout({ id: newId(), title: routine?.name ?? "Workout", now: new Date().toISOString(), newId, defaultUnit: "kg", routineId: routine && rts.routines?.some((r) => r.id === routine.id) ? routine.id : null, plan, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      save(next);
      if (skipped.length) setError(`${skipped.length} exercise(s) in the routine no longer exist and were left out.`);
    } catch (e) { setError(errText(e)); }
  };
  // "Start workout" from the Routines tab arrives as ?routine=<id>; it never replaces a workout already in progress.
  useEffect(() => {
    if (!ready || !rts.routines) return;
    const id = new URLSearchParams(window.location.search).get("routine");
    if (!id) return;
    window.history.replaceState(null, "", "/strength");
    const r = rts.routines.find((x) => x.id === id);
    if (w) setError("A workout is already in progress. Finish or cancel it before starting another.");
    else if (r) start(r);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, rts.routines]);
  const startRest = (seconds: number, label: string) => { const r = { endAt: Date.now() + seconds * 1000, pausedLeft: null, total: seconds, label }; saveRest(session?.user.id, r); setRest(r); };

  async function doFinish(discardIncomplete: boolean) {
    if (!w) return;
    try {
      const done = finish(w, new Date().toISOString(), { discardIncomplete });
      setW(null); setFinishing(false); saveRest(session?.user.id, null); setRest(null);
      await engineRef.current?.record(done, { active: false });
      void engineRef.current?.flush();
      router.push(`/strength/history/${done.id}`);
    } catch (e) { setError(errText(e)); setFinishing(false); }
  }
  async function cancel() {
    if (!w || !window.confirm("Cancel this workout? Everything logged in it will be deleted.")) return;
    await engineRef.current?.discard(w);
    void engineRef.current?.flush();
    setW(null); saveRest(session?.user.id, null); setRest(null);
  }
  /** Minimise: leave the screen and keep the workout. Nothing is discarded or finished; it is already saved on this device (every change is), the rest timer keeps
   *  its end time, and Today offers "Continue your workout". */
  const minimise = () => { void engineRef.current?.flush(); router.push("/today"); };
  const toggleEq = (q: Equipment) => { const n = equipment.includes(q) ? equipment.filter((x) => x !== q) : [...equipment, q]; setEquipment(n); writeScoped(localStorage, GYM_KEY, session?.user.id, n); };

  if (!ready) return <><div className="eyebrow">Strength Hub</div><h1>Strength</h1><p className="muted">Loading…</p></>;

  if (w && w.status === "active") {
    const p = progress(w), cur = currentExercise(w), nxt = nextExercise(w), open = p.total - p.done;
    return (
      <>
        <WorkoutHeader w={w} now={now} done={p.done} total={p.total} current={cur?.name ?? null} next={nxt?.name ?? null} sync={<SyncPill />}
          alerts={typeof Notification !== "undefined" && Notification.permission === "default"}
          onRename={(title) => save(setDetails(w, { title: title || "Workout" }))} onMinimise={minimise} onFinish={() => setFinishing(true)}
          onPause={() => save(pause(w, new Date().toISOString()))} onResume={() => save(resume(w, new Date().toISOString()))} onAsk={() => setAsk(true)}
          onEnableAlerts={() => void Notification.requestPermission()} onCancel={() => void cancel()} />
        {error && <div className="notice error" role="alert">{error} <button className="linkbtn" onClick={() => setError(null)}>Dismiss</button></div>}
        {lib.setUp === false && <SetupNotice what="Uploading workouts" />}
        {finishing && (
          <div className="notice" role="dialog" aria-label="Finish workout">
            <b>Finish workout?</b> {open > 0 ? `${open} set${open > 1 ? "s are" : " is"} not marked done.` : "All sets are done."}
            <div className="row" style={{ marginTop: 8 }}>
              {open > 0 && <button className="btn tiny" onClick={() => void doFinish(true)}>Discard unfinished sets and finish</button>}
              <button className={open > 0 ? "btn ghost tiny" : "btn tiny"} onClick={() => void doFinish(false)}>{open > 0 ? "Keep them (not done) and finish" : "Finish"}</button>
              <button className="btn ghost tiny" onClick={() => setFinishing(false)}>Back</button>
            </div>
          </div>
        )}
        <WorkoutEditor w={w} save={save} all={lib.all} resolve={lib.resolve} history={hist.sessions ?? []} mode="live" onRest={startRest} />
        <AskApex open={ask} onClose={() => setAsk(false)} w={w} save={save} custom={lib.custom}
          snapshot={() => snapshotOf(w, { elapsedMin: elapsedSeconds(w, new Date().toISOString()) / 60, equipment, objective: "", currentId: currentExercise(w)?.id ?? null, routineName: rts.routines?.find((r) => r.id === w.routineId)?.name ?? null })} />
        <RestTimer rest={rest} setRest={setRest} userId={session?.user.id ?? ""} />
      </>
    );
  }

  // "No finished workouts" is only true when history loaded successfully; a failed load or a missing set-up is reported as such, never as empty.
  const histView = loadView({ loaded: hist.sessions !== null, error: hist.error, notSetUp: hist.setUp === false, count: (hist.sessions ?? []).length });
  const recent = [...(hist.sessions ?? [])].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, 8);
  return (
    <>
      <div className="eyebrow">Strength Hub</div>
      <h1>Strength</h1>
      <StrengthNav />
      {error && <div className="notice error">{error}</div>}
      {(lib.setUp === false || hist.setUp === false) && <SetupNotice what="Saving routines, history and analytics" />}
      <div className="captiles">
        <button className="captile on" onClick={() => start()}><b>Start empty workout</b><span className="muted small">Add exercises as you go.</span></button>
        {(rts.routines ?? []).slice(0, 5).map((r) => <button key={r.id} className="captile" onClick={() => start(r)}><b>{r.name}</b><span className="muted small">{r.exercises.length} exercises · start routine</span></button>)}
      </div>
      <details className="card" style={{ marginBottom: 14 }}>
        <summary><b>Quick start from a template</b></summary>
        <div className="row" style={{ marginTop: 10 }}>{Object.keys(TEMPLATES).map((k) => <button key={k} className="chip" onClick={() => start(fromTemplate(k, newId()))}>{TEMPLATES[k].name}</button>)}</div>
        <p className="muted small" style={{ marginBottom: 0 }}>Templates have no weights filled in. <Link href="/strength/routines" style={{ color: "var(--green)" }}>Save one as your own routine</Link> to edit it.</p>
      </details>
      <details className="card" style={{ marginBottom: 14 }}>
        <summary><b>Equipment at my gym</b> <span className="muted small">(used by Ask APEX for substitutes)</span></summary>
        <div className="row" style={{ marginTop: 10 }}>{EQUIPMENT.map((q) => <button key={q} className={equipment.includes(q) ? "chip on" : "chip"} aria-pressed={equipment.includes(q)} onClick={() => toggleEq(q)}>{EQUIPMENT_LABEL[q]}</button>)}</div>
      </details>
      {unsynced.length > 0 && <div className="notice">Finished on this device, waiting to upload: {unsynced.map((u) => <Link key={u.id} href={`/strength/history/${u.id}`} style={{ color: "var(--green)", marginRight: 8 }}>{u.title} ({u.startedAt.slice(0, 10)})</Link>)} <SyncPill /></div>}
      <h2>Recent workouts</h2>
      {histView === "error" && <LoadProblem message={hist.error ?? ""} onRetry={() => void hist.reload()} />}
      {histView === "loading" ? <p className="muted">Loading…</p> : histView === "empty" ? <EmptyState copy={EMPTY["strength-history"]} headingLevel={3} onAction={() => start()} /> : recent.length === 0 ? null : (
        <div className="card">
          {recent.map((s) => (
            <Link key={s.id} href={`/strength/history/${s.id}`} className="doserow" style={{ textDecoration: "none", color: "inherit" }}>
              <span className="muted small tl-date">{s.startedAt.slice(0, 10)}</span>
              <span style={{ flex: 1 }}><b>{s.title}</b><span className="muted small"> · {workingExercises(s).length} exercises · {workingSetCount(s)} working sets · {fmtMin(durationSeconds(s))}</span></span>
              {s.source === "hevy_csv" && <span className="badge off">Hevy</span>}
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
