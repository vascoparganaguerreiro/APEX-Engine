// Offline-first sync for workouts. No I/O of its own: the local store (IndexedDB in the browser, memory in tests) and the transport
// (the apply_strength_ops RPC) are injected.
//
// Guarantees
//  * Every change is written to the local store BEFORE anything is sent, so a refresh, a closed tab or a dead connection loses nothing.
//  * Each row has a device-generated UUID and every write carries a strictly increasing "rev". The server only accepts a newer rev, so a
//    replayed or duplicated request (for example a response lost on a flaky network) is answered "stale" and never creates a second set.
//  * Deletions are sent as tombstones, so a delayed older write can never bring a deleted set back.
//  * One flush at a time per engine; ops sent concurrently from two tabs are still safe because the server is idempotent.
import { rowsOf, type RowKind, type Workout } from "./workout.ts";

export interface Op { op_id: string; kind: RowKind; id: string; rev: number; deleted: boolean; data: Record<string, unknown> }
export interface QueuedOp extends Op { sessionId: string; attempts: number; error: string | null; failed: boolean }
export interface OpResult { op_id: string; status: "applied" | "stale" | "rejected"; error?: string }
export interface SyncState {
  queue: QueuedOp[];
  /** Last data enqueued for every row we know about: "kind:id" -> { sessionId, json }. Used to diff and to build tombstones. */
  known: Record<string, { sessionId: string; kind: RowKind; id: string; json: string }>;
  lastRev: number;
  /** Sessions with at least one op the server has acknowledged. */
  sent: string[];
  stale: number;
}
export const emptySync = (): SyncState => ({ queue: [], known: {}, lastRev: 0, sent: [], stale: 0 });

export interface LocalData { version: 1; activeId: string | null; workouts: Record<string, Workout>; sync: SyncState }
export interface LocalStore { read(): Promise<LocalData | null>; write(d: LocalData): Promise<void> }
export const emptyLocal = (): LocalData => ({ version: 1, activeId: null, workouts: {}, sync: emptySync() });

export type TransportErrorKind = "offline" | "not_set_up" | "auth" | "server";
export class TransportError extends Error { kind: TransportErrorKind; constructor(kind: TransportErrorKind, message: string) { super(message); this.kind = kind; } }
export interface Transport { send(ops: Op[]): Promise<OpResult[]> }

const KIND_RANK: Record<RowKind, number> = { session: 0, exercise: 1, set: 2 };
const keyOf = (kind: RowKind, id: string) => `${kind}:${id}`;
export const MAX_ATTEMPTS = 5;
export const BATCH = 100;

/** Strictly increasing version numbers, based on the clock (microsecond-like) so that a second device's later edit usually wins. */
export function nextRev(last: number, nowMs: number): number { return Math.max(Math.floor(nowMs) * 1000, last + 1); }

/** Compare the workout with what was already enqueued and append (or coalesce) the ops needed. Pure. */
export function diffInto(s: SyncState, w: Workout, a: { nowMs: number; newOpId: () => string; inflight: ReadonlySet<string> }): SyncState {
  const rows = rowsOf(w).sort((x, y) => KIND_RANK[x.kind] - KIND_RANK[y.kind]);
  const queue = [...s.queue], known = { ...s.known };
  let rev = s.lastRev;
  const put = (kind: RowKind, id: string, data: Record<string, unknown>, deleted: boolean) => {
    rev = nextRev(rev, a.nowMs);
    const i = queue.findIndex((q) => q.kind === kind && q.id === id && !a.inflight.has(q.op_id));
    const op: QueuedOp = { op_id: a.newOpId(), kind, id, rev, deleted, data, sessionId: w.id, attempts: 0, error: null, failed: false };
    if (i >= 0) queue[i] = op; else queue.push(op);                      // coalesce: one pending op per row
  };
  const present = new Set<string>();
  for (const r of rows) {
    const k = keyOf(r.kind, r.id), json = JSON.stringify(r.data);
    present.add(k);
    if (known[k]?.json === json) continue;
    put(r.kind, r.id, r.data, false);
    known[k] = { sessionId: w.id, kind: r.kind, id: r.id, json };
  }
  // Rows of this workout that disappeared: tombstones, children first is not needed (parents stay), so keep the natural order.
  for (const [k, v] of Object.entries(known)) {
    if (v.sessionId !== w.id || present.has(k)) continue;
    put(v.kind, v.id, JSON.parse(v.json) as Record<string, unknown>, true);
    delete known[k];
  }
  return { ...s, queue, known, lastRev: rev };
}

/** A workout loaded from the server for editing: remember its rows as already stored (nothing is enqueued), so a later deletion
 *  is detected and sent as a tombstone, and unchanged rows are not re-sent. */
