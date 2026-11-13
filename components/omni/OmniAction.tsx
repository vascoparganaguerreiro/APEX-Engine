"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { PHONE_MEDIA } from "@/lib/nav";
import { OMNI_OPEN_EVENT, emitRun, filterActions, isPaletteShortcut, moveIndex, resolveTarget, shortcutLabel, type OmniAction, type OmniId } from "@/lib/omni";

// The one global action entry point. Mounted once in the signed-in layout.
//   phone (<= 800px, or a short touchscreen in landscape): a round button above the bottom bar opens a bottom sheet with every action
//   desktop:          Ctrl+K / Cmd+K (or the button in the sidebar) opens a command palette with search
// Presentation and routing only: each action opens an existing page, form or drawer (lib/omni.ts); nothing is written from here.
const ICON: Record<OmniId, React.ReactNode> = {
  "log-wellness": <path d="M3 12h4l2-5 4 10 2-5h6" />,
  "log-supplements": <><rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-45 12 12)" /><path d="M9.5 9.5l5 5" /></>,
  "add-blood-test": <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" />,
  "start-workout": <path d="M6 8v8M3.5 10v4M18 8v8M20.5 10v4M6 12h12" />,
  "import-strength": <path d="M12 4v10M8 10l4 4 4-4M5 19h14" />,
  "plan-session": <><rect x="4" y="5.5" width="16" height="14" rx="3" /><path d="M8 3.5v4M16 3.5v4M12 12v4M10 14h4" /></>,
  "ask-coach": <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6a2.5 2.5 0 0 1-2.5 2.5H11l-4 3.5V15h-.5A2.5 2.5 0 0 1 5 12.5z" />,
  "evaluate-session": <><circle cx="12" cy="12" r="8" /><path d="M8.5 12.5l2.5 2.5 4.5-5" /></>,
  "sync-activities": <path d="M20 11a8 8 0 0 0-14-4M4 5v4h4M4 13a8 8 0 0 0 14 4M20 19v-4h-4" />,
};
const Svg = ({ children, size = 22 }: { children: React.ReactNode; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>
);

/** Another modal (a drawer or sheet of a page) is already open: the shortcut must not stack a palette on top of it. */
const otherModalOpen = () => !!document.querySelector('[role="dialog"][aria-modal="true"]:not([data-omni])');
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])';

