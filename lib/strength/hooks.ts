"use client";
// React hooks shared by the Strength Hub pages. Reads run as the signed-in user (RLS). A missing migration is surfaced as setUp=false.
import { useCallback, useEffect, useState } from "react";
import { getSupabase } from "../supabase";
import { friendlyMessage } from "../userError.ts";
import { CATALOG, resolveExercise } from "./library.ts";
import { NotSetUp, loadCustom, loadHistory, listRoutines, type Db } from "./data.ts";
import type { HSession } from "./analytics.ts";
import type { Routine } from "./routines.ts";
import type { Exercise } from "./types.ts";
import { CUSTOM_KEY, HIST_KEY, ROUT_KEY, scopedKey } from "./scope.ts";
import { sessionUserId } from "./runtime.ts";

/** Per-user device cache. Reads and writes go to the key of the user who is signed in at that moment; a write is skipped if the user changed while the data was loading. */
const cacheGet = <T,>(base: string, uid: string | null, fallback: T): T => { try { return uid ? (JSON.parse(localStorage.getItem(scopedKey(base, uid)) ?? "null") as T | null) ?? fallback : fallback; } catch { return fallback; } };
/** True when the signed-in user is no longer the one a load started for: its result must be dropped. */
const changedUser = async (uid: string | null) => uid !== (await sessionUserId());
async function cachePut(base: string, uid: string | null, value: unknown) {
  try { if (uid && uid === (await sessionUserId())) localStorage.setItem(scopedKey(base, uid), JSON.stringify(value)); } catch { /* quota: cache is optional */ }
}

export const sdb = () => getSupabase() as unknown as Db;
export const errText = (e: unknown) => friendlyMessage(e, "That could not be completed", { scope: "strength" });

/** Catalog + the user's custom exercises. Works offline with the bundled catalog. */
export function useLibrary() {
  const [custom, setCustom] = useState<Exercise[]>([]);
  const [setUp, setSetUp] = useState<boolean | null>(null);
  const reload = useCallback(async () => {
    const uid = await sessionUserId();
    try { const c = await loadCustom(sdb()); if (await changedUser(uid)) return; setCustom(c); setSetUp(true); await cachePut(CUSTOM_KEY, uid, c); }
    catch (e) {
      if (await changedUser(uid)) return;
      if (e instanceof NotSetUp) setSetUp(false);
      setCustom(cacheGet<Exercise[]>(CUSTOM_KEY, uid, []));
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  const all = [...CATALOG, ...custom];
  return { all, custom, setUp, reload, resolve: (k: string) => resolveExercise(k, custom) };
}

/** All finished workouts (paged, up to 5000), with the most recent cached on the device so "last time" values still show offline. */
export function useHistory(custom: readonly Exercise[]) {
  const [sessions, setSessions] = useState<HSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setUp, setSetUp] = useState<boolean | null>(null);
  const reload = useCallback(async () => {
    const uid = await sessionUserId();
    try {
      const s = await loadHistory(sdb(), { keys: null, resolve: (k) => resolveExercise(k, custom) });
      if (await changedUser(uid)) return;
      setSessions(s); setSetUp(true); setError(null);
      await cachePut(HIST_KEY, uid, s.slice(0, 120));
    } catch (e) {
      if (await changedUser(uid)) return;
      if (e instanceof NotSetUp) setSetUp(false); else setError(errText(e));
      setSessions(cacheGet<HSession[]>(HIST_KEY, uid, []));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [custom.length]);
  useEffect(() => { void reload(); }, [reload]);
  return { sessions, error, setUp, reload };
}

export function useRoutines() {
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [setUp, setSetUp] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    const uid = await sessionUserId();
    try { const r = await listRoutines(sdb()); if (await changedUser(uid)) return; setRoutines(r); setSetUp(true); setError(null); await cachePut(ROUT_KEY, uid, r); }
    catch (e) {
      if (await changedUser(uid)) return;
      if (e instanceof NotSetUp) setSetUp(false); else setError(errText(e));
      setRoutines(cacheGet<Routine[]>(ROUT_KEY, uid, []));
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { routines, setUp, error, reload };
}

export const fmtClock = (s: number) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return `${h ? `${h}:` : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(x).padStart(2, "0")}`; };
export const fmtMin = (s: number | null) => (s === null ? "–" : s >= 3600 ? `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, "0")} min` : `${Math.round(s / 60)} min`);
