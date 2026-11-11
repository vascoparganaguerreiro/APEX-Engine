"use client";
import { useEffect, useRef, useState } from "react";
import {
  DOSE_UNITS, FORMULATIONS, SLOTS, SLOT_LABEL, WEEKDAYS, emptySlots, slotRows, slotsFrom, validateSchedule, validateSupplement,
  type Slot, type SlotDraft, type SlotDrafts, type Supplement,
} from "@/lib/health/core";

export interface SupplementDraft {
  name: string; brand: string; ingredients: string; formulation: string; dose: string; dose_unit: string; notes: string; start_date: string;
}
export { emptySlots, slotsFrom, slotRows };
export type { SlotDraft, SlotDrafts };

/** Add or edit a supplement and its daily schedule. Doses live in the schedule (versioned), not on the supplement itself. */
export default function SupplementForm({ initial, initialSlots, today, onSave, onCancel }: {
  initial?: Supplement; initialSlots?: SlotDrafts; today: string;
  onSave: (s: Partial<Supplement>, slots: SlotDrafts) => Promise<void>; onCancel: () => void;
}) {
  const [d, setD] = useState<SupplementDraft>({
    name: initial?.name ?? "", brand: initial?.brand ?? "", ingredients: initial?.ingredients ?? "", formulation: initial?.formulation ?? "capsule",
    dose: initial?.dose != null ? String(initial.dose) : "", dose_unit: initial?.dose_unit ?? "mg", notes: initial?.notes ?? "", start_date: initial?.start_date ?? today,
  });
  const [slots, setSlots] = useState<SlotDrafts>(initialSlots ?? emptySlots());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The form can open far from the button that triggered it: bring it into view so opening is never silent.
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => { formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }, []);
  const field = (k: keyof SupplementDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setD({ ...d, [k]: e.target.value });
  const setSlot = (s: Slot, p: Partial<SlotDraft>) => setSlots({ ...slots, [s]: { ...slots[s], ...p } });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const sup: Partial<Supplement> = {
      name: d.name.trim(), brand: d.brand.trim() || null, ingredients: d.ingredients.trim() || null, formulation: d.formulation || null,
      dose: d.dose.trim() ? Number(d.dose.replace(",", ".")) : null, dose_unit: d.dose.trim() ? d.dose_unit : null,
      notes: d.notes.trim() || null, start_date: d.start_date, end_date: initial?.end_date ?? null, status: initial?.status ?? "active",
    };
    const v = validateSupplement(sup) ?? validateSchedule(slotRows(slots));
    if (v) { setErr(v); return; }
    setErr(null); setBusy(true);
    try { await onSave(sup, slots); } catch (x) { setErr(x instanceof Error ? x.message : String(x)); } finally { setBusy(false); }
  }

  return (
    <form ref={formRef} className="card" onSubmit={submit}>
      <h2 style={{ marginTop: 0 }}>{initial ? "Edit supplement" : "Add a supplement"}</h2>
      <div className="formgrid">
        <label>Name<input value={d.name} onChange={field("name")} maxLength={120} required placeholder="e.g. Magnesium glycinate" /></label>
        <label>Brand<input value={d.brand} onChange={field("brand")} maxLength={120} /></label>
        <label>Active ingredient(s)<input value={d.ingredients} onChange={field("ingredients")} maxLength={500} placeholder="e.g. magnesium bisglycinate" /></label>
        <label>Formulation
          <select value={d.formulation} onChange={field("formulation")}>{FORMULATIONS.map((f) => <option key={f} value={f}>{f}</option>)}</select>
        </label>
        <label>Label dose per unit (optional)<input inputMode="decimal" value={d.dose} onChange={field("dose")} placeholder="e.g. 200" /></label>
        <label>Unit<select value={d.dose_unit} onChange={field("dose_unit")}>{DOSE_UNITS.map((u) => <option key={u}>{u}</option>)}</select></label>
        <label>Start date<input type="date" value={d.start_date} onChange={field("start_date")} required /></label>
      </div>
      <label>Notes<textarea rows={2} maxLength={2000} value={d.notes} onChange={field("notes")} /></label>

      <h3 style={{ margin: "18px 0 8px" }}>Daily schedule</h3>
      <p className="muted small">Set a dose for each time of day you take it, and on which days. Changing the schedule later keeps the old one in your history.</p>
      {SLOTS.map((s) => (
        <div key={s} className={slots[s].on ? "slotrow on" : "slotrow"}>
          <label className="check"><input type="checkbox" checked={slots[s].on} onChange={(e) => setSlot(s, { on: e.target.checked })} /> {SLOT_LABEL[s]}</label>
          {slots[s].on && (
            <>
              <input aria-label={`${SLOT_LABEL[s]} dose`} inputMode="decimal" placeholder="dose" value={slots[s].dose} onChange={(e) => setSlot(s, { dose: e.target.value })} style={{ width: 90 }} />
              <select aria-label={`${SLOT_LABEL[s]} unit`} value={slots[s].unit} onChange={(e) => setSlot(s, { unit: e.target.value })} style={{ width: 90 }}>
                {DOSE_UNITS.map((u) => <option key={u}>{u}</option>)}
              </select>
              <span className="row" role="group" aria-label={`${SLOT_LABEL[s]} days`}>
                {WEEKDAYS.map((w, i) => (
                  <button key={w} type="button" className={slots[s].days[i] ? "chip on" : "chip"} aria-pressed={slots[s].days[i]}
                    onClick={() => setSlot(s, { days: slots[s].days.map((v, j) => (j === i ? !v : v)) })}>{w}</button>
                ))}
              </span>
            </>
          )}
        </div>
      ))}
      {err && <div className="notice error">{err}</div>}
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn" disabled={busy} type="submit">{busy ? "Saving…" : initial ? "Save changes" : "Add supplement"}</button>
        <button className="btn ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
