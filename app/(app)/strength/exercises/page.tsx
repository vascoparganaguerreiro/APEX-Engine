"use client";
import { useMemo, useState } from "react";
import { errText, sdb, useHistory, useLibrary } from "@/lib/strength/hooks";
import { archiveCustom, createCustom } from "@/lib/strength/data";
import { EMPTY_CUSTOM, MODES_FOR, searchExercises, validateCustom, type CustomDraft } from "@/lib/strength/library";
import { E1RM_FORMULA, exerciseHistory } from "@/lib/strength/analytics";
import {
  CATEGORIES, CATEGORY_LABEL, EQUIPMENT, EQUIPMENT_LABEL, LOAD_MODE_LABEL, MEASUREMENTS, MEASUREMENT_LABEL, MUSCLES, MUSCLE_LABEL, PATTERNS, PATTERN_LABEL,
  customIdOf, type Equipment, type Exercise, type ExerciseCategory, type LoadMode, type Measurement, type Muscle, type Pattern,
} from "@/lib/strength/types";
import { SetupNotice, StrengthNav } from "@/components/strength/Bits";

export default function ExercisesPage() {
  const lib = useLibrary();
  const hist = useHistory(lib.custom);
  const [q, setQ] = useState("");
  const [f, setF] = useState<{ muscle: Muscle | ""; equipment: Equipment | ""; pattern: Pattern | ""; category: ExerciseCategory | ""; secondary: boolean }>({ muscle: "", equipment: "", pattern: "", category: "", secondary: false });
  const [sel, setSel] = useState<Exercise | null>(null);
  const [draft, setDraft] = useState<CustomDraft | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const list = useMemo(() => searchExercises(lib.all, { query: q, muscle: f.muscle, equipment: f.equipment, pattern: f.pattern, category: f.category, includeSecondary: f.secondary }), [lib.all, q, f]);
  const selHist = useMemo(() => (sel ? exerciseHistory(hist.sessions ?? [], { key: sel.key }).slice(-6).reverse() : []), [sel, hist.sessions]);

  async function create() {
    if (!draft) return;
    const v = validateCustom(draft, lib.all);
    if (!v.ok) { setMsg({ ok: false, text: v.error }); return; }
    try { const ex = await createCustom(sdb(), v.row); await lib.reload(); setDraft(null); setSel(ex); setMsg({ ok: true, text: `${ex.name} added to your library.` }); }
    catch (e) { setMsg({ ok: false, text: errText(e) }); }
  }
  async function archive(e: Exercise) {
    const id = customIdOf(e.key); if (!id) return;
    if (!window.confirm(`Remove ${e.name} from your library? Workouts that used it keep it in their history.`)) return;
    try { await archiveCustom(sdb(), id); await lib.reload(); setSel(null); } catch (x) { setMsg({ ok: false, text: errText(x) }); }
  }
  const toggleMuscle = (k: "primary" | "secondary", m: Muscle) => draft && setDraft({ ...draft, [k]: draft[k].includes(m) ? draft[k].filter((x) => x !== m) : [...draft[k], m] });

  return (
    <>
      <div className="eyebrow">Strength Hub</div>
      <h1>Exercise library</h1>
      <StrengthNav />
      {lib.setUp === false && <SetupNotice what="Custom exercises" />}
      {msg && <div className={msg.ok ? "notice ok" : "notice error"}>{msg.text}</div>}
      <p className="muted small">{lib.all.length} exercises ({lib.custom.length} custom). All descriptions are original APEX content.</p>
      <input placeholder="Search by name or nickname (e.g. rdl, ohp, db row)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search exercises" />
      <div className="row" style={{ margin: "8px 0 14px" }}>
        <select value={f.muscle} onChange={(e) => setF({ ...f, muscle: e.target.value as Muscle | "" })} aria-label="Primary muscle" style={{ flex: 1 }}><option value="">Any muscle</option>{MUSCLES.map((m) => <option key={m} value={m}>{MUSCLE_LABEL[m]}</option>)}</select>
        <select value={f.equipment} onChange={(e) => setF({ ...f, equipment: e.target.value as Equipment | "" })} aria-label="Equipment" style={{ flex: 1 }}><option value="">Any equipment</option>{EQUIPMENT.map((m) => <option key={m} value={m}>{EQUIPMENT_LABEL[m]}</option>)}</select>
        <select value={f.pattern} onChange={(e) => setF({ ...f, pattern: e.target.value as Pattern | "" })} aria-label="Movement pattern" style={{ flex: 1 }}><option value="">Any pattern</option>{PATTERNS.map((m) => <option key={m} value={m}>{PATTERN_LABEL[m]}</option>)}</select>
        <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as ExerciseCategory | "" })} aria-label="Category" style={{ flex: 1 }}><option value="">Any category</option>{CATEGORIES.map((m) => <option key={m} value={m}>{CATEGORY_LABEL[m]}</option>)}</select>
        {f.muscle && <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={f.secondary} onChange={(e) => setF({ ...f, secondary: e.target.checked })} /> include secondary</label>}
        <button className="btn ghost tiny" onClick={() => { setDraft({ ...EMPTY_CUSTOM }); setMsg(null); }}>＋ Custom exercise</button>
      </div>

      {draft && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2 style={{ marginTop: 0 }}>New custom exercise</h2>
          <div className="formgrid">
            <label>Name<input value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
            <label>Other names (comma separated)<input value={draft.aliases} onChange={(e) => setDraft({ ...draft, aliases: e.target.value })} /></label>
            <label>Equipment<select value={draft.equipment} onChange={(e) => setDraft({ ...draft, equipment: e.target.value })}>{EQUIPMENT.map((m) => <option key={m} value={m}>{EQUIPMENT_LABEL[m]}</option>)}</select></label>
            <label>Movement pattern<select value={draft.pattern} onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}>{PATTERNS.map((m) => <option key={m} value={m}>{PATTERN_LABEL[m]}</option>)}</select></label>
            <label>Category<select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>{CATEGORIES.map((m) => <option key={m} value={m}>{CATEGORY_LABEL[m]}</option>)}</select></label>
            <label>Each set records<select value={draft.measurement} onChange={(e) => { const m = e.target.value as Measurement; setDraft({ ...draft, measurement: m, loadMode: MODES_FOR[m][0] }); }}>{MEASUREMENTS.map((m) => <option key={m} value={m}>{MEASUREMENT_LABEL[m]}</option>)}</select></label>
            <label>Weight is entered as<select value={draft.loadMode} onChange={(e) => setDraft({ ...draft, loadMode: e.target.value })}>{MODES_FOR[draft.measurement as Measurement].map((m: LoadMode) => <option key={m} value={m}>{LOAD_MODE_LABEL[m]}</option>)}</select></label>
            <label className="check"><input type="checkbox" checked={draft.unilateral} onChange={(e) => setDraft({ ...draft, unilateral: e.target.checked })} /> One side at a time</label>
          </div>
          <p className="small" style={{ marginBottom: 4 }}>Primary muscles (1–4)</p>
          <div className="row">{MUSCLES.map((m) => <button key={m} className={draft.primary.includes(m) ? "chip on" : "chip"} aria-pressed={draft.primary.includes(m)} onClick={() => toggleMuscle("primary", m)}>{MUSCLE_LABEL[m]}</button>)}</div>
          <p className="small" style={{ marginBottom: 4 }}>Secondary muscles</p>
          <div className="row">{MUSCLES.filter((m) => !draft.primary.includes(m)).map((m) => <button key={m} className={draft.secondary.includes(m) ? "chip on" : "chip"} aria-pressed={draft.secondary.includes(m)} onClick={() => toggleMuscle("secondary", m)}>{MUSCLE_LABEL[m]}</button>)}</div>
          <label style={{ marginTop: 10 }}>How to do it (one step per line)<textarea rows={3} value={draft.instructions} maxLength={2000} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} /></label>
          <label>Notes<input value={draft.notes} maxLength={500} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></label>
          <div className="row"><button className="btn" onClick={() => void create()}>Save exercise</button><button className="btn ghost" onClick={() => setDraft(null)}>Cancel</button></div>
        </div>
      )}

      {sel && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="exc-head"><h2 style={{ margin: 0 }}>{sel.name}</h2><button className="iconbtn" onClick={() => setSel(null)} aria-label="Close">✕</button></div>
          <p className="muted small">{sel.aliases.length ? `Also called: ${sel.aliases.join(", ")}. ` : ""}{EQUIPMENT_LABEL[sel.equipment]} · {PATTERN_LABEL[sel.pattern]} · {CATEGORY_LABEL[sel.category]} · {sel.difficulty} · {MEASUREMENT_LABEL[sel.measurement]} · {LOAD_MODE_LABEL[sel.loadMode]}{sel.unilateral ? " · one side at a time" : ""}</p>
          <p className="small"><b>Primary:</b> {sel.primary.map((m) => MUSCLE_LABEL[m]).join(", ")}{sel.secondary.length ? <> · <b>Secondary:</b> {sel.secondary.map((m) => MUSCLE_LABEL[m]).join(", ")}</> : null}</p>
          {sel.instructions.length > 0 && <><b className="small">How to</b><ol className="small">{sel.instructions.map((t) => <li key={t}>{t}</li>)}</ol></>}
          {sel.cues.length > 0 && <p className="small"><b>Cues:</b> {sel.cues.join(" · ")}</p>}
          {sel.mistakes.length > 0 && <p className="small"><b>Common mistakes:</b> {sel.mistakes.join(" · ")}</p>}
          <p className="muted small">Default rest {sel.rest} s. No demonstration media is bundled yet (only original or properly licensed images will be added).</p>
          <h3 style={{ fontSize: 15 }}>Your history</h3>
          {selHist.length === 0 ? <p className="muted small">Not logged yet.</p> : (
            <table className="tbl"><thead><tr><th>Date</th><th>Best set</th><th>Working sets</th><th>Est. 1RM</th></tr></thead>
              <tbody>{selHist.map((h) => <tr key={h.sessionId}><td>{h.date}</td><td>{h.best ? `${h.best.weight} ${h.best.unit} × ${h.best.reps}` : "–"}</td><td>{h.workingSets}</td><td>{h.e1rmKg ? `${Math.round(h.e1rmKg * 10) / 10} kg` : "–"}</td></tr>)}</tbody></table>
          )}
          {selHist.length > 0 && <p className="muted small">{E1RM_FORMULA}</p>}
          {sel.custom && <button className="btn ghost tiny" onClick={() => void archive(sel)}>Remove from my library</button>}
        </div>
      )}

      <div className="pick" style={{ maxHeight: "none" }}>
        {list.map((e) => (
          <button key={e.key} className="pickrow" onClick={() => { setSel(e); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
            <span><b>{e.name}</b>{e.custom && <span className="badge" style={{ marginLeft: 6 }}>custom</span>}<br /><span className="muted small">{e.primary.map((m) => MUSCLE_LABEL[m]).join(", ")} · {EQUIPMENT_LABEL[e.equipment]} · {PATTERN_LABEL[e.pattern]}</span></span>
            <span className="muted small">{e.difficulty}</span>
          </button>
        ))}
        {list.length === 0 && <div className="notice">No exercise matches these filters.</div>}
      </div>
    </>
  );
}
