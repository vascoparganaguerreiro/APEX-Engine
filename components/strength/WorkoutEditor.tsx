"use client";
import { useEffect, useRef, useState } from "react";
import ExercisePicker from "./ExercisePicker";
import { fmtHSet, lastPerformance, type HSession } from "@/lib/strength/analytics";
import { MODES_FOR } from "@/lib/strength/library";
import { newId } from "@/lib/strength/runtime";
import { LOAD_MODE_LABEL, SET_TYPES, SET_TYPE_LABEL, SET_TYPE_SHORT, type Exercise, type LoadMode, type Measurement, type SetType } from "@/lib/strength/types";
import { WEIGHT_LABEL, weightStep } from "@/lib/strength/units";
import {
  addExercise, addSet, afterSet, completeSet, currentExercise, moveExercise, removeExercise, removeSet, replaceExercise, rpeRirMismatch, setCurrent, setExerciseNote,
  setExerciseUnit, setLoadMode, setRest, setSuperset, uncompleteSet, updateSet, type SetPatch, type WExercise, type WSet, type Workout,
} from "@/lib/strength/workout";

type FieldKey = "weight" | "reps" | "duration_s" | "distance_m";
interface Field { key: FieldKey | null; label: string }
function fieldsFor(m: Measurement, mode: LoadMode, unit: string): [Field, Field] {
  const w: Field = { key: "weight", label: `${WEIGHT_LABEL[mode] || "Weight"} (${unit})` };
  switch (m) {
    case "weight_reps": case "weighted_bodyweight": case "assisted_bodyweight": return [w, { key: "reps", label: "Reps" }];
    case "bodyweight_reps": return [mode === "added" || mode === "assisted" ? w : { key: null, label: "Bodyweight" }, { key: "reps", label: "Reps" }];
    case "duration": return [{ key: null, label: "" }, { key: "duration_s", label: "Seconds" }];
    case "weight_duration": return [w, { key: "duration_s", label: "Seconds" }];
    case "distance_duration": return [{ key: "distance_m", label: "Metres" }, { key: "duration_s", label: "Seconds" }];
    case "weight_distance": return [w, { key: "distance_m", label: "Metres" }];
  }
}

/** A number box that keeps what you type ("82." / "82,5") and saves each valid value immediately. */
function NumField({ value, onCommit, label, placeholder, integer }: { value: number | null; onCommit: (v: number | null) => void; label: string; placeholder?: string; integer?: boolean }) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(value === null ? "" : String(value)); }, [value]);
  return (
    <input aria-label={label} inputMode={integer ? "numeric" : "decimal"} placeholder={placeholder} value={text}
      onFocus={(e) => { focused.current = true; e.currentTarget.select(); }}
      onBlur={() => { focused.current = false; setText(value === null ? "" : String(value)); }}
      onChange={(e) => { setText(e.target.value); const t = e.target.value.replace(",", ".").trim(); if (t === "") onCommit(null); else { const n = Number(t); if (Number.isFinite(n)) onCommit(n); } }} />
  );
}

const nextType = (t: SetType): SetType => SET_TYPES[(SET_TYPES.indexOf(t) + 1) % SET_TYPES.length];
const fmtTarget = (s: WSet) => {
  const t = s.target; if (!t) return null;
  const reps = t.repsMin !== null && t.repsMax !== null && t.repsMin !== t.repsMax ? `${t.repsMin}–${t.repsMax}` : t.repsMax ?? t.repsMin;
  return [reps !== null && reps !== undefined ? `${reps} reps` : null, t.rpe !== null ? `RPE ${t.rpe}` : null, t.rir !== null ? `RIR ${t.rir}` : null, t.duration_s ? `${t.duration_s}s` : null].filter(Boolean).join(" · ") || null;
};

