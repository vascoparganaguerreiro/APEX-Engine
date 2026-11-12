"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { searchExercises, substitutesFor } from "@/lib/strength/library";
import { EQUIPMENT, EQUIPMENT_LABEL, MUSCLES, MUSCLE_LABEL, PATTERNS, PATTERN_LABEL, type Equipment, type Exercise, type Muscle, type Pattern } from "@/lib/strength/types";

/** Bottom sheet to choose an exercise: instant search, filters, and (when replacing) honest substitutes first. */
export default function ExercisePicker({ all, onPick, onClose, replacing, title = "Add exercise" }: {
  all: readonly Exercise[]; onPick: (e: Exercise) => void; onClose: () => void; replacing?: Exercise | null; title?: string;
}) {
  const [q, setQ] = useState("");
  const [muscle, setMuscle] = useState<Muscle | "">("");
  const [eq, setEq] = useState<Equipment | "">("");
  const [pattern, setPattern] = useState<Pattern | "">("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const list = useMemo(() => searchExercises(all, { query: q, muscle, equipment: eq, pattern }).slice(0, 80), [all, q, muscle, eq, pattern]);
  const subs = useMemo(() => (replacing && !q && !muscle && !eq && !pattern ? substitutesFor(replacing, all, undefined, 8) : []), [replacing, all, q, muscle, eq, pattern]);
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}><h3>{title}</h3><button className="iconbtn" onClick={onClose} aria-label="Close">✕</button></div>
        <input ref={input} placeholder="Search exercises (e.g. db bench, rdl, lat pulldown)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search exercises" />
        <div className="row" style={{ margin: "8px 0" }}>
          <select value={muscle} onChange={(e) => setMuscle(e.target.value as Muscle | "")} aria-label="Muscle" style={{ flex: 1 }}><option value="">Any muscle</option>{MUSCLES.map((m) => <option key={m} value={m}>{MUSCLE_LABEL[m]}</option>)}</select>
          <select value={eq} onChange={(e) => setEq(e.target.value as Equipment | "")} aria-label="Equipment" style={{ flex: 1 }}><option value="">Any equipment</option>{EQUIPMENT.map((m) => <option key={m} value={m}>{EQUIPMENT_LABEL[m]}</option>)}</select>
          <select value={pattern} onChange={(e) => setPattern(e.target.value as Pattern | "")} aria-label="Movement pattern" style={{ flex: 1 }}><option value="">Any pattern</option>{PATTERNS.map((m) => <option key={m} value={m}>{PATTERN_LABEL[m]}</option>)}</select>
        </div>
        {subs.length > 0 && (
          <>
            <p className="muted small" style={{ margin: "6px 0" }}>Substitutes for {replacing!.name}. None is identical; the difference is stated.</p>
            <div className="pick" style={{ maxHeight: "none", marginBottom: 10 }}>
              {subs.map((s) => <button key={s.exercise.key} className="pickrow" onClick={() => onPick(s.exercise)}><span><b>{s.exercise.name}</b><br /><span className="muted small">{s.note}</span></span></button>)}
            </div>
          </>
        )}
        <div className="pick">
          {list.length === 0 && <p className="muted small">No exercise matches. You can create a custom exercise on the Exercises tab.</p>}
          {list.map((e) => (
            <button key={e.key} className="pickrow" onClick={() => onPick(e)}>
              <span><b>{e.name}</b>{e.custom && <span className="badge" style={{ marginLeft: 6 }}>custom</span>}<br /><span className="muted small">{e.primary.map((m) => MUSCLE_LABEL[m]).join(", ")} · {EQUIPMENT_LABEL[e.equipment]}</span></span>
              <span aria-hidden>＋</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
