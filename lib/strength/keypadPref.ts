// Which keyboard the live workout uses on a phone: the APEX keypad (the default) or the phone's own keyboard. Kept for THAT account in this browser.
// Pure logic (no React, no window); lib/strength/useKeypadPref.ts wires it to useAuth and localStorage. Same pattern as the experience choice
// (lib/experience.ts) and the Coach consent (lib/coach/consentStore.ts):
//   - key "apex.keypad.v1:<uid>", and the stored value also names its owner; a value is only ever loaded for that uid;
//   - no uid (signed out, auth loading, malformed id) means "not ready": the phone keyboard is used and nothing is read or written;
//   - a missing, unparsable, foreign or invalid value means the default (the APEX keypad);
//   - a choice loaded for a previous account is never exposed after a switch; a change is ignored unless the current account's choice is loaded.
// Not synchronised across devices: each browser keeps its own copy.
import { validUid } from "../coach/consentStore.ts";

export interface KeypadPrefStorage { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
export const keypadPrefKey = (uid: string) => `apex.keypad.v1:${uid}`;
/** What the hook holds: whether this account chose the phone keyboard ("native"), and the uid that was loaded for (null = nothing loaded). */
export interface KeypadPrefState { uid: string | null; native: boolean }
export const EMPTY_KEYPAD_PREF: KeypadPrefState = Object.freeze({ uid: null, native: false }) as KeypadPrefState;

/** True only for a record that says, for exactly this uid, that the phone keyboard is wanted. Anything else is the default. */
export function parseKeypadPref(raw: string | null, uid: string): boolean {
  if (!raw) return false;
  try { const v = JSON.parse(raw) as { uid?: unknown; native?: unknown } | null; return !!v && typeof v === "object" && v.uid === uid && v.native === true; } catch { return false; }
}

export function loadKeypadPrefState(storage: KeypadPrefStorage | null, uid: string | null | undefined): KeypadPrefState {
  const id = validUid(uid);
  if (!id) return EMPTY_KEYPAD_PREF;
  let raw: string | null = null;
  try { raw = storage?.getItem(keypadPrefKey(id)) ?? null; } catch { raw = null; }
  return { uid: id, native: parseKeypadPref(raw, id) };
}

/** What a component may use right now: only the CURRENT user's loaded choice; otherwise not ready (and the phone keyboard is used). */
export function keypadPrefView(state: KeypadPrefState, currentUid: string | null | undefined): { native: boolean; ready: boolean } {
  const id = validUid(currentUid);
  return id && state.uid === id ? { native: state.native, ready: true } : { native: false, ready: false };
}

/** Save the current user's choice. Choosing the default (the APEX keypad) removes the stored value. Ignored (null) unless that user's choice is loaded.
 *  Storage failures keep the choice for this page only. */
export function saveKeypadPrefState(storage: KeypadPrefStorage | null, state: KeypadPrefState, currentUid: string | null | undefined, native: boolean): KeypadPrefState | null {
  const id = validUid(currentUid);
  if (!id || state.uid !== id) return null;
  try { if (native) storage?.setItem(keypadPrefKey(id), JSON.stringify({ uid: id, native: true })); else storage?.removeItem(keypadPrefKey(id)); } catch { /* kept in memory only */ }
  return { uid: id, native };
}

/** The one rule for when the APEX keypad replaces the native inputs: a LIVE workout, on a phone layout, with this account's choice loaded and not "phone keyboard". */
export const keypadActive = (a: { live: boolean; phone: boolean; ready: boolean; native: boolean }): boolean => a.live && a.phone && a.ready && !a.native;
