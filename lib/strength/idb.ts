// Durable device storage for the active workout and the sync queue: IndexedDB, with localStorage as a fallback (e.g. some private
// browsing modes) and memory as a last resort. Browser only.
import { MemoryStore, type LocalData, type LocalStore } from "./sync.ts";

const DB = "apex-strength", STORE = "state", KEY = "local", LS_KEY = "apex-strength-local-v1";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB unavailable"));
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
}

export class IdbStore implements LocalStore {
  private db: Promise<IDBDatabase> | null = null;
  private conn() { this.db ??= openDb(); return this.db; }
  async read(): Promise<LocalData | null> {
    const db = await this.conn();
    return new Promise((resolve, reject) => {
      const r = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      r.onsuccess = () => resolve((r.result as LocalData | undefined) ?? null);
      r.onerror = () => reject(r.error);
    });
  }
  async write(d: LocalData): Promise<void> {
    const db = await this.conn();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(d, KEY);
      tx.oncomplete = () => resolve();                                 // resolved only once the write is committed
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("write aborted"));
    });
  }
}
export class LocalStorageStore implements LocalStore {
  async read() { const s = localStorage.getItem(LS_KEY); return s ? (JSON.parse(s) as LocalData) : null; }
  async write(d: LocalData) { localStorage.setItem(LS_KEY, JSON.stringify(d)); }
}

/** The best available durable store. `kind` tells the UI whether data survives a browser restart. */
export async function pickStore(): Promise<{ store: LocalStore; kind: "indexeddb" | "localstorage" | "memory" }> {
  if (typeof indexedDB !== "undefined") {
    try { const s = new IdbStore(); await s.read(); return { store: s, kind: "indexeddb" }; } catch { /* fall through */ }
  }
  try { localStorage.setItem("apex-probe", "1"); localStorage.removeItem("apex-probe"); return { store: new LocalStorageStore(), kind: "localstorage" }; } catch { /* fall through */ }
  return { store: new MemoryStore(), kind: "memory" };
}
