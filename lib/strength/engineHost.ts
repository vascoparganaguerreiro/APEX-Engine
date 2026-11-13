// Keeps exactly one Strength engine alive, and only for the user who is signed in right now. Pure (no browser or Supabase imports) so
// the account-switch rules are testable. A different user, a sign-out or reset() disposes the old engine; an engine still being built for
// a user who has since left is disposed as soon as it is ready, so it can never be handed out.
import type { SyncEngine } from "./sync.ts";

export interface BuiltEngine { engine: SyncEngine; storage: "indexeddb" | "localstorage" | "memory"; cleanup(): void }
export interface EngineHostDeps { userId(): Promise<string | null>; build(userId: string): Promise<BuiltEngine> }
interface Entry { userId: string; dead: boolean; built?: BuiltEngine; promise: Promise<BuiltEngine> }

export function createEngineHost(deps: EngineHostDeps) {
  let current: Entry | null = null;
  const stop = (b: BuiltEngine) => { b.engine.dispose(); b.cleanup(); };
  // Disposal is immediate when the engine exists; an engine still being built is disposed the moment it is ready.
  const kill = (e: Entry) => { e.dead = true; if (e.built) stop(e.built); };
  const reset = () => { if (current) { kill(current); current = null; } };
  return {
    reset,
    /** The signed-in user's id of the live engine, or null. */
    get activeUserId() { return current?.userId ?? null; },
    /** Call when auth changes: drops the engine unless it already belongs to the new user. */
    onAuthChange(userId: string | null) { if (current && current.userId !== userId) reset(); },
    async get(): Promise<BuiltEngine> {
      const uid = await deps.userId();
      if (!uid) { reset(); throw new Error("Sign in to use Strength."); }
      if (current && current.userId !== uid) reset();
      if (!current) {
        const entry: Entry = { userId: uid, dead: false, promise: null as unknown as Promise<BuiltEngine> };
        entry.promise = deps.build(uid).then(
          (b) => { entry.built = b; if (entry.dead) stop(b); return b; },
          (e) => { if (current === entry) current = null; throw e; },
        );
        current = entry;
      }
      const entry = current as Entry;
      const built = await entry.promise;
      // Re-check the session at the moment of hand-over: an engine is only returned if it is still the signed-in user's.
      const now = await deps.userId().catch(() => null);
      if (entry.dead || now !== entry.userId) { if (current === entry) reset(); else kill(entry); throw new Error("The signed-in user changed. Try again."); }
      return built;
    },
  };
}
