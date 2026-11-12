// Where the Supabase session (access + refresh token) is kept, so the login page's "Remember me" can choose between:
//   persistent : localStorage, survives closing the browser (this is what supabase-js already did by default, and it stays the default)
//   session    : sessionStorage (or memory if that is unavailable), gone when the tab/browser is closed
// supabase-js reads and writes the session through this adapter for sign-in, every token refresh and sign-out, so a session stays in the
// storage it started in. Pure (no window, no Supabase import): the storages are injected so every case is unit-testable.
//
// Only the CHOICE ("persistent" / "session") is remembered in a separate key, and it is not a secret. Passwords are never stored anywhere:
// they go to Supabase once over HTTPS in signInWithPassword and are not kept.
export const SESSION_MODE_KEY = "apex.auth.session-mode.v1";
export type SessionMode = "persistent" | "session";
export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

const attempt = <T>(f: () => T, fallback: T): T => { try { return f(); } catch { return fallback; } };

/** The saved choice. No choice yet (everyone already signed in, new visitors) means persistent: nobody is signed out by this change. */
export const readSessionMode = (local: KV | null): SessionMode => attempt(() => (local?.getItem(SESSION_MODE_KEY) === "session" ? "session" : "persistent"), "persistent");
export const writeSessionMode = (local: KV | null, mode: SessionMode): void => { attempt(() => local?.setItem(SESSION_MODE_KEY, mode), undefined); };

/** A storage for supabase-js `auth.storage`. `local` and `session` may be null (blocked by the browser): session mode then keeps the session
 *  in memory only, and persistent mode falls back to session storage; nothing ever writes a token somewhere the user did not choose. */
export function createAuthStorage(local: KV | null, session: KV | null): KV {
  const memory = new Map<string, string>();
  const mem: KV = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => { memory.set(k, v); }, removeItem: (k) => { memory.delete(k); } };
  const all = (): KV[] => [local, session, mem].filter((s): s is KV => s !== null);
  /** Where a session may be written, best first. Session mode never includes localStorage; persistent mode falls back if localStorage is blocked. */
  const candidates = (): KV[] => (readSessionMode(local) === "session" ? [session, mem] : [local, session, mem]).filter((s): s is KV => s !== null);
  return {
    getItem(k) { for (const s of [...candidates(), ...all()]) { const v = attempt(() => s.getItem(k), null); if (v !== null) return v; } return null; },
    setItem(k, v) {
      let home: KV | null = null;
      for (const s of candidates()) { if (attempt(() => { s.setItem(k, v); return true; }, false)) { home = s; break; } }
      for (const s of all()) if (s !== home) attempt(() => s.removeItem(k), undefined);        // never leave a copy in the storage the user did not choose
    },
    removeItem(k) { for (const s of all()) attempt(() => s.removeItem(k), undefined); },
  };
}
