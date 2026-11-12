"use client";
import { useState } from "react";
import Link from "next/link";
import { PriorityPill } from "@/components/races/RaceBits";
import { formatDuration } from "@/lib/activities";
import { detailOf, KIND_LABEL, linkProblem, type CalendarDay, type CompletedItem, type MatchSuggestion, type PlannedWorkout } from "@/lib/calendar/model";
import { longDate } from "@/lib/today/model";

export interface DrawerActions {
  add: (day: string) => void;
  edit: (p: PlannedWorkout) => void;
  remove: (p: PlannedWorkout) => Promise<void>;
  done: (p: PlannedWorkout) => Promise<void>;
  skip: (p: PlannedWorkout) => Promise<void>;
  reopen: (p: PlannedWorkout) => Promise<void>;
  link: (p: PlannedWorkout, rec: { kind: "activity" | "strength"; id: string }, origin: "manual" | "confirmed_match") => Promise<void>;
}

const STATUS_TEXT = { planned: "Planned", completed: "Completed", skipped: "Skipped" } as const;

/** Everything for one day. Planned, completed (recorded) and race items are in separate sections and never merged. */
export default function DayDrawer({ day, today, all, suggestions, tablesReady, actions, onClose, error }: {
  day: CalendarDay; today: string; all: PlannedWorkout[]; suggestions: MatchSuggestion[]; tablesReady: boolean; actions: DrawerActions; onClose: () => void; error: string | null;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<void>) => { setBusy(key); try { await fn(); } finally { setBusy(null); } };
  const sugFor = (id: string) => suggestions.find((s) => s.plannedId === id) ?? null;
  const plannedById = new Map(all.map((p) => [p.id, p]));
  // Unlinked recorded sessions of this day a plan could be manually linked to (the database refuses double links; the model checks first).
  const linkable = (p: PlannedWorkout) => day.completed.filter((c) => c.plannedId === null && !linkProblem(p, { kind: c.kind, id: c.id }, all));

  return (
    <div className="sheet-bg" role="dialog" aria-modal="true" aria-label={`Details for ${longDate(day.day)}`} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <h3>{longDate(day.day)}{day.day === today ? " · Today" : ""}</h3>
          <button className="btn ghost" onClick={onClose} aria-label="Close">Close</button>
        </div>
        {error && <div className="notice error" role="alert">{error}</div>}

        {day.races.length > 0 && (
          <section aria-label="Races"><h4 className="cal-h">Races</h4>
            {day.races.map((r) => (
              <Link key={r.id} href={`/races/${r.id}`} className="cal-row">
                <span><b>{r.name}</b><small>{r.location ? ` · ${r.location}` : ""}</small></span><PriorityPill p={r.priority} />
              </Link>
            ))}
          </section>
        )}

        <section aria-label="Planned"><h4 className="cal-h">Planned <small className="muted">· your intentions, not measurements</small></h4>
          {day.planned.length === 0 && <p className="muted small">Nothing planned.</p>}
          {day.planned.map((p) => {
            const sug = p.status === "planned" ? sugFor(p.id) : null;
            const linked = p.completed_activity_id !== null || p.completed_strength_session_id !== null;
            return (
              <div key={p.id} className={`cal-plan s-${p.status}`}>
                <div><b>{p.title}</b> <span className="pill">{KIND_LABEL[p.kind]}</span> <span className="pill">{STATUS_TEXT[p.status]}</span></div>
                <div className="muted small">{detailOf(p)}{p.notes ? ` · ${p.notes}` : ""}</div>
                {p.status === "completed" && <div className="small">{linked ? "Linked to a recorded session." : "Marked done by you (no recorded session attached)."}</div>}
                {sug && (
                  <div className="notice" role="group" aria-label="Suggested match">
                    <div className="small"><b>Possible match:</b> {sug.recordTitle} <span className="muted">({sug.reasons.join(", ")})</span></div>
                    <div className="small muted">Nothing is linked unless you confirm.</div>
                    <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                      <button className="btn" disabled={busy !== null} onClick={() => run(`m${p.id}`, () => actions.link(p, { kind: sug.kind, id: sug.recordId }, "confirmed_match"))}>Confirm match</button>
                    </div>
                  </div>
                )}
                {p.status === "planned" && linkable(p).length > 0 && !sug && (
                  <div className="small" style={{ marginTop: 6 }}>Link to a recorded session:{" "}
                    {linkable(p).map((c) => <button key={c.kind + c.id} className="chip" disabled={busy !== null} onClick={() => run(`l${c.id}`, () => actions.link(p, { kind: c.kind, id: c.id }, "manual"))}>{c.title}</button>)}
                  </div>
                )}
                <div className="cal-actions">
                  {p.status === "planned" && (p.kind === "endurance" || p.kind === "strength") && <button className="chip" disabled={busy !== null} onClick={() => run(`d${p.id}`, () => actions.done(p))}>Mark done</button>}
                  {p.status === "planned" && p.kind !== "rest" && p.kind !== "milestone" && <button className="chip" disabled={busy !== null} onClick={() => run(`s${p.id}`, () => actions.skip(p))}>Skip</button>}
                  {p.status !== "planned" && <button className="chip" disabled={busy !== null} onClick={() => run(`r${p.id}`, () => actions.reopen(p))}>Reopen</button>}
                  <button className="chip" disabled={busy !== null} onClick={() => actions.edit(p)}>Edit</button>
                  {confirmDelete === p.id
                    ? <button className="chip" disabled={busy !== null} onClick={() => run(`x${p.id}`, async () => { await actions.remove(p); setConfirmDelete(null); })}>Confirm delete</button>
                    : <button className="chip" disabled={busy !== null} onClick={() => setConfirmDelete(p.id)}>Delete</button>}
                </div>
              </div>
            );
          })}
          {tablesReady && <button className="btn" style={{ marginTop: 10 }} onClick={() => actions.add(day.day)}>+ Add to this day</button>}
        </section>

        <section aria-label="Completed"><h4 className="cal-h">Completed <small className="muted">· recorded sessions</small></h4>
          {day.completed.length === 0 && <p className="muted small">No recorded session.</p>}
          {day.completed.map((c: CompletedItem) => (
            <Link key={c.kind + c.id} href={c.href} className="cal-row done">
              <span><b>{c.title}</b><small> · {c.kind === "strength" ? "Strength" : c.sport}{c.durationS ? ` · ${formatDuration(c.durationS)}` : ""}</small></span>
              {c.plannedId && <span className="pill">linked to “{plannedById.get(c.plannedId)?.title ?? "a plan"}”</span>}
            </Link>
          ))}
        </section>
      </div>
    </div>
  );
}
