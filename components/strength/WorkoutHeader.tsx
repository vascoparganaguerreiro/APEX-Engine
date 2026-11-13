"use client";
import { useEffect, useRef, useState } from "react";
import { fmtClock } from "@/lib/strength/hooks";
import { contextLine, menuFocusIndex } from "@/lib/strength/headerMenu";
import { elapsedSeconds, type Workout } from "@/lib/strength/workout";

/** The live workout header: compact and sticky. Row 1: Minimise, workout name, duration, Finish and a menu. Row 2: where you are (sets done, current and next
 *  exercise, paused) and the save status. Everything else (Pause or Resume, Ask APEX, rest alerts, Cancel) is in the menu. It holds no workout logic: each
 *  action is the same function the page used before, passed in. */
export default function WorkoutHeader({ w, now, done, total, current, next, sync, alerts, onRename, onMinimise, onFinish, onPause, onResume, onAsk, onEnableAlerts, onCancel }: {
  w: Workout; now: string; done: number; total: number; current: string | null; next: string | null; sync: React.ReactNode;
  /** true while the browser has not yet been asked about rest alerts (then the menu offers to enable them) */
  alerts: boolean;
  onRename: (title: string) => void; onMinimise: () => void; onFinish: () => void; onPause: () => void; onResume: () => void; onAsk: () => void; onEnableAlerts: () => void; onCancel: () => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  const close = (refocus: boolean) => { setOpen(false); if (refocus) button.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const away = (e: PointerEvent) => { const t = e.target as Node; if (!menu.current?.contains(t) && !button.current?.contains(t)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(true); return; }
    if (e.key === "Tab") { setOpen(false); return; }
    const list = items(), i = menuFocusIndex(list.indexOf(document.activeElement as HTMLElement), list.length, e.key);
    if (i !== null) { e.preventDefault(); list[i].focus(); }
  };
  const run = (f: () => void) => () => { close(true); f(); };
  const line = contextLine({ done, total, current, next });
  return (
    <div className="wk-head">
      <div className="wk-top">
        <button type="button" className="wk-icon" aria-label="Minimise workout" title="Minimise: the workout keeps running; continue it from Today" onClick={onMinimise}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M6 9l6 6 6-6" /></svg>
        </button>
        <input className="wk-title" aria-label="Workout name" value={w.title} maxLength={120} onChange={(e) => onRename(e.target.value)} />
        <span className="wk-clock" aria-label="Workout duration">{fmtClock(elapsedSeconds(w, now))}</span>
        <button type="button" className="btn tiny wk-finish" onClick={onFinish}>Finish</button>
        <div className="wk-menuwrap">
          <button ref={button} type="button" className="wk-icon" id="wk-menu-btn" aria-label="Workout menu" aria-haspopup="menu" aria-expanded={open} aria-controls="wk-menu" onClick={() => setOpen((v) => !v)}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
          </button>
          {open && (
            <div ref={menu} id="wk-menu" className="wk-menu" role="menu" aria-labelledby="wk-menu-btn" onKeyDown={onKeyDown}>
              {w.pausedAt
                ? <button type="button" role="menuitem" className="wk-item" onClick={run(onResume)}>▶ Resume workout</button>
                : <button type="button" role="menuitem" className="wk-item" onClick={run(onPause)}>❚❚ Pause workout</button>}
              <button type="button" role="menuitem" className="wk-item" onClick={run(onAsk)}>💬 Ask APEX</button>
              {alerts && <button type="button" role="menuitem" className="wk-item" onClick={run(onEnableAlerts)}>🔔 Enable rest alerts</button>}
              <button type="button" role="menuitem" className="wk-item danger" onClick={run(onCancel)}>Cancel workout</button>
            </div>
          )}
        </div>
      </div>
      <div className="wk-ctx">
        <span className="wk-ctx-text" title={line}>{line}</span>
        {w.pausedAt && <span className="wk-paused">Paused</span>}
        {sync}
      </div>
      <div className="wk-progress" role="img" aria-label={`${done} of ${total} sets done`}><i style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
    </div>
  );
}