export function adoptInto(s: SyncState, w: Workout): SyncState {
  const known = { ...s.known };
  for (const r of rowsOf(w)) { const k = keyOf(r.kind, r.id); if (!known[k]) known[k] = { sessionId: w.id, kind: r.kind, id: r.id, json: JSON.stringify(r.data) }; }
  return { ...s, known, sent: s.sent.includes(w.id) ? s.sent : [...s.sent, w.id] };
}

/** Cancel a workout: anything not yet sent is dropped; if the server already has part of it, a session tombstone hides it. */
export function discardInto(s: SyncState, w: Workout, a: { nowMs: number; newOpId: () => string; inflight: ReadonlySet<string> }): SyncState {
  const wasSent = s.sent.includes(w.id) || s.queue.some((q) => q.sessionId === w.id && a.inflight.has(q.op_id));
  const queue = s.queue.filter((q) => q.sessionId !== w.id || a.inflight.has(q.op_id));
  const known = Object.fromEntries(Object.entries(s.known).filter(([, v]) => v.sessionId !== w.id));
  let rev = s.lastRev;
  if (wasSent) {
    rev = nextRev(rev, a.nowMs);
    const sessionRow = rowsOf(w)[0];
    queue.push({ op_id: a.newOpId(), kind: "session", id: w.id, rev, deleted: true, data: sessionRow.data, sessionId: w.id, attempts: 0, error: null, failed: false });
  }
  return { ...s, queue, known, lastRev: rev };
}

/** Fold server results into the queue. Applied/stale ops are done; rejected ops are retried a few times, then parked as failed. */
export function applyResults(s: SyncState, sent: QueuedOp[], results: OpResult[]): SyncState {
  const byId = new Map(results.map((r) => [r.op_id, r]));
  const done = new Set<string>(), sessions = new Set(s.sent);
  let stale = s.stale;
  const queue = s.queue.map((q) => {
    if (!sent.some((x) => x.op_id === q.op_id)) return q;
    const r = byId.get(q.op_id);
    if (!r) return { ...q, attempts: q.attempts + 1, error: "No answer for this change.", failed: q.attempts + 1 >= MAX_ATTEMPTS };
    if (r.status === "applied" || r.status === "stale") { done.add(q.op_id); sessions.add(q.sessionId); if (r.status === "stale") stale++; return q; }
    return { ...q, attempts: q.attempts + 1, error: r.error ?? "Rejected by the server.", failed: q.attempts + 1 >= MAX_ATTEMPTS };
  }).filter((q) => !done.has(q.op_id));
  return { ...s, queue, sent: [...sessions], stale };
}

export type SyncMode = "synced" | "pending" | "syncing" | "offline" | "not_set_up" | "auth" | "error";
export interface SyncStatus { mode: SyncMode; pending: number; failed: number; stale: number; message: string | null; lastSyncedAt: string | null }

/** Stateful wrapper used by the app: serialises flushes and persists every change before it is sent. */
export class SyncEngine {
  private data: LocalData = emptyLocal();
  private inflight = new Set<string>();
  private flushing: Promise<SyncStatus> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private st: SyncStatus = { mode: "synced", pending: 0, failed: 0, stale: 0, message: null, lastSyncedAt: null };
  private listeners = new Set<(s: SyncStatus) => void>();
  private store: LocalStore;
  private transport: Transport;
  private clock: { nowMs(): number; newId(): string };
  constructor(store: LocalStore, transport: Transport, clock: { nowMs(): number; newId(): string }) { this.store = store; this.transport = transport; this.clock = clock; }

  async load(): Promise<LocalData> {
    const d = await this.store.read();
    if (d && d.version === 1) this.data = { ...emptyLocal(), ...d, sync: { ...emptySync(), ...d.sync } };
    this.refresh(this.st.mode === "syncing" ? "pending" : this.st.mode);
    return this.data;
  }
  get local(): LocalData { return this.data; }
  get status(): SyncStatus { return this.st; }
  subscribe(f: (s: SyncStatus) => void): () => void { this.listeners.add(f); f(this.st); return () => this.listeners.delete(f); }

  private refresh(mode?: SyncMode, message?: string | null) {
    const pending = this.data.sync.queue.filter((q) => !q.failed).length, failed = this.data.sync.queue.filter((q) => q.failed).length;
    const m: SyncMode = mode ?? (pending ? "pending" : "synced");
    this.st = { ...this.st, mode: m === "synced" && pending ? "pending" : m, pending, failed, stale: this.data.sync.stale, message: message === undefined ? this.st.message : message };
    for (const f of this.listeners) f(this.st);
  }
  /** Writes are serialised so an older snapshot can never overwrite a newer one in the store. */
  private persist(): Promise<void> {
    const snap: LocalData = JSON.parse(JSON.stringify(this.data));
    this.writing = this.writing.catch(() => undefined).then(() => this.store.write(snap));
    return this.writing;
  }

