"use client";
// Browser runtime for the Strength Hub: one SyncEngine per tab, backed by IndexedDB, flushing automatically when the connection returns,
// when the tab becomes visible, and periodically while changes are pending. Workout logging never waits for the network.
import { useEffect, useState } from "react";
import { useAuth } from "../useAuth";
import { getSupabase } from "../supabase";
import { pickStore } from "./idb.ts";
import { SyncEngine, type SendAuth, type SyncStatus } from "./sync.ts";
import { createEngineHost, type BuiltEngine } from "./engineHost.ts";
import { supabaseTransport, type Db } from "./data.ts";

export const newId = (): string => crypto.randomUUID();

/** The session read ONCE: the user and the exact access token. An upload is verified and sent with this one object. */
export async function sessionAuth(): Promise<SendAuth | null> {
  const { data } = await getSupabase().auth.getSession();
  const s = data.session;
  return s?.user.id && s.access_token ? { userId: s.user.id.toLowerCase(), accessToken: s.access_token } : null;
}

/** The id of the user signed in right now (null when signed out). Every Strength storage name and cache is scoped by it. */
export async function sessionUserId(): Promise<string | null> {
  const { data } = await getSupabase().auth.getSession();
  return data.session?.user.id ?? null;
}

async function buildEngine(userId: string): Promise<BuiltEngine> {
  const { store, kind } = await pickStore(userId);
  // Identity is re-checked against the live session before every upload (see SyncEngine.runFlush).
  const engine = new SyncEngine(store, supabaseTransport(getSupabase() as unknown as Db, () => navigator.onLine !== false), { nowMs: () => Date.now(), newId }, { userId, session: sessionAuth });
  await engine.load();
  const kick = () => { if (engine.status.pending > 0) void engine.flush(); };
  const onVisible = () => { if (document.visibilityState === "visible") kick(); };
  window.addEventListener("online", kick);
  document.addEventListener("visibilitychange", onVisible);
  const timer = window.setInterval(kick, 20_000);
  // Ask the browser not to evict our storage under pressure (best effort; the user may be asked).
  try { void navigator.storage?.persist?.(); } catch { /* optional */ }
  void engine.flush();
  return { engine, storage: kind, cleanup: () => { window.removeEventListener("online", kick); document.removeEventListener("visibilitychange", onVisible); window.clearInterval(timer); } };
}

const host = createEngineHost({ userId: sessionUserId, build: buildEngine });
let watching = false;
/** The engine of the signed-in user. Rejects when nobody is signed in. A sign-out or a different user disposes the previous engine; the previous user's data stays on the device. */
export function getEngine() {
  if (!watching) { watching = true; getSupabase().auth.onAuthStateChange((_e, s) => host.onAuthChange(s?.user.id ?? null)); }
  return host.get();
}

export function useSyncStatus(): { status: SyncStatus | null; storage: string | null } {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [storage, setStorage] = useState<string | null>(null);
  const { session } = useAuth();
  const uid = session?.user.id ?? null;
  useEffect(() => {
    setStatus(null); setStorage(null);                                   // never show the previous user's status
    if (!uid) return;
    let off = () => {}, gone = false;
    getEngine().then(({ engine, storage: s }) => { if (gone) return; setStorage(s); off = engine.subscribe(setStatus); }).catch(() => { if (!gone) setStorage("memory"); });
    return () => { gone = true; off(); };
  }, [uid]);
  return { status, storage };
}
