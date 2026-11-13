// Small pure helpers for the live workout header (components/strength/WorkoutHeader.tsx). No React, no storage.

/** The one-line context under the title: progress, what you are on, and what is next. Facts the workout already has; nothing is inferred. */
export function contextLine(a: { done: number; total: number; current: string | null; next: string | null }): string {
  const parts = [`${a.done}/${a.total} sets`];
  if (a.current) parts.push(`Now: ${a.current}`);
  if (a.next) parts.push(`Next: ${a.next}`);
  return parts.join(" · ");
}

/** Which menu item gets focus after a key press in an open menu (the standard menu keys): arrows move and wrap, Home and End jump. null = not a menu key. */
export function menuFocusIndex(current: number, count: number, key: string): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown": return (current + 1 + count) % count;
    case "ArrowUp": return (current - 1 + count) % count;
    case "Home": return 0;
    case "End": return count - 1;
    default: return null;
  }
}