  /** Record a new state of a workout (live or a finished one being edited). Durable once the promise resolves. */
  async record(w: Workout, o: { active?: boolean } = {}): Promise<void> {
    this.data = {
      ...this.data, workouts: { ...this.data.workouts, [w.id]: w }, activeId: o.active === false ? (this.data.activeId === w.id ? null : this.data.activeId) : o.active ? w.id : this.data.activeId,
      sync: diffInto(this.data.sync, w, { nowMs: this.clock.nowMs(), newOpId: () => this.clock.newId(), inflight: this.inflight }),
    };
    this.refresh();
    await this.persist();
  }
  /** Start editing a workout that came from the server (see adoptInto). */
  async adopt(w: Workout): Promise<void> {
    this.data = { ...this.data, workouts: { ...this.data.workouts, [w.id]: this.data.workouts[w.id] ?? w }, sync: adoptInto(this.data.sync, w) };
    await this.persist();
  }
  async discard(w: Workout): Promise<void> {
    const workouts = { ...this.data.workouts }; delete workouts[w.id];
    this.data = { ...this.data, workouts, activeId: this.data.activeId === w.id ? null : this.data.activeId, sync: discardInto(this.data.sync, w, { nowMs: this.clock.nowMs(), newOpId: () => this.clock.newId(), inflight: this.inflight }) };
    this.refresh();
    await this.persist();
  }
  /** Forget local copies of finished workouts that are fully synced (the server copy is the source of truth for them). */
  async prune(keepIds: string[] = []): Promise<void> {
    const pendingSessions = new Set(this.data.sync.queue.map((q) => q.sessionId));
    const workouts = Object.fromEntries(Object.entries(this.data.workouts).filter(([id, w]) => id === this.data.activeId || keepIds.includes(id) || w.status === "active" || pendingSessions.has(id)));
    const known = Object.fromEntries(Object.entries(this.data.sync.known).filter(([, v]) => workouts[v.sessionId]));
    this.data = { ...this.data, workouts, sync: { ...this.data.sync, known } };
    await this.persist();
  }
  retryFailed(): Promise<SyncStatus> {
    this.data = { ...this.data, sync: { ...this.data.sync, queue: this.data.sync.queue.map((q) => (q.failed ? { ...q, failed: false, attempts: 0 } : q)) } };
    return this.persist().then(() => this.flush());
  }

  /** Send pending ops. Concurrent calls share the same run. Never throws: the outcome is in the returned status. */
  flush(): Promise<SyncStatus> {
    if (this.flushing) return this.flushing;
    this.flushing = this.runFlush().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  private async runFlush(): Promise<SyncStatus> {
    await this.writing.catch(() => undefined);
    for (let round = 0; round < 20; round++) {
      const batch = this.data.sync.queue.filter((q) => !q.failed && !this.inflight.has(q.op_id)).slice(0, BATCH);
      if (batch.length === 0) { this.refresh(undefined, this.data.sync.queue.some((q) => q.failed) ? "Some changes could not be saved." : null); return this.st; }
      batch.forEach((q) => this.inflight.add(q.op_id));
      this.refresh("syncing");
      let results: OpResult[];
      try {
        results = await this.transport.send(batch.map(({ op_id, kind, id, rev, deleted, data }) => ({ op_id, kind, id, rev, deleted, data })));
      } catch (e) {
        batch.forEach((q) => this.inflight.delete(q.op_id));
        const kind = e instanceof TransportError ? e.kind : "offline";
        const msg = kind === "not_set_up" ? "Saved on this device. The Strength Hub database is not set up yet (migration 13), so nothing is uploaded."
          : kind === "auth" ? "Saved on this device. Sign in again to upload." : kind === "server" ? "Saved on this device. The server had a problem; it will retry." : "Saved on this device. It will upload when you are back online.";
        this.refresh(kind === "server" ? "error" : kind, msg);
        return this.st;
      }
      batch.forEach((q) => this.inflight.delete(q.op_id));
      this.data = { ...this.data, sync: applyResults(this.data.sync, batch, results) };
      this.st = { ...this.st, lastSyncedAt: new Date(this.clock.nowMs()).toISOString() };
      await this.persist();
      if (results.some((r) => r.status === "rejected")) { this.refresh(undefined, "Some changes were rejected and will be retried."); return this.st; }
    }
    this.refresh();
    return this.st;
  }
}

/** In-memory store for tests and as a last-resort fallback when no persistent storage is available. */
export class MemoryStore implements LocalStore {
  data: LocalData | null = null; writes = 0;
  async read() { return this.data ? (JSON.parse(JSON.stringify(this.data)) as LocalData) : null; }
  async write(d: LocalData) { this.writes++; this.data = JSON.parse(JSON.stringify(d)); }
}