export default function WorkoutEditor({ w, save, all, resolve, history, mode, onRest }: {
  w: Workout; save: (next: Workout) => void; all: readonly Exercise[]; resolve: (key: string) => Exercise | null; history: HSession[]; mode: "live" | "edit";
  onRest?: (seconds: number, label: string) => void;
}) {
  const [picker, setPicker] = useState<{ kind: "add" } | { kind: "replace"; exId: string } | null>(null);
  const [openSet, setOpenSet] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = (f: () => Workout) => { try { save(f()); setError(null); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const historical = w.status === "completed";
  const cur = currentExercise(w);
  const list = [...w.exercises].sort((a, b) => a.position - b.position);
  const unitDefault = list[0]?.unit ?? "kg";

  const complete = (e: WExercise, s: WSet) => {
    try {
      let next = completeSet(w, e.id, s.id, new Date().toISOString());
      const a = afterSet(next, e.id);
      next = setCurrent(next, a.goTo);
      save(next); setError(null);
      if (mode === "live" && a.restSeconds > 0) onRest?.(a.restSeconds, e.name);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  const del = (e: WExercise, s: WSet) => {
    if ((historical || s.completed) && !window.confirm(historical ? "This workout is finished. Delete this set from your history? This cannot be undone." : "Delete this completed set?")) return;
    act(() => removeSet(w, e.id, s.id));
  };
  const useLast = (e: WExercise, prev: NonNullable<ReturnType<typeof lastPerformance>>) => act(() => {
    let x = w; const open = e.sets.filter((s) => !s.completed);
    open.forEach((s, i) => { const p = prev.sets[e.sets.indexOf(s)] ?? prev.sets[i]; if (p && s.weight === null && s.reps === null) x = updateSet(x, e.id, s.id, { weight: p.weight, unit: p.unit, reps: p.reps, duration_s: p.duration_s, distance_m: p.distance_m }); });
    return x;
  });

  return (
    <div>
      {error && <div className="notice error" role="alert">{error}</div>}
      {list.length === 0 && <div className="notice">No exercises yet. Add one to start logging.</div>}
      {list.map((e, ei) => {
        const lib = e.key ? resolve(e.key) : null;
        const prev = e.key ? lastPerformance(history, e.key, w.startedAt, w.id) : null;
        const [f1, f2] = fieldsFor(e.measurement, e.loadMode, e.unit);
        const isCur = mode === "live" && cur?.id === e.id;
        const modes = MODES_FOR[e.measurement];
        return (
          <section key={e.id} className={`card exc${isCur ? " current" : ""}`} style={e.superset ? { borderLeft: "3px solid var(--blue)" } : undefined} aria-label={e.name}>
            <div className="exc-head">
              <div>
                <h3>{e.name}{!e.key && <span className="badge off" style={{ marginLeft: 6 }}>imported name</span>}</h3>
                {e.superset && <span className="muted small">Superset {String.fromCharCode(64 + e.superset)}</span>}
              </div>
              <button className="iconbtn" aria-label={`Options for ${e.name}`} aria-expanded={menu === e.id} onClick={() => setMenu(menu === e.id ? null : e.id)}>⋯</button>
            </div>
            <div className="exc-meta">
              <span>{LOAD_MODE_LABEL[e.loadMode]}</span><span>· Rest {e.rest}s</span>{lib && <span>· {lib.primary.join(", ").replace(/_/g, " ")}</span>}
            </div>
            {menu === e.id && (
              <div className="factbox">
                <div className="row" style={{ alignItems: "center" }}>
                  <label className="check" style={{ margin: 0 }}>Rest
                    <select value={e.rest} onChange={(ev) => act(() => setRest(w, e.id, Number(ev.target.value)))} style={{ width: "auto" }}>
                      {[...new Set([0, 30, 45, 60, 75, 90, 120, 150, 180, 240, 300, e.rest])].sort((a, b) => a - b).map((s) => <option key={s} value={s}>{s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`}</option>)}
                    </select></label>
                  <button className="chip" onClick={() => act(() => setExerciseUnit(w, e.id, e.unit === "kg" ? "lb" : "kg"))}>Unit: {e.unit}</button>
                  {modes.length > 1 && <select value={e.loadMode} onChange={(ev) => act(() => setLoadMode(w, e.id, ev.target.value as LoadMode))} style={{ width: "auto" }} aria-label="How the weight is entered">{modes.map((m) => <option key={m} value={m}>{LOAD_MODE_LABEL[m]}</option>)}</select>}
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="chip" disabled={ei === 0} onClick={() => act(() => moveExercise(w, e.id, ei - 1))}>↑ Move up</button>
                  <button className="chip" disabled={ei === list.length - 1} onClick={() => act(() => moveExercise(w, e.id, ei + 1))}>↓ Move down</button>
                  {ei < list.length - 1 && <button className="chip" onClick={() => act(() => e.superset && list[ei + 1].superset === e.superset ? setSuperset(w, [list[ei + 1].id]) : setSuperset(w, [e.id, list[ei + 1].id]))}>{e.superset && list[ei + 1].superset === e.superset ? "Unlink superset" : "Superset with next"}</button>}
                  {e.superset && <button className="chip" onClick={() => act(() => setSuperset(w, [e.id]))}>Remove from superset</button>}
                  <button className="chip" onClick={() => { setPicker({ kind: "replace", exId: e.id }); setMenu(null); }}>Replace</button>
                  <button className="chip" onClick={() => { if (window.confirm(historical || e.sets.some((s) => s.completed) ? `Remove ${e.name} and its logged sets from this workout?` : `Remove ${e.name}?`)) act(() => removeExercise(w, e.id)); }}>Remove</button>
                </div>
                <label style={{ marginTop: 8, marginBottom: 0 }}>Exercise note<textarea rows={2} defaultValue={e.notes ?? ""} maxLength={1000} onBlur={(ev) => { if ((ev.target.value || null) !== e.notes) act(() => setExerciseNote(w, e.id, ev.target.value)); }} /></label>
                {lib && <details style={{ marginTop: 8 }}><summary className="small">How to do it</summary><ol className="small">{lib.instructions.map((t) => <li key={t}>{t}</li>)}</ol><p className="small"><b>Cues:</b> {lib.cues.join(" · ")}</p><p className="small"><b>Common mistakes:</b> {lib.mistakes.join(" · ")}</p></details>}
              </div>
            )}
            {e.notes && menu !== e.id && <p className="muted small" style={{ margin: "0 0 8px" }}>📝 {e.notes}</p>}
            {prev && (
              <p className="prev">Last time ({prev.date}): {prev.sets.map((s) => fmtHSet(s, e.loadMode)).join(" · ")}{" "}
                {e.sets.some((s) => !s.completed && s.weight === null && s.reps === null) && <button className="linkbtn" onClick={() => useLast(e, prev)}>Use these values</button>}
              </p>
            )}
            <div className="setgrid hdr" aria-hidden><span>Set</span><span>{f1.label}</span><span>{f2.label}</span><span>RPE</span><span>Done</span></div>
            {[...e.sets].sort((a, b) => a.position - b.position).map((s, si) => {
              const tgt = fmtTarget(s);
              const patch = (p: SetPatch) => act(() => updateSet(w, e.id, s.id, p));
              const field = (f: Field) => f.key === null ? <span className="muted small" style={{ textAlign: "center" }}>{f.label ? "BW" : ""}</span>
                : <NumField label={`Set ${si + 1} ${f.label}`} value={s[f.key]} integer={f.key === "reps" || f.key === "duration_s"} placeholder={f.key === "weight" && s.target?.weight != null ? String(s.target.weight) : f.key === "reps" && tgt ? tgt.split(" ")[0] : undefined} onCommit={(v) => patch({ [f.key!]: v, ...(f.key === "weight" ? { unit: e.unit } : {}) })} />;
              return (
                <div key={s.id} className={s.completed ? "setrow done" : "setrow"}>
                  <div className="setgrid">
                    <button className={`settype ${s.type}`} aria-label={`Set ${si + 1}, ${SET_TYPE_LABEL[s.type]}. Change set type`} onClick={() => patch({ type: nextType(s.type) })}>{SET_TYPE_SHORT[s.type] || si + 1 - e.sets.slice(0, si).filter((x) => x.type === "warmup").length}</button>
                    {field(f1)}{field(f2)}
                    <select className="rpesel" aria-label={`Set ${si + 1} RPE`} value={s.rpe ?? ""} onChange={(ev) => patch({ rpe: ev.target.value === "" ? null : Number(ev.target.value) })}>
                      <option value="">–</option>{[6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10].map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                    <button className={s.completed ? "donebtn on" : "donebtn"} aria-pressed={s.completed} aria-label={s.completed ? `Set ${si + 1} done. Undo` : `Mark set ${si + 1} done`} onClick={() => (s.completed ? act(() => uncompleteSet(w, e.id, s.id)) : complete(e, s))}>✓</button>
                  </div>
                  <div className="setextra">
                    {s.unit !== e.unit && s.weight !== null && <span>entered in {s.unit}</span>}
                    {tgt && <span>Target: {tgt}</span>}
                    {f1.key === "weight" && !s.completed && <><button className="iconbtn tiny" aria-label="Less weight" onClick={() => patch({ weight: Math.max(0, (s.weight ?? 0) - weightStep(e.unit)), unit: e.unit })}>−{weightStep(e.unit)}</button><button className="iconbtn tiny" aria-label="More weight" onClick={() => patch({ weight: (s.weight ?? 0) + weightStep(e.unit), unit: e.unit })}>+{weightStep(e.unit)}</button></>}
                    <button className="linkbtn" aria-expanded={openSet === s.id} onClick={() => setOpenSet(openSet === s.id ? null : s.id)}>{openSet === s.id ? "Less" : "More"}</button>
                    {rpeRirMismatch(s.rpe, s.rir) && <span style={{ color: "var(--amber)" }}>RPE and RIR disagree (RPE 8 ≈ 2 reps left)</span>}
                  </div>
                  {openSet === s.id && (
                    <div className="setextra">
                      <label className="check" style={{ margin: 0 }}>Type<select value={s.type} onChange={(ev) => patch({ type: ev.target.value as SetType })}>{SET_TYPES.map((t) => <option key={t} value={t}>{SET_TYPE_LABEL[t]}</option>)}</select></label>
                      <label className="check" style={{ margin: 0 }} title="Reps in reserve: how many more reps you could have done">RIR<select value={s.rir ?? ""} onChange={(ev) => patch({ rir: ev.target.value === "" ? null : Number(ev.target.value) })}><option value="">–</option>{[0, 1, 2, 3, 4, 5].map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
                      {e.unilateral && <label className="check" style={{ margin: 0 }}>Side<select value={s.side ?? ""} onChange={(ev) => patch({ side: (ev.target.value || null) as "left" | "right" | null })}><option value="">both/–</option><option value="left">left</option><option value="right">right</option></select></label>}
                      <input aria-label="Set note" placeholder="Note" defaultValue={s.notes ?? ""} maxLength={500} onBlur={(ev) => { if ((ev.target.value || null) !== s.notes) patch({ notes: ev.target.value }); }} style={{ flex: 1, minWidth: 120 }} />
                      <button className="chip" onClick={() => del(e, s)}>Delete set</button>
                    </div>
                  )}
                </div>
              );
            })}
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn ghost tiny" onClick={() => act(() => addSet(w, e.id, newId()))}>＋ Add set</button>
              <button className="btn ghost tiny" onClick={() => act(() => addSet(w, e.id, newId(), { type: "warmup" }))}>＋ Warm-up</button>
              {mode === "live" && !isCur && e.sets.some((s) => !s.completed) && <button className="linkbtn" onClick={() => act(() => setCurrent(w, e.id))}>Make current</button>}
            </div>
          </section>
        );
      })}
      <button className="btn" style={{ width: "100%", minHeight: 52 }} onClick={() => setPicker({ kind: "add" })}>＋ Add exercise</button>
      <details className="small muted" style={{ marginTop: 12 }}>
        <summary>What are RPE and RIR?</summary>
        <p><b>RPE</b> (rate of perceived exertion, 1–10) says how hard a set felt: 10 = nothing left, 9 = one more rep possible, 8 = about two more. <b>RIR</b> (reps in reserve) counts those reps directly: RIR 2 ≈ RPE 8. Both are optional estimates of effort, not measurements.</p>
      </details>
      {picker && (
        <ExercisePicker all={all} title={picker.kind === "add" ? "Add exercise" : "Replace exercise"} replacing={picker.kind === "replace" ? resolve(w.exercises.find((x) => x.id === picker.exId)?.key ?? "") : null}
          onClose={() => setPicker(null)}
          onPick={(ex) => {
            if (picker.kind === "add") act(() => addExercise(w, ex, { id: newId(), unit: unitDefault, setId: newId() }));
            else act(() => replaceExercise(w, picker.exId, ex, { newId: newId(), unit: w.exercises.find((x) => x.id === picker.exId)?.unit ?? unitDefault }));
            setPicker(null);
          }} />
      )}
    </div>
  );
}
