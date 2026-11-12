// Ask APEX consent, scoped to ONE signed-in account. Pure logic (no React, no window), same rules as lib/coach/consentStore.ts:
//   - key "apex-askapex-consent-v1:<uid>", and the stored value names its owner; it is only ever loaded for that uid.
//   - no / malformed uid: nothing is read or written, nothing is shared, not ready.
//   - the old shared key has no known owner: never read or migrated, only removed.
//   - missing, invalid, foreign or unavailable storage: nothing shared (fail closed).
//   - a state loaded for a previous uid is never exposed for the current one (view is keyed to the current uid).
// Not synchronised across devices or browsers.
import { validUid, type ConsentStorage } from "../coach/consentStore.ts";

export interface AskConsent { strength: boolean; profile: boolean; speak: boolean }
export interface AskConsentState { uid: string | null; consent: AskConsent }

export const ASK_LEGACY_KEY = "apex-askapex-consent-v1";
export const NO_ASK_CONSENT: AskConsent = Object.freeze({ strength: false, profile: false, speak: false }) as AskConsent;
export const EMPTY_ASK_STATE: AskConsentState = { uid: null, consent: NO_ASK_CONSENT };
export const askConsentKey = (uid: string) => `${ASK_LEGACY_KEY}:${uid}`;

export function parseAskConsent(raw: string | null, uid: string): AskConsent {
  if (!raw) return NO_ASK_CONSENT;
  try {
    const v = JSON.parse(raw) as { uid?: unknown; strength?: unknown; profile?: unknown; speak?: unknown } | null;
    if (!v || typeof v !== "object" || v.uid !== uid) return NO_ASK_CONSENT;
    return { strength: v.strength === true, profile: v.profile === true, speak: v.speak === true };
  } catch { return NO_ASK_CONSENT; }
}

/** Load the consent of `uid` (removing the ownerless legacy key). */
export function loadAskConsent(storage: ConsentStorage | null, uid: string | null | undefined): AskConsentState {
  const id = validUid(uid);
  if (!id) return EMPTY_ASK_STATE;
  if (!storage) return { uid: id, consent: NO_ASK_CONSENT };
  try { storage.removeItem(ASK_LEGACY_KEY); } catch { /* best effort */ }
  let raw: string | null = null;
  try { raw = storage.getItem(askConsentKey(id)); } catch { raw = null; }
  return { uid: id, consent: parseAskConsent(raw, id) };
}

/** Only the CURRENT user's loaded consent; otherwise nothing shared and not ready. `owner` is the account the consent belongs to. */
export function askConsentView(state: AskConsentState, currentUid: string | null | undefined): { consent: AskConsent; ready: boolean; owner: string | null } {
  const id = validUid(currentUid);
  return id && state.uid === id ? { consent: state.consent, ready: true, owner: state.uid } : { consent: NO_ASK_CONSENT, ready: false, owner: null };
}

/** Ignored (null) unless the current user's consent is loaded, so nothing is ever written under the wrong account. */
export function saveAskConsent(storage: ConsentStorage | null, state: AskConsentState, currentUid: string | null | undefined, next: AskConsent): AskConsentState | null {
  const id = validUid(currentUid);
  if (!id || state.uid !== id) return null;
  const consent: AskConsent = { strength: next.strength === true, profile: next.profile === true, speak: next.speak === true };
  try { storage?.setItem(askConsentKey(id), JSON.stringify({ uid: id, ...consent })); } catch { /* kept in memory only */ }
  return { uid: id, consent };
}
