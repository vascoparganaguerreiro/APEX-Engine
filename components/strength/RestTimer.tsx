"use client";
import { useEffect, useRef, useState } from "react";
import { fmtClock } from "@/lib/strength/hooks";

export interface RestState { endAt: number | null; pausedLeft: number | null; total: number; label: string }
const KEY = "apex-strength-rest";
export const loadRest = (): RestState | null => { try { const r = JSON.parse(localStorage.getItem(KEY) ?? "null") as RestState | null; return r && (r.endAt || r.pausedLeft) ? r : null; } catch { return null; } };
export const saveRest = (r: RestState | null) => { try { if (r) localStorage.setItem(KEY, JSON.stringify(r)); else localStorage.removeItem(KEY); } catch { /* optional */ } };

/** Completion alert: vibration, a short tone, and a system notification only if the user allowed notifications. */
function alertDone(label: string) {
  try { navigator.vibrate?.([200, 100, 200]); } catch { /* optional */ }
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctx) { const c = new Ctx(), o = c.createOscillator(), g = c.createGain(); o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime + 0.35); }
  } catch { /* optional */ }
  try { if (document.visibilityState !== "visible" && "Notification" in window && Notification.permission === "granted") new Notification("Rest finished", { body: label, tag: "apex-rest" }); } catch { /* optional */ }
}

/** Sticky rest timer. Survives a page refresh (end time stored on the device); keeps counting past zero so you can see overrun. */
export default function RestTimer({ rest, setRest }: { rest: RestState | null; setRest: (r: RestState | null) => void }) {
  const [now, setNow] = useState(() => Date.now());
  const fired = useRef<number | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const shown = rest !== null;
  // On phones the bar sits above the bottom navigation and can wrap to two rows. Its real height is published as --rest-h so the floating
  // buttons (quick actions, Ask APEX) and the page padding clear it instead of sitting under or over it.
  useEffect(() => {
    const el = bar.current;
    if (!shown || !el || typeof ResizeObserver === "undefined") return;
    const set = () => document.documentElement.style.setProperty("--rest-h", `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => { ro.disconnect(); document.documentElement.style.removeProperty("--rest-h"); };
  }, [shown]);
  useEffect(() => { if (!rest || rest.pausedLeft !== null) return; const t = window.setInterval(() => setNow(Date.now()), 250); return () => window.clearInterval(t); }, [rest]);
  const left = rest ? (rest.pausedLeft !== null ? rest.pausedLeft : Math.round(((rest.endAt ?? 0) - now) / 1000)) : 0;
  useEffect(() => {
    if (rest?.endAt && left <= 0 && fired.current !== rest.endAt) { fired.current = rest.endAt; alertDone(rest.label); }
  }, [left, rest]);
  if (!rest) return null;
  const update = (r: RestState | null) => { saveRest(r); setRest(r); };
  const add = (s: number) => update(rest.pausedLeft !== null ? { ...rest, pausedLeft: Math.max(0, rest.pausedLeft + s) } : { ...rest, endAt: (rest.endAt ?? Date.now()) + s * 1000 });
  return (
    <div ref={bar} className={left < 0 ? "restbar over" : "restbar"} role="timer" aria-label={`Rest timer for ${rest.label}`}>
      <span className="muted small">Rest · {rest.label}</span>
      <b aria-live={left <= 5 ? "assertive" : "off"}>{left < 0 ? `+${fmtClock(-left)}` : fmtClock(left)}</b>
      <button className="iconbtn" onClick={() => add(-15)} aria-label="15 seconds less">−15</button>
      <button className="iconbtn" onClick={() => add(15)} aria-label="15 seconds more">+15</button>
      {rest.pausedLeft === null
        ? <button className="iconbtn" onClick={() => update({ ...rest, pausedLeft: left, endAt: null })} aria-label="Pause rest">❚❚</button>
        : <button className="iconbtn" onClick={() => update({ ...rest, endAt: Date.now() + rest.pausedLeft! * 1000, pausedLeft: null })} aria-label="Resume rest">▶</button>}
      <button className="iconbtn" onClick={() => update({ ...rest, endAt: Date.now() + rest.total * 1000, pausedLeft: null })} aria-label="Reset rest">↺</button>
      <button className="btn tiny" onClick={() => update(null)}>Skip</button>
    </div>
  );
}
