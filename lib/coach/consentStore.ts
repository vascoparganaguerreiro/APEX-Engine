// Coach consent storage, scoped to ONE signed-in account. Pure logic (no React, no window) so every account transition is unit-testable;
// components/coach/consent.tsx only wires it to useAuth and localStorage.
//
// Rules:
//   - The key is "apex.coach.consent.v1:<uid>" and the stored value also names its owner; a value is only ever loaded for that uid.
//   - No uid (signed out, auth still loading, malformed id) means NO consent and nothing is read or written.
//   - The old shared key "apex.coach.consent.v1" has no known owner: it is never read or migrated, only removed.
//   - Missing, unparsable, foreign or invalid values, or unavailable storage, all mean NO consent (fail closed).
//   - Consent is "ready" only once the CURRENT uid's value has been loaded. A value loaded for a previous uid is never exposed, so on
//     sign-out or an account switch the in-memory consent is gone in the same render.
//   - Sign-out keeps each account's own stored choice for its next sign-in on this browser (it is that user's own decision); it is
//     never visible to any other account.
// This does NOT synchronise consent across devices or browsers: each browser keeps its own copy.
import { CATEGORIES, type Category } from "./schema.ts";

export interface Consent { accepted: boolean; categories: Category[] }
export interface ConsentStorage { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
/** What the hook holds: the consent and the uid it was loaded for (null = nothing loaded). */
export interface ConsentState { uid: string | null; consent: Consent }

export const LEGACY_CONSENT_KEY = "apex.coach.consent.v1";
export const NO_CONSENT: Consent = Object.freeze({ accepted: false, categories: [] }) as Consent;
export const EMPTY_CONSENT_STATE: ConsentState = { uid: null, consent: NO_CONSENT };
/** The general Coach does not use strength logs (Ask APEX has its own consent), so that switch is not offered or kept. */
export const COACH_CATEGORIES = CATEGORIES.filter((c) => c !== "strength");

const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A Supabase user id (UUID), or null for anything else. */
export const validUid = (uid: unknown): string | null => (typeof uid === "string" && UID.test(uid) ? uid.toLowerCase() : null);
export const consentKey = (uid: string) => `${LEGACY_CONSENT_KEY}:${uid}`;

/** Keeps only known Coach categories, once each, in a stable order. */
const clean = (c: Consent): Consent => ({
  accepted: c.accepted === true,
  categories: COACH_CATEGORIES.filter((x) => Array.isArray(c.categories) && c.categories.includes(x)),
});

/** Parse a stored value for `uid`. Anything that is not exactly that user's valid record is NO consent. */
export function parseConsent(raw: string | null, uid: string): Consent {
  if (!raw) return NO_CONSENT;
  try {
    const v = JSON.parse(raw) as { uid?: unknown; accepted?: unknown; categories?: unknown } | null;
    if (!v || typeof v !== "object" || v.uid !== uid || typeof v.accepted !== "boolean" || !Array.isArray(v.categories)) return NO_CONSENT;
    return clean({ accepted: v.accepted, categories: v.categories as Category[] });
  } catch { return NO_CONSENT; }
}

/** Load the consent of `uid` (removing the ownerless legacy key). No uid or no storage: an empty state / NO consent. */
export function loadConsentState(storage: ConsentStorage | null, uid: string | null | undefined): ConsentState {
  const id = validUid(uid);
  if (!id) return EMPTY_CONSENT_STATE;
  if (!storage) return { uid: id, consent: NO_CONSENT };
  try { storage.removeItem(LEGACY_CONSENT_KEY); } catch { /* best effort */ }
  let raw: string | null = null;
  try { raw = storage.getItem(consentKey(id)); } catch { raw = null; }
  return { uid: id, consent: parseConsent(raw, id) };
}

/** What a component may use right now: only the CURRENT user's loaded consent; otherwise NO consent and not ready. */
export function consentView(state: ConsentState, currentUid: string | null | undefined): { consent: Consent; ready: boolean } {
  const id = validUid(currentUid);
  return id && state.uid === id ? { consent: state.consent, ready: true } : { consent: NO_CONSENT, ready: false };
}

/** Save a change for the current user. Ignored (null) unless that user's consent is loaded, so a change made while loading or after an
 *  account switch can never be written under the wrong account. Storage failures keep the choice for this page only. */
export function saveConsentState(storage: ConsentStorage | null, state: ConsentState, currentUid: string | null | undefined, next: Consent): ConsentState | null {
  const id = validUid(currentUid);
  if (!id || state.uid !== id) return null;
  const consent = clean(next);
  try { storage?.setItem(consentKey(id), JSON.stringify({ uid: id, ...consent })); } catch { /* kept in memory only */ }
  return { uid: id, consent };
}

/** What may actually be sent: nothing unless the user has accepted. */
export const authorizedOf = (c: Consent): Category[] => (c.accepted ? c.categories : []);
