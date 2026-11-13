// Shared helpers for the Strength Hub tests.
import { catalogExercise } from "../lib/strength/library.ts";
import type { Exercise } from "../lib/strength/types.ts";
import type { Op, OpResult, SendAuth, Transport } from "../lib/strength/sync.ts";
import { TransportError } from "../lib/strength/sync.ts";

let n = 0;
/** Deterministic, valid v4-shaped UUIDs. */
export function uid(): string { n++; const h = n.toString(16).padStart(12, "0"); return `00000000-0000-4000-8000-${h}`; }
export const ex = (key: string): Exercise => { const e = catalogExercise(key); if (!e) throw new Error(`no exercise ${key}`); return e; };
export const T0 = "2026-11-10T08:00:00.000Z";
export const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();

/** In-memory model of apply_strength_ops in 13_strength.sql: rev guard, tombstones, parent checks, owner checks. */
export class FakeStrengthServer {
  rows = new Map<string, { kind: string; id: string; rev: number; user: string; deleted: boolean; data: Record<string, unknown> }>();
  calls = 0;
  user: string;
  constructor(user = "user-a") { this.user = user; }
  apply(ops: Op[], user = this.user): OpResult[] {
    this.calls++;
    return ops.map((op) => {
      try {
        if (!(op.rev > 0)) throw new Error("rev required");
        const k = `${op.kind}:${op.id}`, cur = this.rows.get(k);
        if (op.kind === "exercise") {
          const p = this.rows.get(`session:${op.data.session_id}`);
          if (!p || p.user !== user) throw new Error("violates foreign key or row level security");
          if (cur && cur.data.session_id !== op.data.session_id) return { op_id: op.op_id, status: "stale" as const };
        }
        if (op.kind === "set") {
          const p = this.rows.get(`exercise:${op.data.session_exercise_id}`);
          if (!p || p.user !== user || p.data.session_id !== op.data.session_id) throw new Error("violates foreign key strength_sets_exercise_fk");
          if (cur && cur.data.session_exercise_id !== op.data.session_exercise_id) return { op_id: op.op_id, status: "stale" as const };
        }
        if (cur && cur.user !== user) throw new Error("new row violates row-level security policy");
        if (cur && cur.rev >= op.rev) return { op_id: op.op_id, status: "stale" as const };
        this.rows.set(k, { kind: op.kind, id: op.id, rev: op.rev, user, deleted: op.deleted, data: { ...op.data } });
        return { op_id: op.op_id, status: "applied" as const };
      } catch (e) {
        return { op_id: op.op_id, status: "rejected" as const, error: (e as Error).message };
      }
    });
  }
  live(kind: string) { return [...this.rows.values()].filter((r) => r.kind === kind && !r.deleted); }
}

export interface FakeTransport extends Transport { mode: "ok" | "offline" | "lose_response" | "not_set_up" | "slow"; sent: Op[][]; auths: Array<SendAuth | undefined>; release?: () => void }
export function transportFor(server: FakeStrengthServer, user?: string): FakeTransport {
  const t: FakeTransport = {
    mode: "ok", sent: [], auths: [],
    async send(ops, auth) {
      t.sent.push(ops); t.auths.push(auth);
      if (t.mode === "offline") throw new TransportError("offline", "Failed to fetch");
      if (t.mode === "not_set_up") throw new TransportError("not_set_up", "function apply_strength_ops does not exist");
      if (t.mode === "lose_response") { server.apply(ops, user); throw new TransportError("offline", "connection reset after the server committed"); }
      if (t.mode === "slow") await new Promise<void>((r) => { t.release = r; });
      return server.apply(ops, user);
    },
  };
  return t;
}
export const clock = (start = Date.parse(T0)) => { let t = start; return { nowMs: () => (t += 1000), newId: uid }; };

/** The owner given to engines in single-user tests: one fixed user who stays signed in. */
export const TEST_USER = "11111111-1111-4111-8111-111111111111";
/** A fake access token that names the user (header.payload.signature; only the `sub` claim matters to the code under test). */
export const fakeToken = (userId: string): string => `h.${Buffer.from(JSON.stringify({ sub: userId })).toString("base64url")}.s`;
export const testOwner = (): { userId: string; session(): Promise<SendAuth | null> } => ({ userId: TEST_USER, session: async () => ({ userId: TEST_USER, accessToken: fakeToken(TEST_USER) }) });
