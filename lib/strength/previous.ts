// "Previous" for the compact set table: what you did on each set the last time you did this exercise. Pure; it only reads history that already exists.
//
// lastPerformance (analytics.ts) gives the completed sets of the last session that had THIS exercise (matched by its key, so a different exercise is never
// compared). Here they are lined up with the sets of the current exercise by KIND and SIDE, each kind in order:
//   - warm-up sets with warm-up sets, every other set type with the other types;
//   - for a one-sided exercise, left with left and right with right. A set whose side does not match, or whose side is unknown (history saved before sides were
//     kept, or a set with no side against one with a side), gets NO previous value. Nothing is guessed across sides, and a finished set from last time is never
//     moved onto a neighbouring slot just because another set was skipped.
// A set with nothing to compare against gets null and shows as empty. Nothing is estimated or carried over from a different kind of set.
import { fmtHSet, type HSet } from "./analytics.ts";
import type { LoadMode, SetType } from "./types.ts";

type Side = "left" | "right" | null;
const sideOf = (s: { side?: Side | undefined }): Side => s.side ?? null;
const slot = (s: { type: SetType; side?: Side | undefined }) => `${s.type === "warmup" ? "warmup" : "work"}|${sideOf(s) ?? "none"}`;

/** One entry per set of `sets` (in the order given): the matching set from `prev`, or null. */
export function previousPerSet(prev: readonly HSet[] | null | undefined, sets: ReadonlyArray<{ type: SetType; side?: Side | undefined }>): Array<HSet | null> {
  const pools = new Map<string, HSet[]>();
  for (const p of prev ?? []) { const k = slot(p); (pools.get(k) ?? pools.set(k, []).get(k)!).push(p); }
  const used = new Map<string, number>();
  return sets.map((s) => { const k = slot(s), i = used.get(k) ?? 0; used.set(k, i + 1); return pools.get(k)?.[i] ?? null; });
}

/** Short text for the Previous column, for example "80×8" or "60 lb×10" or "45s". No effort rating (RPE) here: it stays in the set's details. */
export function previousLabel(h: HSet | null, mode: LoadMode): string {
  return h === null ? "" : fmtHSet(h, mode).replace(/@[\d.]+$/, "");
}
