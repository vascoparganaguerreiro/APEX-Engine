// Progressive disclosure helpers (UI/UX Phase 3B). Pure: no React, no storage, no network.
//
// A collapsed section must never hide something the user has to see. Two rules keep that true:
//   * the summary line always says what is inside (how much is filled in, or the connection status), and
//   * a section is forced open whenever it holds a problem the user must act on (a failed save, a connection error).

/** True for a value the user has actually entered: a non-blank string, a non-empty list, a finite number or true. */
export function isSet(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "number") return Number.isFinite(v);
  return true;
}
/** How many of the given values are set. */
export const countSet = (values: unknown[]): number => values.filter(isSet).length;
/** "2 of 4 set" or "None set", never a guess: it only counts what is in the form. */
export const setSummary = (n: number, total: number): string => (n <= 0 ? "None set" : `${n} of ${total} set`);

/** Open state of a disclosure: a section that holds a problem is open and stays open; otherwise the user's own choice (or the default) applies. */
export const effectiveOpen = (userOpen: boolean, forced: boolean): boolean => forced || userOpen;

/** Connection statuses that need the user's attention. A provider in one of these states is never shown collapsed-and-silent. */
export const NEEDS_ATTENTION = ["reauth_required", "error"] as const;
export const needsAttention = (status: string | null | undefined, lastError?: string | null): boolean => !!lastError || (NEEDS_ATTENTION as readonly string[]).includes(status ?? "");
