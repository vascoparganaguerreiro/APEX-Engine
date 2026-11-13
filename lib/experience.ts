// The experience the signed-in person chose for APEX (Performance, Health & Wellness or Longevity), kept for THAT account in this browser.
// Pure logic (no React, no window) so every account transition is unit-testable; lib/useExperience.ts only wires it to useAuth and localStorage.
//
// This only decides which existing Today modules come first (lib/today/lens.ts). It changes no calculation, no interpretation and no data, and
// it never hides a module: every card stays on Today, and every page stays in the navigation.
//
// Storage follows the Coach consent store (lib/coach/consentStore.ts), the app's existing per-account preference pattern:
//   - key "apex.experience.v1:<uid>", and the stored value also names its owner; a value is only ever loaded for that uid;
//   - no uid (signed out, auth loading, malformed id) means "no choice" and nothing is read or written;
//   - a missing, unparsable, foreign or unknown value means "no choice" (the app then falls back to the goal, then to the default view);
//   - a choice loaded for a previous account is never exposed after a switch; a change is ignored unless the current account's choice is loaded.
// It is NOT synchronised across devices: each browser keeps its own copy. (Syncing would need a profile column, i.e. a database migration.)
import type { Lens } from "./today/lens.ts";
import { lensFromGoal } from "./today/lens.ts";
import { validUid } from "./coach/consentStore.ts";

export interface ExperienceStorage { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
export const EXPERIENCES: readonly Lens[] = ["performance", "wellness", "longevity"];
export const isExperience = (v: unknown): v is Lens => typeof v === "string" && (EXPERIENCES as readonly string[]).includes(v);

/** What each experience brings first on Today. Only modules and metrics APEX already has: nothing is promised that is not there. */
export const EXPERIENCE_INFO: Record<Lens, { label: string; short: string; focus: string }> = {
  performance: { label: "Performance", short: "Training, readiness, load and races", focus: "Readiness, training form and weekly load come first, then your training and races." },
  wellness: { label: "Health & Wellness", short: "Sleep, activity, energy and habits", focus: "Sleep, recovery and consistency come first, then your daily wellness and supplements." },
  longevity: { label: "Longevity", short: "VO2max, functional strength, mobility and biomarkers", focus: "Biomarkers and strength come first, then sleep and recovery signals. VO2max is a baseline in your Profile; APEX has no mobility measurement yet." },
};

export const experienceKey = (uid: string) => `apex.experience.v1:${uid}`;
/** What the hook holds: the choice (null = none) and the uid it was loaded for (null = nothing loaded). */
export interface ExperienceState { uid: string | null; choice: Lens | null }
export const EMPTY_EXPERIENCE_STATE: ExperienceState = { uid: null, choice: null };

/** Parse a stored value for `uid`; anything that is not exactly that user's valid record is "no choice". */
export function parseExperience(raw: string | null, uid: string): Lens | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { uid?: unknown; lens?: unknown } | null;
    return v && typeof v === "object" && v.uid === uid && isExperience(v.lens) ? v.lens : null;
  } catch { return null; }
}

export function loadExperienceState(storage: ExperienceStorage | null, uid: string | null | undefined): ExperienceState {
  const id = validUid(uid);
  if (!id) return EMPTY_EXPERIENCE_STATE;
  let raw: string | null = null;
  try { raw = storage?.getItem(experienceKey(id)) ?? null; } catch { raw = null; }
  return { uid: id, choice: parseExperience(raw, id) };
}

/** What a component may use right now: only the CURRENT user's loaded choice; otherwise no choice and not ready. */
export function experienceView(state: ExperienceState, currentUid: string | null | undefined): { choice: Lens | null; ready: boolean } {
  const id = validUid(currentUid);
  return id && state.uid === id ? { choice: state.choice, ready: true } : { choice: null, ready: false };
}

/** Save (or, with null, clear) the current user's choice. Ignored (null) unless that user's choice is loaded, so a change made while loading or after an
 *  account switch can never be written under the wrong account. Storage failures keep the choice for this page only. */
export function saveExperienceState(storage: ExperienceStorage | null, state: ExperienceState, currentUid: string | null | undefined, next: Lens | null): ExperienceState | null {
  const id = validUid(currentUid);
  if (!id || state.uid !== id || (next !== null && !isExperience(next))) return null;
  try { if (next === null) storage?.removeItem(experienceKey(id)); else storage?.setItem(experienceKey(id), JSON.stringify({ uid: id, lens: next })); } catch { /* kept in memory only */ }
  return { uid: id, choice: next };
}

/** The view Today uses: the person's own choice first; otherwise the one derived from their goal; otherwise Performance (the layout Today always had). */
export function resolveExperience(choice: Lens | null, goal: string | null | undefined): { lens: Lens; basis: "chosen" | "goal" | "default" } {
  if (choice) return { lens: choice, basis: "chosen" };
  return lensFromGoal(goal);
}