export default function OmniActionHost() {
  const router = useRouter();
  const path = usePathname() ?? "";
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const skipRestore = useRef(false);
  const results = useMemo(() => filterActions(compact ? "" : q), [compact, q]);

  const show = useCallback(() => { setQ(""); setActive(0); skipRestore.current = false; setOpen(true); }, []);
  const close = useCallback(() => setOpen(false), []);

  // phone or desktop layout (same breakpoint as the bottom bar)
  useEffect(() => {
    const mq = window.matchMedia(PHONE_MEDIA);
    const on = () => setCompact(mq.matches);
    on(); mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // Ctrl+K / Cmd+K toggles the palette; it is ignored while a page's own drawer is open so dialogs never stack. The sidebar button asks via an event.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!isPaletteShortcut(e)) return;
      e.preventDefault();
      if (open) { close(); return; }
      if (!otherModalOpen()) show();
    };
    const ask = () => { if (!otherModalOpen()) show(); };
    document.addEventListener("keydown", key); window.addEventListener(OMNI_OPEN_EVENT, ask);
    return () => { document.removeEventListener("keydown", key); window.removeEventListener(OMNI_OPEN_EVENT, ask); };
  }, [open, show, close]);

  useEffect(() => { setOpen(false); }, [path]);

  // focus into the dialog, page scroll locked, focus back to what opened it
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement as HTMLElement | null;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    (compact ? dialog.current?.querySelector<HTMLElement>(".omni-row") : input.current)?.focus();
    return () => {
      document.body.style.overflow = prev;
      if (!skipRestore.current && opener.current && document.contains(opener.current)) opener.current.focus();
    };
  }, [open, compact]);

  function run(a: OmniAction) {
    const t = resolveTarget(a, path);
    skipRestore.current = true;                       // the destination takes the focus, not the button that opened the menu
    setOpen(false);
    if (t.kind === "navigate") router.push(t.href);
    else window.setTimeout(() => emitRun(t.id), 0);   // after this dialog has closed, so the page's drawer gets the focus
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === "Tab") {                            // focus stays inside the dialog
      const f = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (f.length === 0) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const delta = e.key === "ArrowDown" ? 1 : -1;
    if (compact) {
      const rows = [...(dialog.current?.querySelectorAll<HTMLElement>(".omni-row") ?? [])];
      const i = rows.findIndex((r) => r === document.activeElement);
      rows[e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : moveIndex(i < 0 ? 0 : i, delta, rows.length)]?.focus();
    } else {
      setActive((i) => (e.key === "Home" ? 0 : e.key === "End" ? Math.max(results.length - 1, 0) : moveIndex(i, delta, results.length)));
    }
  }

  const act = results[Math.min(active, results.length - 1)] ?? null;
  return (
    <>
      <button type="button" className="omni-fab" aria-label="Quick actions" aria-haspopup="dialog" aria-expanded={open} onClick={show}>
        <Svg size={24}><path d="M12 5v14M5 12h14" /></Svg>
      </button>
      {open && (
        <div className="omni-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div ref={dialog} data-omni className={compact ? "omni omni-sheet" : "omni omni-palette"} role="dialog" aria-modal="true" aria-labelledby="omni-title" onKeyDown={onKeyDown}>
            <div className="omni-head">
              <h2 id="omni-title" className={compact ? "omni-title" : "sr-only"}>Quick actions</h2>
              {compact && <button type="button" className="iconbtn" onClick={close} aria-label="Close">✕</button>}
            </div>
            {!compact && (
              <input ref={input} className="omni-input" type="text" role="combobox" aria-expanded="true" aria-controls="omni-list" aria-autocomplete="list" aria-label="Search actions"
                aria-activedescendant={act ? `omni-opt-${act.id}` : undefined} placeholder="What do you want to do?" autoComplete="off" spellCheck={false} value={q}
                onChange={(e) => { setQ(e.target.value); setActive(0); }}
                onKeyDown={(e) => { if (e.key === "Enter" && act) { e.preventDefault(); run(act); } }} />
            )}
            <ul id="omni-list" className="omni-list" role={compact ? undefined : "listbox"} aria-label="Actions">
              {results.map((a, i) => (
                <li key={a.id} role={compact ? undefined : "presentation"}>
                  {compact ? (
                    <button type="button" className="omni-row" onClick={() => run(a)}>
                      <span className="omni-ic"><Svg>{ICON[a.id]}</Svg></span>
                      <span className="omni-tx"><b>{a.label}</b><small>{a.hint}</small></span>
                    </button>
                  ) : (
                    <div id={`omni-opt-${a.id}`} role="option" aria-selected={act?.id === a.id} className={act?.id === a.id ? "omni-row on" : "omni-row"} onMouseMove={() => setActive(i)} onClick={() => run(a)}>
                      <span className="omni-ic"><Svg>{ICON[a.id]}</Svg></span>
                      <span className="omni-tx"><b>{a.label}</b><small>{a.hint}</small></span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {!compact && results.length === 0 && <p className="omni-empty muted small" role="status">No matching action.</p>}
            {!compact && <p className="omni-foot muted small" aria-hidden="true">↑ ↓ to move · Enter to open · Esc to close</p>}
          </div>
        </div>
      )}
    </>
  );
}

/** The desktop entry point: a button in the sidebar that shows the shortcut and opens the same palette. */
export function OmniSidebarButton() {
  const [label, setLabel] = useState("Ctrl K");
  useEffect(() => { setLabel(shortcutLabel(typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent)); }, []);
  return (
    <button type="button" className="omni-side" onClick={() => window.dispatchEvent(new Event(OMNI_OPEN_EVENT))} aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K">
      <span>Quick actions</span><kbd>{label}</kbd>
    </button>
  );
}
