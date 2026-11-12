import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAuthStorage, writeSessionMode, type KV } from "./authStorage";
import { SafeError } from "./userError";

let client: SupabaseClient | null = null;

const browserStore = (which: "localStorage" | "sessionStorage"): KV | null => { try { return typeof window === "undefined" ? null : window[which]; } catch { return null; } };

/** "Remember me" on the login page: true keeps the session across browser restarts (the default), false keeps it only until the tab or browser
 *  is closed. Call it right BEFORE signing in. The session is then stored where the choice says, including every later token refresh. */
export function setRememberMe(remember: boolean): void { writeSessionMode(browserStore("localStorage"), remember ? "persistent" : "session"); }

/** One Supabase client for the browser. Created on first use so a missing variable
 *  shows a clear message instead of breaking the build. Sessions are persisted and refreshed automatically (supabase-js defaults), through
 *  the storage adapter of lib/authStorage.ts, so "Remember me" can choose where they live. */
export function getSupabase(): SupabaseClient {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) {
      // Configuration problem (the two public Supabase variables are not set for this deployment). Nothing about it is shown to the person using
      // the app: the person who runs APEX finds it in the deployment settings.
      throw new SafeError("other", "The app can't start right now. Please try again later.", false);
    }
    client = typeof window === "undefined"
      ? createClient(url, key)
      : createClient(url, key, { auth: { storage: createAuthStorage(browserStore("localStorage"), browserStore("sessionStorage")) } });
  }
  return client;
}
