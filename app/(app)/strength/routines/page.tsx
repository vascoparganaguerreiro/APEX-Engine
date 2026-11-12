"use client";
import { useState } from "react";
import Link from "next/link";
import { errText, sdb, useHistory, useLibrary, useRoutines } from "@/lib/strength/hooks";
import { NotSetUp, deleteRoutine, saveRoutine } from "@/lib/strength/data";
import { TEMPLATES, duplicateRoutine, emptyRoutine, fromTemplate, moveRoutineExercise, repRange, set as newSet, validateRoutine, type Routine, type RoutineExercise, type RoutineSet } from "@/lib/strength/routines";
import { fmtHSet, lastPerformance } from "@/lib/strength/analytics";
import { MODES_FOR } from "@/lib/strength/library";
import { newId } from "@/lib/strength/runtime";
import { LOAD_MODE_LABEL, SET_TYPES, SET_TYPE_LABEL, type LoadMode, type SetType } from "@/lib/strength/types";
import ExercisePicker from "@/components/strength/ExercisePicker";
import { SetupNotice, StrengthNav } from "@/components/strength/Bits";
import EmptyState, { LoadProblem } from "@/components/ui/EmptyState";
import { EMPTY } from "@/lib/emptyStates";

const numIn = (v: string, int = false): number | null => { const t = v.replace(",", ".").trim(); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? (int ? Math.round(n) : n) : null; };

