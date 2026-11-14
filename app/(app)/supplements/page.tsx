"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import { errMsg } from "@/lib/errors";
import { todayIso } from "@/lib/dates";
import {
  SLOT_LABEL, WEEKDAYS, addDay, adherence, dueOn, isIsoDate, type Intake, type Schedule, type Supplement,
} from "@/lib/health/core";
import SupplementForm, { slotRows, slotsFrom, type SlotDrafts } from "@/components/health/SupplementForm";

interface Revision { id: string; changed_at: string; snapshot: Partial<Supplement> }

export default function SupplementsPage() {
  const { session } = useAuth();
  const today = todayIso();
  const [sups, setSups] = useState<Supplement[] | null>(null);
  const [sched, setSched] = useState<Schedule[]>([]);
  const [intakes, setIntakes] = useState<Intake[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [day, setDay] = useState(today);
  const [editing, setEditing] = useState<Supplement | "new" | null>(null);
  const [stopping, setStopping] = useState<Supplement | null>(null);
  const [stopForm, setStopForm] = useState({ end: today, reason: "" });
  const [revs, setRevs] = useState<Record<string, Revision[] | undefined>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const sb = getSupabase();
      const [s, c, i] = await Promise.all([
        sb.from("supplements").select("*").order("start_date", { ascending: false }),
        sb.from("supplement_schedules").select("*"),
        sb.from("supplement_intakes").select("supplement_id,slot,day,status").gte("day", addDay(todayIso(), -60)),
      ]);
      for (const r of [s, c, i]) if (r.error) throw r.error;
      setSups((s.data ?? []) as Supplement[]); setSched((c.data ?? []) as Schedule[]); setIntakes((i.data ?? []) as Intake[]); setError(null);
    } catch (e) { setError(errMsg(e)); }
  }, []);
  useEffect(() => { if (session) load(); }, [session, load]);

  const active = useMemo(() => (sups ?? []).filter((s) => s.status === "active"), [sups]);
  const past = useMemo(() => (sups ?? []).filter((s) => s.status === "discontinued"), [sups]);
  const due = useMemo(() => dueOn(day, sups ?? [], sched), [day, sups, sched]);
  const byId = useMemo(() => new Map((sups ?? []).map((s) => [s.id, s])), [sups]);
  const currentSchedule = (id: string) => sched.filter((c) => c.supplement_id === id && c.valid_to === null);

  async function save(base: Partial<Supplement>, slots: SlotDrafts, existing: Supplement | null) {
    const sb = getSupabase();
    const rows = slotRows(slots);
    if (!isIsoDate(today)) throw new Error("Could not determine today's date on this device.");   // checked before anything is written
    let id = existing?.id;
    if (existing) {
      const { error: e } = await sb.from("supplements").update(base).eq("id", existing.id);
      if (e) throw e;
    } else {
      const { data, error: e } = await sb.from("supplements").insert(base).select("id").single();
      if (e) throw e;
      id = data.id as string;
    }
    const before = JSON.stringify(existing ? slotRows(slotsFrom(currentSchedule(existing.id))) : []);
    if (JSON.stringify(rows) !== before) {
      // The user's own calendar date decides when the new schedule starts (the server only sanity-checks it).
      const { error: e } = await sb.rpc("replace_supplement_schedule", { p_supplement: id, p_rows: rows, p_effective: today });
      if (e) {
        if (!existing) await sb.from("supplements").delete().eq("id", id!);     // nothing depends on it yet: no half-saved supplement
        throw e;
      }
    }
    setEditing(null); await load();
  }

  async function discontinue(e: React.FormEvent) {
    e.preventDefault();
    if (!stopping) return;
    if (stopForm.end < stopping.start_date) { setError("End date cannot be before the start date."); return; }
    const { error: err } = await getSupabase().from("supplements")
      .update({ status: "discontinued", end_date: stopForm.end, discontinuation_reason: stopForm.reason.trim() || null }).eq("id", stopping.id);
    if (err) { setError(errMsg(err)); return; }
    setStopping(null); setError(null); await load();
  }

  async function mark(supId: string, slot: string, dose: number, unit: string, status: "taken" | "skipped" | null) {
    const k = `${supId}|${slot}`; setBusyKey(k);
    const sb = getSupabase();
    const { error: err } = status
      ? await sb.from("supplement_intakes").upsert({ user_id: session!.user.id, supplement_id: supId, slot, day, status, dose, dose_unit: unit }, { onConflict: "user_id,supplement_id,slot,day" })
      : await sb.from("supplement_intakes").delete().eq("supplement_id", supId).eq("slot", slot).eq("day", day);
    setBusyKey(null);
    if (err) { setError(errMsg(err)); return; }
    setIntakes((prev) => [...prev.filter((i) => !(i.supplement_id === supId && i.slot === slot && i.day === day)), ...(status ? [{ supplement_id: supId, slot: slot as Intake["slot"], day, status }] : [])]);
  }

  async function showRevisions(id: string) {
    if (revs[id]) { setRevs({ ...revs, [id]: undefined }); return; }
    const { data, error: err } = await getSupabase().from("supplement_revisions").select("id,changed_at,snapshot").eq("supplement_id", id).order("changed_at", { ascending: false });
    if (err) { setError(errMsg(err)); return; }
    setRevs({ ...revs, [id]: (data ?? []) as Revision[] });
  }

  const from30 = addDay(today, -29);
  const scheduleText = (id: string) => currentSchedule(id).map((c) =>
    `${SLOT_LABEL[c.slot]} ${c.dose} ${c.dose_unit}${c.days.length < 7 ? ` (${c.days.map((d) => WEEKDAYS[d - 1]).join(", ")})` : ""}`).join(" · ");

  function card(s: Supplement) {
    // Edit opens the form right where the card is (it used to open at the top of the page, off-screen from the button).
    if (editing !== null && editing !== "new" && editing.id === s.id) {
      return <SupplementForm key={`edit-${s.id}`} initial={s} today={today} initialSlots={slotsFrom(currentSchedule(s.id))}
        onSave={(b, sl) => save(b, sl, s)} onCancel={() => setEditing(null)} />;
    }
    const a = s.status === "active" ? adherence(s.id, sups ?? [], sched, intakes, from30 < s.start_date ? s.start_date : from30, today) : null;
    return (
      <article key={s.id} className={`card supcard ${s.status}`}>
        <div className="act-head">
          <span className={s.status === "active" ? "badge" : "badge off"}>{s.status === "active" ? "Active" : "Discontinued"}</span>
          <b>{s.name}</b>{s.brand && <span className="muted small">{s.brand}</span>}
        </div>
        <p className="muted small" style={{ margin: "0 0 6px" }}>
          {[s.formulation, s.ingredients].filter(Boolean).join(" · ")}{s.dose != null ? ` · label ${s.dose} ${s.dose_unit}` : ""}
        </p>
        <p className="small" style={{ margin: "0 0 6px" }}>
          {s.status === "active" ? (scheduleText(s.id) || <span className="muted">No schedule set</span>) : <span className="muted">Last schedule kept in history</span>}
        </p>
        <p className="muted small" style={{ margin: "0 0 8px" }}>
          Started {s.start_date}{s.end_date ? ` · stopped ${s.end_date}` : ""}{s.discontinuation_reason ? ` · reason: ${s.discontinuation_reason}` : ""}
        </p>
        {s.notes && <p className="small" style={{ margin: "0 0 8px" }}>{s.notes}</p>}
        {a && a.expected > 0 && <p className="small" style={{ margin: "0 0 8px" }}>Last 30 days: <b>{a.rate !== null ? `${Math.round(a.rate * 100)}%` : "–"}</b> taken ({a.taken}/{a.expected}{a.skipped ? `, ${a.skipped} skipped` : ""}{a.missed ? `, ${a.missed} not logged` : ""})</p>}
        <div className="row">
          {s.status === "active" && <button className="btn ghost" onClick={() => setEditing(s)}>Edit</button>}
          {s.status === "active" && <button className="btn ghost" onClick={() => { setStopping(s); setStopForm({ end: today, reason: "" }); }}>Discontinue</button>}
          <button className="btn ghost" onClick={() => showRevisions(s.id)}>{revs[s.id] ? "Hide history" : "Edit history"}</button>
        </div>
        {revs[s.id] && (
          <ul className="small muted" style={{ margin: "10px 0 0", paddingLeft: 18 }}>
            {revs[s.id]!.length === 0 && <li>No earlier versions: this supplement was never edited.</li>}
            {revs[s.id]!.map((r) => (
              <li key={r.id}>Before {new Date(r.changed_at).toLocaleDateString()}: {r.snapshot.name}{r.snapshot.brand ? ` (${r.snapshot.brand})` : ""}, {r.snapshot.formulation ?? "n/a"}, {r.snapshot.ingredients ?? "no ingredients listed"}{r.snapshot.dose != null ? `, ${r.snapshot.dose} ${r.snapshot.dose_unit}` : ""}</li>
            ))}
          </ul>
        )}
      </article>
    );
  }

  return (
    <>
      <div className="eyebrow">Health</div>
      <h1>Supplements</h1>
      <p className="muted small">A personal log of what you take. APEX does not recommend supplements or doses.</p>
      {error && <div className="notice error">{error}</div>}
      {sups === null && !error && <p className="muted">Loading…</p>}

      {sups !== null && !editing && <button className="btn" onClick={() => setEditing("new")}>+ Add supplement</button>}
      {editing === "new" && <SupplementForm key="new" today={today} onSave={(b, sl) => save(b, sl, null)} onCancel={() => setEditing(null)} />}
      {stopping && (
        <form className="card formgrid" onSubmit={discontinue} style={{ marginTop: 14 }}>
          <b style={{ gridColumn: "1 / -1" }}>Discontinue {stopping.name}</b>
          <label>Last day taken<input type="date" value={stopForm.end} min={stopping.start_date} max={today} onChange={(e) => setStopForm({ ...stopForm, end: e.target.value })} required /></label>
          <label>Reason (optional)<input value={stopForm.reason} maxLength={500} onChange={(e) => setStopForm({ ...stopForm, reason: e.target.value })} placeholder="e.g. finished course, side effects" /></label>
          <div className="row"><button className="btn" type="submit">Discontinue</button><button className="btn ghost" type="button" onClick={() => setStopping(null)}>Cancel</button></div>
          <p className="muted small" style={{ gridColumn: "1 / -1", margin: 0 }}>It stays in your history with its dose, dates and reason. Nothing is deleted.</p>
        </form>
      )}

      {sups !== null && (
        <>
          <h2>Today&apos;s doses</h2>
          <div className="row" style={{ marginBottom: 10 }}>
            <label style={{ flexDirection: "row", alignItems: "center", margin: 0 }}>Day
              <input type="date" value={day} min={addDay(today, -60)} max={today} onChange={(e) => e.target.value && setDay(e.target.value)} style={{ width: 170 }} /></label>
          </div>
          {due.length === 0 ? <div className="notice">No doses scheduled for this day. Add a schedule to an active supplement.</div> : (
            <div className="card">
              {due.sort((a, b) => ["morning", "lunch", "dinner"].indexOf(a.slot) - ["morning", "lunch", "dinner"].indexOf(b.slot)).map((d) => {
                const st = intakes.find((i) => i.supplement_id === d.supplement_id && i.slot === d.slot && i.day === day)?.status ?? null;
                const k = `${d.supplement_id}|${d.slot}`;
                return (
                  <div key={k} className="doserow">
                    <span className="badge">{SLOT_LABEL[d.slot]}</span>
                    <span><b>{byId.get(d.supplement_id)?.name}</b> <span className="muted small">{d.dose} {d.dose_unit}</span></span>
                    <span className="row" style={{ marginLeft: "auto" }}>
                      <button className={st === "taken" ? "chip on" : "chip"} aria-pressed={st === "taken"} disabled={busyKey === k} onClick={() => mark(d.supplement_id, d.slot, d.dose, d.dose_unit, "taken")}>Taken</button>
                      <button className={st === "skipped" ? "chip on" : "chip"} aria-pressed={st === "skipped"} disabled={busyKey === k} onClick={() => mark(d.supplement_id, d.slot, d.dose, d.dose_unit, "skipped")}>Skipped</button>
                      {st && <button className="chip" disabled={busyKey === k} onClick={() => mark(d.supplement_id, d.slot, d.dose, d.dose_unit, null)}>Not yet</button>}
                      {!st && <span className="muted small">Not yet taken</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          <h2>Active ({active.length})</h2>
          {active.length === 0 && <div className="notice">No active supplements yet. Use “Add supplement” to start your log.</div>}
          {active.map(card)}
          {past.length > 0 && <><h2>Discontinued ({past.length})</h2>{past.map(card)}</>}
        </>
      )}
    </>
  );
}
