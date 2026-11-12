"use client";
// Browser runtime for the Strength Hub: one SyncEngine per tab, backed by IndexedDB, flushing automatically when the connection returns,
// when the tab becomes visible, and periodically while changes are pending. Workout logging never waits for the network.
import { useEffect, useState } from "react";
import { getSupabase } from "../supabase";
import { pickStore } from "./idb.ts";
import { SyncEngine, type SyncStatus } from "./sync.ts";
import { supabaseTransport, type Db } from "./data.ts";

let enginePromise: Promise<{ engine: SyncEngine; storage: "indexeddb" | "localstorage" | "memory" }> | null = null;
export const newId = (): string => crypto.randomUUID();

export function getEngine() {
  enginePromise ??= (async () => {
    const { store, kind } = await pickStore();
    const engine = new SyncEngine(store, supabaseTransport(getSupabase() as unknown as Db, () => navigator.onLine !== false), { nowMs: () => Date.now(), newId });
    await engine.load();
    const kick = () => { if (engine.status.pending > 0) void engine.flush(); };
    window.addEventListener("online", kick);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") kick(); });
    window.setInterval(kick, 20_000);
    // Ask the browser not to evict our storage under pressure (best effort; the user may be asked).
    try { void navigator.storage?.persist?.(); } catch { /* optional */ }
    void engine.flush();
    return { engine, storage: kind };
  })();
  return enginePromise;
}

export function useSyncStatus(): { status: SyncStatus | null; storage: string | null } {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [storage, setStorage] = useState<string | null>(null);
  useEffect(() => {
    let off = () => {};
    getEngine().then(({ engine, storage: s }) => { setStorage(s); off = engine.subscribe(setStatus); }).catch(() => setStorage("memory"));
    return () => off();
  }, []);
  return { status, storage };
}
