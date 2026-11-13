"use client";
import { useEffect, useRef, useState } from "react";
import { actionFromKey, isIntegerField, showText, type ActiveField, type KeypadAction, type KeypadKey } from "@/lib/strength/keypad";
import { opensKeyboard } from "@/lib/nav";

/** The decimal separator of the person's language ("," or "."). Display only: the keypad's text always uses "." inside. */
const separator = (): "." | "," => { try { return (1.5).toLocaleString().includes(",") ? "," : "."; } catch { return "."; } };

/** The APEX numeric keypad, docked at the bottom of the live workout on a phone. It owns no workout logic: every key goes to `onAction`
 *  (components/strength/WorkoutEditor.tsx -> lib/strength/keypad.ts). It never takes focus from the field being edited (keys do not move focus), publishes its
 *  height as --kp-h, and marks the page with `kp-open` so the bottom bar and floating buttons step aside (app/globals.css). */
export default function NumKeypad({ target, title, text, nextLabel, onAction, onUseNative }: {
  target: ActiveField; title: string; text: string; nextLabel: "Next" | "Done"; onAction: (a: KeypadAction) => void; onUseNative: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [sep, setSep] = useState<"." | ",">(".");
  const integer = isIntegerField(target.field);
  useEffect(() => setSep(separator()), []);
  useEffect(() => {
    const el = box.current, root = document.documentElement;
    root.classList.add("kp-open");
    if (!el) return () => root.classList.remove("kp-open");
    const set = () => root.style.setProperty("--kp-h", `${el.offsetHeight}px`);
    set();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(set);
    ro?.observe(el);
    return () => { ro?.disconnect(); root.classList.remove("kp-open"); root.style.removeProperty("--kp-h"); };
  }, []);
  // A hardware keyboard works too: digits, "." or ",", Backspace, Delete (clear), Enter (next), Escape (close). Only when the focus is on the page, a number cell or
  // the keypad, never while typing in a text box or on another button (so Enter still presses that button).
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t && opensKeyboard(t as HTMLElement)) return;
      if (t && t !== document.body && !t.closest(".numcell, .kp")) return;
      const a = actionFromKey(e.key);
      if (!a) return;
      e.preventDefault(); onAction(a);
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, [onAction]);

  const key = (k: KeypadKey, label: string, aria: string, cls = "", disabled = false) => (
    <button type="button" key={k} data-k={k} className={`kp-key ${cls}`} aria-label={aria} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => onAction(k)}>{label}</button>
  );
  return (
    <div ref={box} className="kp" role="group" aria-label="Number keypad">
      <div className="kp-head">
        <span className="kp-title">{title}</span>
        <output className="kp-value" aria-live="polite" aria-atomic="true">{text === "" ? "–" : showText(text, sep)}</output>
        <button type="button" className="kp-link" onMouseDown={(e) => e.preventDefault()} onClick={onUseNative}>Phone keyboard</button>
        <button type="button" className="kp-x" aria-label="Close keypad" onMouseDown={(e) => e.preventDefault()} onClick={() => onAction("close")}>✕</button>
      </div>
      <div className="kp-keys">
        {(["1", "2", "3"] as const).map((d) => key(d, d, d))}
        {key("backspace", "⌫", "Backspace", "kp-fn")}
        {(["4", "5", "6"] as const).map((d) => key(d, d, d))}
        {key("clear", "C", "Clear", "kp-fn")}
        {(["7", "8", "9"] as const).map((d) => key(d, d, d))}
        <button type="button" data-k="next" className="kp-key kp-next" aria-label={nextLabel === "Next" ? "Next field" : "Done, close keypad"} onMouseDown={(e) => e.preventDefault()} onClick={() => onAction("next")}>{nextLabel}</button>
        {key(".", sep, sep === "," ? "Decimal comma" : "Decimal point", "kp-dec", integer)}
        {key("0", "0", "0", "kp-zero")}
      </div>
    </div>
  );
}
