"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { IDLE, LONG_PRESS_MS, announce, indicatorBefore, keyMove, scrollSpeed, step, targetIndex, type DragEvent, type DragState, type DragStep } from "@/lib/strength/reorder";

export interface Ghost { left: number; width: number; offY: number; x: number; y: number }

/** Connects lib/strength/reorder.ts (the logic) to the page: a long press on an exercise header starts a drag (mouse or touch), a picked-up exercise can also be moved
 *  with the keyboard from its grip button. It never changes the workout itself: a finished drag calls `onDrop(id, toIndex)`, and the editor does the move with the
 *  existing moveExercise and its normal save. While nothing is pressed it adds no listeners, so scrolling and clicking are untouched. */
export function useExerciseDrag({ enabled, ids, names, onDrop, onStart }: {
  enabled: boolean; ids: readonly string[]; names: Readonly<Record<string, string>>; onDrop: (id: string, to: number) => void; onStart?: () => void;
}) {
  const [drag, setDrag] = useState<DragState>(IDLE);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [message, setMessage] = useState("");
  const state = useRef<DragState>(IDLE), cards = useRef(new Map<string, HTMLElement>());
  const live = useRef({ ids, names, onDrop, onStart, enabled });
  live.current = { ids, names, onDrop, onStart, enabled };
  const timer = useRef<number | null>(null), scroller = useRef<number | null>(null), cleanup = useRef<(() => void) | null>(null), pointer = useRef({ x: 0, y: 0 });

  const apply = (e: DragEvent): DragStep => { const r = step(state.current, e); state.current = r.state; setDrag(r.state); return r; };
  const nameOf = (id: string) => live.current.names[id] ?? "exercise";
  const total = () => live.current.ids.length;

  /** Where the dragged exercise would land for a pointer at height `y`: the same number of exercises above it as moveExercise counts. */
  const toIndexAt = (y: number, dragged: string) => targetIndex(
    live.current.ids.filter((i) => i !== dragged).map((i) => { const b = cards.current.get(i)?.getBoundingClientRect(); return b ? b.top + b.height / 2 : Number.POSITIVE_INFINITY; }), y);

  const stop = () => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    if (scroller.current !== null) { window.clearInterval(scroller.current); scroller.current = null; }
    cleanup.current?.(); cleanup.current = null;
    document.documentElement.classList.remove("exc-dragging"); setGhost(null);
  };
  /** Carry out what a step decided. A commit with an unchanged position moves nothing. */
  const settle = (r: DragStep) => {
    if (r.effect === "commit" && r.drop) {
      const { id, from, to } = r.drop, n = total();
      if (to !== from) live.current.onDrop(id, to);
      setMessage(to === from ? announce.unchanged(nameOf(id), to + 1, n) : announce.dropped(nameOf(id), to + 1, n));
    }
    if (r.effect === "commit" || r.effect === "cancelled" || r.effect === "abort" || r.effect === "tap") stop();
  };
  const cancel = useCallback(() => {
    const before = state.current;
    const r = apply({ type: "cancel" });
    if (before.phase === "dragging" && before.id) setMessage(announce.cancelled(nameOf(before.id), before.from + 1, total()));
    settle(r);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Near the top or bottom edge the page scrolls by itself (about 60 times a second) so a far-away position can be reached without letting go. */
  const autoScroll = () => {
    scroller.current = window.setInterval(() => {
      if (state.current.phase !== "dragging" || state.current.mode !== "pointer") return;
      const dy = scrollSpeed(pointer.current.y, window.innerHeight);
      if (!dy) return;
      window.scrollBy(0, dy);
      const to = toIndexAt(pointer.current.y, state.current.id!);
      if (to !== state.current.to) apply({ type: "move", x: pointer.current.x, y: pointer.current.y, to });
    }, 16);
  };

  /** Props for an exercise header: press and hold to drag. Buttons, fields and links inside it keep working as normal (the grip button is the exception). */
  const headProps = (id: string, index: number) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (!live.current.enabled || state.current.phase !== "idle") return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.closest("button,input,select,textarea,a,summary") && !t.closest("[data-grip]")) return;
      apply({ type: "press", id, index, x: e.clientX, y: e.clientY });
      pointer.current = { x: e.clientX, y: e.clientY };
      const box = cards.current.get(id)?.getBoundingClientRect();
      const move = (ev: PointerEvent) => {
        pointer.current = { x: ev.clientX, y: ev.clientY };
        const dragging = state.current.phase === "dragging";
        const r = apply({ type: "move", x: ev.clientX, y: ev.clientY, to: dragging ? toIndexAt(ev.clientY, id) : undefined });
        if (r.effect) settle(r); else if (dragging) setGhost((g) => (g ? { ...g, x: ev.clientX, y: ev.clientY } : g));
      };
      const up = () => settle(apply({ type: "release" }));
      const abort = () => cancel();
      const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") cancel(); };
      const block = (ev: TouchEvent) => { if (state.current.phase === "dragging") ev.preventDefault(); };   // once it is a drag, the finger moves the exercise, not the page
      const menu = (ev: Event) => { ev.preventDefault(); };                                                   // no context menu from the long press
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", abort);
      window.addEventListener("keydown", key); window.addEventListener("blur", abort); window.addEventListener("touchmove", block, { passive: false }); window.addEventListener("contextmenu", menu);
      cleanup.current = () => {
        window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", abort);
        window.removeEventListener("keydown", key); window.removeEventListener("blur", abort); window.removeEventListener("touchmove", block); window.removeEventListener("contextmenu", menu);
      };
      timer.current = window.setTimeout(() => {
        timer.current = null;
        const r = apply({ type: "activate" });
        if (r.effect !== "activated") return;
        try { navigator.vibrate?.(15); } catch { /* optional: not every device can vibrate */ }
        live.current.onStart?.();
        document.documentElement.classList.add("exc-dragging");
        setGhost({ left: box?.left ?? 0, width: box?.width ?? 0, offY: box ? pointer.current.y - box.top : 0, x: pointer.current.x, y: pointer.current.y });
        setMessage(announce.pickedUp(nameOf(id), index + 1, total()));
        autoScroll();
      }, LONG_PRESS_MS);
    },
  });

  /** Props for the grip button of an exercise: the keyboard alternative. Space or Enter picks it up, arrows move it, Space or Enter drops, Escape cancels. */
  const gripProps = (id: string, index: number) => ({
    "aria-pressed": drag.phase === "dragging" && drag.mode === "keyboard" && drag.id === id,
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      const s = state.current, mine = s.phase === "dragging" && s.mode === "keyboard" && s.id === id;
      if (!mine) {
        if ((e.key === " " || e.key === "Enter") && live.current.enabled && s.phase === "idle") {
          e.preventDefault(); apply({ type: "kbStart", id, index }); live.current.onStart?.(); setMessage(announce.pickedUp(nameOf(id), index + 1, total()));
        }
        return;
      }
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); settle(apply({ type: "kbDrop" })); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); return; }
      const to = keyMove(s.to, total(), e.key);
      if (to !== null) { e.preventDefault(); apply({ type: "kbMove", to }); setMessage(announce.moved(nameOf(id), to + 1, total())); }
    },
    onBlur: () => { if (state.current.phase === "dragging" && state.current.mode === "keyboard") cancel(); },
    onClick: (e: React.MouseEvent) => { e.preventDefault(); },   // a tap on the grip does nothing; keyboard Space and Enter are handled above
  });

  const register = (id: string) => (el: HTMLElement | null) => { if (el) cards.current.set(id, el); else cards.current.delete(id); };

  useEffect(() => { if (!enabled && state.current.phase !== "idle") cancel(); }, [enabled, cancel]);
  useEffect(() => { if (state.current.id && !ids.includes(state.current.id)) cancel(); }, [ids, cancel]);
  useEffect(() => () => stop(), []);   // eslint-disable-line react-hooks/exhaustive-deps

  const dragging = drag.phase === "dragging" && drag.id !== null;
  return {
    drag, ghost, message, headProps, gripProps, register,
    /** The exercise the insertion line is drawn above: an id, null (after the last), or undefined (no drag in progress). */
    marker: dragging ? indicatorBefore(ids, drag.id!, drag.to) : undefined,
    draggedId: dragging ? drag.id : null,
  };
}
