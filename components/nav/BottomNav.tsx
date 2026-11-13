"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MORE_GROUPS, PRIMARY_NAV, SHORT_LANDSCAPE_MEDIA, activeTab, isActive, opensKeyboard, type BottomTab } from "@/lib/nav";

// Mobile primary navigation (<= 800px; hidden by CSS on desktop). Presentation only: it links to existing routes and the sign-out button
// calls the same function the desktop sidebar calls. Icons are inline SVG outlines (no dependency): one 24px grid, 1.75 stroke, round caps.
const ICON: Record<BottomTab, React.ReactNode> = {
  today: <><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" /></>,
  activities: <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />,
  coach: <><path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6a2.5 2.5 0 0 1-2.5 2.5H11l-4 3.5V15h-.5A2.5 2.5 0 0 1 5 12.5z" /></>,
  more: <><circle cx="6" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="18" cy="12" r="1.3" /></>,
};
/** Outline icons for the destinations inside More (keyed by route), plus the two sheet actions. */
const ROW_ICON: Record<string, React.ReactNode> = {
  "/training": <><rect x="4" y="5.5" width="16" height="14" rx="3" /><path d="M8 3.5v4M16 3.5v4M4 10h16" /></>,
  "/strength": <path d="M6 8v8M3.5 10v4M18 8v8M20.5 10v4M6 12h12" />,
  "/races": <path d="M6 21V4M6 5h11l-2 4 2 4H6" />,
  "/biomarkers": <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" />,
  "/supplements": <><rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-45 12 12)" /><path d="M9.5 9.5l5 5" /></>,
  "/timeline": <><path d="M7 5v14" /><circle cx="7" cy="7" r="1.6" /><circle cx="7" cy="12" r="1.6" /><circle cx="7" cy="17" r="1.6" /><path d="M12 7h8M12 12h6M12 17h8" /></>,
  "/integrations": <path d="M9.5 14.5l5-5M8 11l-1.5 1.5a3.5 3.5 0 0 0 5 5L13 16M16 13l1.5-1.5a3.5 3.5 0 0 0-5-5L11 8" />,
  "/profile": <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 19.5c1-3.6 3.7-5.5 7-5.5s6 1.9 7 5.5" /></>,
};
const SIGN_OUT = <path d="M14 5h3.5A1.5 1.5 0 0 1 19 6.5v11a1.5 1.5 0 0 1-1.5 1.5H14M10 8l-4 4 4 4M6 12h9" />;
const CLOSE = <path d="M6 6l12 12M18 6L6 18" />;
const Svg = ({ children, size = 24 }: { children: React.ReactNode; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>
);
const Icon = ({ name }: { name: BottomTab }) => <Svg>{ICON[name]}</Svg>;
const FOCUSABLE = "a[href],button:not([disabled])";

export default function BottomNav({ email, onSignOut }: { email?: string | null; onSignOut: () => void }) {
  const path = usePathname() ?? "";
  const tab = activeTab(path);
  const [open, setOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  // Going to another page, or growing the window to the desktop layout (where this bar is hidden), closes the menu.
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 801px)"), sideways = window.matchMedia(SHORT_LANDSCAPE_MEDIA);   // a phone held sideways keeps this bar
    const on = () => { if (wide.matches && !sideways.matches) setOpen(false); };
    wide.addEventListener("change", on); sideways.addEventListener("change", on);
    return () => { wide.removeEventListener("change", on); sideways.removeEventListener("change", on); };
  }, []);

  // Escape closes; focus moves into the menu when it opens and returns to the More button when it closes; the page behind does not scroll.
  useEffect(() => {
    if (!open) return;
    const btn = moreBtn.current;
    panel.current?.querySelector<HTMLElement>("a,button")?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; btn?.focus(); };
  }, [open]);

  // The sheet is modal: Tab and Shift+Tab stay inside it instead of walking into the page or the bar behind.
  function trapTab(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const items = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (items.length === 0) return;
    const first = items[0], last = items[items.length - 1], now = document.activeElement;
    if (e.shiftKey && now === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && now === last) { e.preventDefault(); first.focus(); }
  }

  // While a text field has focus the on-screen keyboard is up: hide the bar so it never sits on top of (or above) the keyboard.
  useEffect(() => {
    const on = (e: FocusEvent) => setTyping(opensKeyboard(e.target as HTMLElement | null));
    const off = () => setTyping(false);
    document.addEventListener("focusin", on); document.addEventListener("focusout", off);
    return () => { document.removeEventListener("focusin", on); document.removeEventListener("focusout", off); };
  }, []);
  // Page styles read this: while the keyboard is up the bar space is released (composers sit at the bottom) and floating buttons hide.
  useEffect(() => {
    document.documentElement.classList.toggle("kb-open", typing);
    return () => document.documentElement.classList.remove("kb-open");
  }, [typing]);

  return (
    <>
      {open && <div className="bnav-scrim" onClick={() => setOpen(false)} aria-hidden="true" />}
      {open && (
        <div className="bnav-panel" id="bnav-more" role="dialog" aria-label="More destinations" aria-modal="true" ref={panel} onKeyDown={trapTab}>
          <div className="bnav-grab" aria-hidden="true" />
          <header className="bnav-head">
            <h2 className="bnav-title">More</h2>
            <button type="button" className="bnav-close" aria-label="Close menu" onClick={() => setOpen(false)}><Svg size={20}>{CLOSE}</Svg></button>
          </header>
          {MORE_GROUPS.map((g) => (
            <section key={g.id} className={`bnav-group${g.id === "account" ? " account" : ""}`} aria-labelledby={`bnav-g-${g.id}`}>
              <h3 id={`bnav-g-${g.id}`}>{g.label}</h3>
              <ul>
                {g.items.map((n) => (
                  <li key={n.href}>
                    <Link href={n.href} className={isActive(path, n.href) ? "bnav-row on" : "bnav-row"} aria-current={isActive(path, n.href) ? "page" : undefined}>
                      <span className="bnav-rowic"><Svg size={22}>{ROW_ICON[n.href]}</Svg></span>
                      <span className="bnav-rowtx">{n.label}</span>
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6" /></svg>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {/* an action, not a destination: apart from the lists, no chevron. Same call as the desktop button: signs out THIS device only */}
          <div className="bnav-actions">
            {email && <p className="bnav-who muted small">Signed in as {email}</p>}
            <button type="button" className="bnav-row bnav-out" onClick={onSignOut}><span className="bnav-rowic"><Svg size={22}>{SIGN_OUT}</Svg></span><span className="bnav-rowtx">Sign out</span></button>
          </div>
        </div>
      )}
      <nav className={`bnav${typing ? " typing" : ""}`} aria-label="Primary" inert={open || undefined}>
        {PRIMARY_NAV.map((n) => {
          const key = n.href.slice(1) as BottomTab, on = tab === key && !open;   // while the More menu is open only More is highlighted
          return (
            <Link key={n.href} href={n.href} className={on ? "bnav-item on" : "bnav-item"} aria-current={on ? "page" : undefined}>
              <Icon name={key} /><span>{n.label}</span>
            </Link>
          );
        })}
        <button type="button" ref={moreBtn} className={tab === "more" || open ? "bnav-item on" : "bnav-item"} aria-expanded={open} aria-controls="bnav-more" aria-haspopup="dialog"
          aria-current={tab === "more" ? "page" : undefined} onClick={() => setOpen((v) => !v)}>
          <Icon name="more" /><span>More</span>
        </button>
      </nav>
    </>
  );
}
