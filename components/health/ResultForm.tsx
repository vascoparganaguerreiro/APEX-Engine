"use client";
import { useState } from "react";
import { validateResult, type ResultInput } from "@/lib/health/core";

export interface ResultDraft extends ResultInput { flag: string | null }
const blank = { name: "", value: "", unit: "", low: "", high: "", flag: "" };
const num = (s: string): number | null => { const t = s.trim().replace(",", "."); return t === "" ? null : Number(t); };

/** One biomarker result as typed by the user. Units and ranges are the laboratory's own; nothing is converted or filled in. */
export default function ResultForm({ initial, submitLabel, onSubmit, onCancel }: {
  initial?: ResultDraft; submitLabel: string; onSubmit: (r: ResultDraft) => Promise<void> | void; onCancel?: () => void;
}) {
  const [f, setF] = useState(initial ? {
    name: initial.original_name, value: String(initial.value), unit: initial.unit,
    low: initial.ref_low === null ? "" : String(initial.ref_low), high: initial.ref_high === null ? "" : String(initial.ref_high), flag: initial.flag ?? "",
  } : blank);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const draft: ResultDraft = { original_name: f.name.trim(), value: num(f.value) ?? NaN, unit: f.unit.trim(), ref_low: num(f.low), ref_high: num(f.high), flag: f.flag.trim() || null };
    const v = validateResult(draft);
    if (v) { setErr(v); return; }
    setErr(null); setBusy(true);
    try { await onSubmit(draft); if (!initial) setF(blank); } catch (x) { setErr(x instanceof Error ? x.message : String(x)); } finally { setBusy(false); }
  }

  return (
    <form className="resultform" onSubmit={submit}>
      <label>Marker (as printed)<input value={f.name} onChange={set("name")} maxLength={160} placeholder="e.g. Ferritin" required /></label>
      <label>Result<input inputMode="decimal" value={f.value} onChange={set("value")} placeholder="42.5" required /></label>
      <label>Unit<input value={f.unit} onChange={set("unit")} maxLength={30} placeholder="ng/mL" required /></label>
      <label>Ref. low<input inputMode="decimal" value={f.low} onChange={set("low")} placeholder="optional" /></label>
      <label>Ref. high<input inputMode="decimal" value={f.high} onChange={set("high")} placeholder="optional" /></label>
      <label>Lab flag<input value={f.flag} onChange={set("flag")} maxLength={40} placeholder="H / L / optional" /></label>
      <div className="row">
        <button className="btn" disabled={busy} type="submit">{busy ? "Saving…" : submitLabel}</button>
        {onCancel && <button className="btn ghost" type="button" onClick={onCancel}>Cancel</button>}
      </div>
      {err && <div className="notice error" style={{ gridColumn: "1 / -1" }}>{err}</div>}
    </form>
  );
}
