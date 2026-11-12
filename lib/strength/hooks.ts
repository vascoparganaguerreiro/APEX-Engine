"use client";
// React hooks shared by the Strength Hub pages. Reads run as the signed-in user (RLS). A missing migration is surfaced as setUp=false.
import { useCallback, useEffect, useState } from "react";
import { getSupabase } from "../supabase";
import { CATALOG, resolveExercise } from "./library.ts";
import { NotSetUp, loadCustom, loadHistory, listRoutines, type Db } from "./data.ts";
import type { HSession } from "./analytics.ts";
import type { Routine } from "./routines.ts";
import type { Exercise } from "./types.ts";

export const sdb = () => getSupabase() as unknown as Db;
export const errText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));

/** Catalog + the user's custom exercises. Works offline with the bundled catalog. */
export function useLibrary() {
  const [custom, setCustom] = useState<Exercise[]>([]);
  const [setUp, setSetUp] = useState<boolean | null>(null);
  const reload = useCallback(async () => {
    try { const c = await loadCustom(sdb()); setCustom(c); setSetUp(true); localStorage.setItem("apex-strength-custom", JSON.stringify(c)); }
    catch (e) {
      if (e instanceof NotSetUp) setSetUp(false);
      try { const cached = JSON.parse(localStorage.getItem("apex-strength-custom") ?? "[]") as Exercise[]; setCustom(cached); } catch { /* none */ }
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  const all = [...CATALOG, ...custom];
  return { all, custom, setUp, reload, resolve: (k: string) => resolveExercise(k, custom) };
}

const HIST_KEY = "apex-strength-history-v1";
/** All finished workouts (paged, up to 5000), with the most recent cached on the device so "last time" values still show offline. */
export function useHistory(custom: readonly Exercise[]) {
  const [sessions, setSessions] = useState<HSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setUp, setSetUp] = useState<boolean | null>(null);
  const reload = useCallback(async () => {
    try {
      const s = await loadHistory(sdb(), { keys: null, resolve: (k) => resolveExercise(k, custom) });
      setSessions(s); setSetUp(true); setError(null);
      try { localStorage.setItem(HIST_KEY, JSON.stringify(s.slice(0, 120))); } catch { /* quota: cache is optional */ }
    } catch (e) {
      if (e instanceof NotSetUp) setSetUp(false); else setError(errText(e));
      try { setSessions(JSON.parse(localStorage.getItem(HIST_KEY) ?? "[]") as HSession[]); } catch { setSessions([]); }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [custom.length]);
  useEffect(() => { void reload(); }, [reload]);
  return { sessions, error, setUp, reload };
}

const ROUT_KEY = "apex-strength-routines-v1";
export function useRoutines() {
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [setUp, setSetUp] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try { const r = await listRoutines(sdb()); setRoutines(r); setSetUp(true); setError(null); localStorage.setItem(ROUT_KEY, JSON.stringify(r)); }
    catch (e) {
      if (e instanceof NotSetUp) setSetUp(false); else setError(errText(e));
      try { setRoutines(JSON.parse(localStorage.getItem(ROUT_KEY) ?? "[]") as Routine[]); } catch { setRoutines([]); }
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { routines, setUp, error, reload };
}

export const fmtClock = (s: number) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return `${h ? `${h}:` : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(x).padStart(2, "0")}`; };
export const fmtMin = (s: number | null) => (s === null ? "–" : s >= 3600 ? `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, "0")} min` : `${Math.round(s / 60)} min`);
