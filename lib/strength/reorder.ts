// Reordering exercises in the live workout by long-press and drag, or by keyboard. Pure logic (no React, no DOM): the drag state machine, where a drop lands,
// auto-scroll speed and the screen-reader messages. components/strength/useExerciseDrag.ts only connects it to pointer and keyboard events.
//
// The order itself is NEVER changed here. A finished drag asks for one thing: "move this exercise to index N", and the editor does that with the existing
// moveExercise (workout.ts) through the normal save() path, so ids, sets, values, completion and timestamps cannot be touched by dragging.

/** How long a press must stay (nearly) still before it becomes a drag. Until then the page scrolls and clicks as usual. */
export const LONG_PRESS_MS = 250;
/** How far the finger or mouse may wander during that wait. More than this and it was a scroll or a swipe, not a long press. */
export const MOVE_TOLERANCE_PX = 5;
/** Near the top or bottom edge of the screen a drag scrolls the page; the speed grows towards the edge. */
export const EDGE_PX = 72;
export const MAX_SCROLL_PX = 18;

export const pressMoved = (x0: number, y0: number, x: number, y: number, tolerance = MOVE_TOLERANCE_PX): boolean => Math.hypot(x - x0, y - y0) > tolerance;

/** The index the dragged exercise ends up at: the number of OTHER exercises whose middle is above the pointer. This is exactly the `toIndex` of moveExercise
 *  (take it out of the list, put it back at that index). */
export function targetIndex(otherMidpoints: readonly number[], y: number): number {
  let n = 0;
  for (const m of otherMidpoints) if (m < y) n++;
  return n;
}

/** Which exercise the insertion line is drawn above (null = after the last one) when the dragged exercise would land at `to`. */
export function indicatorBefore(ids: readonly string[], draggedId: string, to: number): string | null {
  return ids.filter((x) => x !== draggedId)[to] ?? null;
}

/** Pixels to scroll this frame: negative near the top edge, positive near the bottom edge, 0 elsewhere. */
export function scrollSpeed(y: number, viewportHeight: number, edge = EDGE_PX, max = MAX_SCROLL_PX): number {
  if (y < edge) return -Math.round(max * Math.min(1, (edge - y) / edge));
  if (y > viewportHeight - edge) return Math.round(max * Math.min(1, (y - (viewportHeight - edge)) / edge));
  return 0;
}

/** The keyboard way to move a picked-up exercise: where the arrow, Home or End key sends it (null = not a move key). */
export function keyMove(to: number, count: number, key: string): number | null {
  switch (key) {
    case "ArrowUp": return Math.max(0, to - 1);
    case "ArrowDown": return Math.min(count - 1, to + 1);
    case "Home": return 0;
    case "End": return count - 1;
    default: return null;
  }
}

/** Spoken for screen-reader users. Positions are counted from 1. */
export const announce = {
  pickedUp: (name: string, at: number, n: number) => `Picked up ${name}, position ${at} of ${n}. Use the arrow keys to move, Space to drop, Escape to cancel.`,
  moved: (name: string, at: number, n: number) => `${name}, position ${at} of ${n}.`,
  dropped: (name: string, at: number, n: number) => `Dropped ${name} at position ${at} of ${n}.`,
  unchanged: (name: string, at: number, n: number) => `Dropped ${name}. It stays at position ${at} of ${n}.`,
  cancelled: (name: string, at: number, n: number) => `Reorder cancelled. ${name} is at position ${at} of ${n}.`,
};

// ------------------------------------------------------------------ the drag state machine
export type DragMode = "pointer" | "keyboard";
export interface DragState {
  phase: "idle" | "pressing" | "dragging";
  id: string | null; from: number; to: number; x0: number; y0: number; mode: DragMode;
}
export const IDLE: DragState = Object.freeze({ phase: "idle", id: null, from: -1, to: -1, x0: 0, y0: 0, mode: "pointer" }) as DragState;

export type DragEvent =
  | { type: "press"; id: string; index: number; x: number; y: number }   // pointer down on an exercise header
  | { type: "activate" }                                                  // the long-press timer fired
  | { type: "move"; x: number; y: number; to?: number }                   // pointer moved (to = where it would land, only while dragging)
  | { type: "release" }                                                   // pointer up
  | { type: "cancel" }                                                    // pointercancel, Escape, blur, workout changed
  | { type: "kbStart"; id: string; index: number }                        // keyboard: pick up
  | { type: "kbMove"; to: number }                                        // keyboard: arrow keys
  | { type: "kbDrop" };                                                   // keyboard: Space or Enter again
export type DragEffect = "activated" | "abort" | "tap" | "commit" | "cancelled" | null;
export interface DragStep { state: DragState; effect: DragEffect; /** set with "commit": what to move where */ drop?: { id: string; from: number; to: number } }

/** One step of the machine. A drag only becomes real after the long press; moving too far first aborts it (so scrolling is untouched); only a release or
 *  Space while dragging commits; every cancel route (pointercancel, Escape, blur) leaves the order exactly as it was. */
export function step(s: DragState, e: DragEvent): DragStep {
  const idle = (effect: DragEffect, drop?: DragStep["drop"]): DragStep => ({ state: IDLE, effect, drop });
  switch (e.type) {
    case "press": return s.phase === "idle" ? { state: { phase: "pressing", id: e.id, from: e.index, to: e.index, x0: e.x, y0: e.y, mode: "pointer" }, effect: null } : { state: s, effect: null };
    case "activate": return s.phase === "pressing" && s.mode === "pointer" ? { state: { ...s, phase: "dragging" }, effect: "activated" } : { state: s, effect: null };
    case "move":
      if (s.phase === "pressing") return pressMoved(s.x0, s.y0, e.x, e.y) ? idle("abort") : { state: s, effect: null };
      if (s.phase === "dragging" && s.mode === "pointer" && e.to !== undefined && e.to !== s.to) return { state: { ...s, to: e.to }, effect: null };
      return { state: s, effect: null };
    case "release":
      if (s.phase === "pressing") return idle("tap");
      if (s.phase === "dragging" && s.mode === "pointer") return idle("commit", { id: s.id!, from: s.from, to: s.to });
      return { state: s, effect: null };
    case "cancel": return s.phase === "idle" ? { state: s, effect: null } : idle("cancelled");
    case "kbStart": return s.phase === "idle" ? { state: { phase: "dragging", id: e.id, from: e.index, to: e.index, x0: 0, y0: 0, mode: "keyboard" }, effect: "activated" } : { state: s, effect: null };
    case "kbMove": return s.phase === "dragging" && s.mode === "keyboard" && e.to !== s.to ? { state: { ...s, to: e.to }, effect: null } : { state: s, effect: null };
    case "kbDrop": return s.phase === "dragging" && s.mode === "keyboard" ? idle("commit", { id: s.id!, from: s.from, to: s.to }) : { state: s, effect: null };
  }
}