export default function RoutinesPage() {
  const lib = useLibrary();
  const hist = useHistory(lib.custom);
  const rts = useRoutines();
  const [edit, setEdit] = useState<Routine | null>(null);
  const [picker, setPicker] = useState<{ kind: "add" } | { kind: "sub"; i: number } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const upd = (f: (r: Routine) => Routine) => setEdit((r) => (r ? f(r) : r));
  const updEx = (i: number, p: Partial<RoutineExercise>) => upd((r) => ({ ...r, exercises: r.exercises.map((e, j) => (j === i ? { ...e, ...p } : e)) }));
  const updSet = (i: number, k: number, p: Partial<RoutineSet>) => upd((r) => ({ ...r, exercises: r.exercises.map((e, j) => (j !== i ? e : { ...e, sets: e.sets.map((s, m) => (m === k ? { ...s, ...p } : s)) })) }));

  async function save() {
    if (!edit) return;
    const err = validateRoutine(edit, lib.custom);
    if (err) { setMsg({ ok: false, text: err }); return; }
    setSaving(true);
    try { await saveRoutine(sdb(), edit); setMsg({ ok: true, text: "Routine saved." }); setEdit(null); await rts.reload(); }
    catch (e) { setMsg({ ok: false, text: e instanceof NotSetUp ? e.message : errText(e) }); }
    finally { setSaving(false); }
  }
  async function remove(r: Routine) {
    if (!window.confirm(`Delete the routine "${r.name}"? Workouts you already logged with it are kept.`)) return;
    try { await deleteRoutine(sdb(), r.id); await rts.reload(); setMsg({ ok: true, text: "Routine deleted." }); } catch (e) { setMsg({ ok: false, text: errText(e) }); }
  }

  return (
    <>
      <div className="eyebrow">Strength Hub</div>
      <h1>Routines</h1>
      <StrengthNav />
      {rts.setUp === false && <SetupNotice what="Saving routines" />}
      {rts.error && <LoadProblem message={rts.error} onRetry={() => void rts.reload()} />}
      {msg && <div className={msg.ok ? "notice ok" : "notice error"}>{msg.text}</div>}
      {!edit ? (
        <>
          <div className="row" style={{ marginBottom: 14 }}>
            <button className="btn" onClick={() => { setMsg(null); setEdit(emptyRoutine(newId())); }}>New routine</button>
            {Object.keys(TEMPLATES).map((k) => <button key={k} className="chip" onClick={() => { setMsg(null); setEdit(fromTemplate(k, newId())); }} title={TEMPLATES[k].description}>From {TEMPLATES[k].name}</button>)}
          </div>
          {rts.routines === null ? <p className="muted">Loading…</p> : rts.routines.length === 0 ? (rts.error || rts.setUp === false ? null : <EmptyState copy={EMPTY.routines} headingLevel={2} onAction={() => { setMsg(null); setEdit(emptyRoutine(newId())); }} />) : rts.routines.map((r) => (
            <div key={r.id} className="card" style={{ marginBottom: 12 }}>
              <div className="act-head"><b style={{ fontSize: 17 }}>{r.name}</b><span className="muted small">{r.exercises.length} exercises · {r.exercises.reduce((n, e) => n + e.sets.length, 0)} sets</span></div>
              <p className="muted small" style={{ marginTop: 0 }}>{r.exercises.map((e) => lib.resolve(e.key)?.name ?? "(missing exercise)").join(" · ")}</p>
              <div className="row">
                <Link className="btn tiny" href={`/strength?routine=${r.id}`} style={{ textDecoration: "none" }}>Start workout</Link>
                <button className="btn ghost tiny" onClick={() => setEdit(JSON.parse(JSON.stringify(r)))}>Edit</button>
                <button className="btn ghost tiny" onClick={() => setEdit(duplicateRoutine(r, newId()))}>Duplicate</button>
                <button className="btn ghost tiny" onClick={() => void remove(r)}>Delete</button>
              </div>
            </div>
          ))}
        </>
      ) : (
        <>
          <div className="card formgrid" style={{ marginBottom: 12 }}>
            <label>Name<input value={edit.name} maxLength={80} onChange={(e) => upd((r) => ({ ...r, name: e.target.value }))} /></label>
            <label style={{ gridColumn: "1 / -1" }}>Notes<textarea rows={2} value={edit.notes ?? ""} maxLength={2000} onChange={(e) => upd((r) => ({ ...r, notes: e.target.value || null }))} /></label>
          </div>
          {edit.exercises.map((e, i) => {
            const ex = lib.resolve(e.key), prev = lastPerformance(hist.sessions ?? [], e.key);
            const mode: LoadMode = e.loadMode ?? ex?.loadMode ?? "total";
            return (
              <div key={i} className="card exc">
                <div className="exc-head"><h3>{i + 1}. {ex?.name ?? "Missing exercise"}</h3>
                  <span className="row"><button className="iconbtn" disabled={i === 0} onClick={() => upd((r) => moveRoutineExercise(r, i, i - 1))} aria-label="Move up">↑</button><button className="iconbtn" disabled={i === edit.exercises.length - 1} onClick={() => upd((r) => moveRoutineExercise(r, i, i + 1))} aria-label="Move down">↓</button><button className="iconbtn" onClick={() => upd((r) => ({ ...r, exercises: r.exercises.filter((_, j) => j !== i) }))} aria-label="Remove">✕</button></span>
                </div>
                {prev ? <p className="prev">Previous performance ({prev.date}): {prev.sets.map((s) => fmtHSet(s, mode)).join(" · ")}. Targets below are yours to set; nothing is copied automatically.</p> : <p className="prev">No previous performance logged.</p>}
                <div className="row" style={{ alignItems: "center", marginBottom: 8 }}>
                  <label className="check" style={{ margin: 0 }}>Rest (s)<input style={{ width: 80 }} inputMode="numeric" value={e.rest ?? ""} placeholder={String(ex?.rest ?? 90)} onChange={(v) => updEx(i, { rest: numIn(v.target.value, true) })} /></label>
                  <label className="check" style={{ margin: 0 }}>Unit<select value={e.unit} onChange={(v) => updEx(i, { unit: v.target.value as "kg" | "lb" })} style={{ width: "auto" }}><option>kg</option><option>lb</option></select></label>
                  {ex && MODES_FOR[ex.measurement].length > 1 && <select value={mode} onChange={(v) => updEx(i, { loadMode: v.target.value as LoadMode })} style={{ width: "auto" }} aria-label="Weight entry">{MODES_FOR[ex.measurement].map((m) => <option key={m} value={m}>{LOAD_MODE_LABEL[m]}</option>)}</select>}
                  <label className="check" style={{ margin: 0 }}>Superset<select value={e.superset ?? ""} onChange={(v) => updEx(i, { superset: v.target.value ? Number(v.target.value) : null })} style={{ width: "auto" }}><option value="">none</option>{[1, 2, 3, 4, 5].map((g) => <option key={g} value={g}>{String.fromCharCode(64 + g)}</option>)}</select></label>
                </div>
                <div className="tablewrap" style={{ padding: 0 }}>
                  <table className="tbl"><thead><tr><th>Type</th><th>Reps min</th><th>Reps max</th><th>Weight ({e.unit}{mode === "per_hand" ? ", per hand" : ""})</th><th>RPE</th><th>RIR</th><th></th></tr></thead>
                    <tbody>{e.sets.map((s, k) => (
                      <tr key={k}>
                        <td><select value={s.type} onChange={(v) => updSet(i, k, { type: v.target.value as SetType })}>{SET_TYPES.map((t) => <option key={t} value={t}>{SET_TYPE_LABEL[t]}</option>)}</select></td>
                        <td><input inputMode="numeric" value={s.repsMin ?? ""} onChange={(v) => updSet(i, k, { repsMin: numIn(v.target.value, true) })} /></td>
                        <td><input inputMode="numeric" value={s.repsMax ?? ""} onChange={(v) => updSet(i, k, { repsMax: numIn(v.target.value, true) })} /></td>
                        <td><input inputMode="decimal" value={s.weight ?? ""} placeholder="optional" onChange={(v) => updSet(i, k, { weight: numIn(v.target.value) })} /></td>
                        <td><input inputMode="decimal" value={s.rpe ?? ""} onChange={(v) => updSet(i, k, { rpe: numIn(v.target.value) })} /></td>
                        <td><input inputMode="numeric" value={s.rir ?? ""} onChange={(v) => updSet(i, k, { rir: numIn(v.target.value, true) })} /></td>
                        <td><button className="iconbtn" onClick={() => updEx(i, { sets: e.sets.filter((_, m) => m !== k) })} aria-label="Remove set">✕</button></td>
                      </tr>))}</tbody></table>
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn ghost tiny" onClick={() => updEx(i, { sets: [...e.sets, e.sets.length ? { ...e.sets[e.sets.length - 1] } : newSet(8, 12)] })}>＋ Set</button>
                  <button className="btn ghost tiny" onClick={() => setPicker({ kind: "sub", i })}>＋ Substitute option</button>
                  {e.substitutes.map((k) => <span key={k} className="chip">{lib.resolve(k)?.name ?? k} <button className="linkbtn" onClick={() => updEx(i, { substitutes: e.substitutes.filter((x) => x !== k) })} aria-label="Remove substitute">✕</button></span>)}
                </div>
                <label style={{ marginTop: 8, marginBottom: 0 }}>Exercise note<input value={e.notes ?? ""} maxLength={500} onChange={(v) => updEx(i, { notes: v.target.value || null })} /></label>
                <p className="muted small" style={{ marginBottom: 0 }}>{e.sets.map((s) => repRange(s)).filter(Boolean).join(", ")}</p>
              </div>
            );
          })}
          <button className="btn ghost" style={{ width: "100%", marginBottom: 12 }} onClick={() => setPicker({ kind: "add" })}>＋ Add exercise</button>
          <div className="row savebar"><button className="btn" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save routine"}</button><button className="btn ghost" onClick={() => { setEdit(null); setMsg(null); }}>Cancel</button></div>
        </>
      )}
      {picker && edit && (
        <ExercisePicker all={lib.all} title={picker.kind === "add" ? "Add exercise" : "Add a substitute option"} replacing={picker.kind === "sub" ? lib.resolve(edit.exercises[picker.i].key) : null} onClose={() => setPicker(null)}
          onPick={(ex) => {
            if (picker.kind === "add") upd((r) => ({ ...r, exercises: [...r.exercises, { key: ex.key, superset: null, rest: null, loadMode: null, unit: "kg", notes: null, substitutes: [], sets: [newSet(8, 12), newSet(8, 12), newSet(8, 12)] }] }));
            else if (!edit.exercises[picker.i].substitutes.includes(ex.key) && edit.exercises[picker.i].substitutes.length < 6) updEx(picker.i, { substitutes: [...edit.exercises[picker.i].substitutes, ex.key] });
            setPicker(null);
          }} />
      )}
    </>
  );
}
