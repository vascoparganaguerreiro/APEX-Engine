"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MORE_NAV, PRIMARY_NAV, activeTab, isActive, opensKeyboard, type BottomTab } from "@/lib/nav";

// Mobile primary navigation (<= 800px; hidden by CSS on desktop). Presentation only: it links to existing routes and the sign-out button
// calls the same function the desktop sidebar calls. Icons are inline SVG (no dependency).
const ICON: Record<BottomTab, React.ReactNode> = {
  today: <><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" /></>,
  training: <><rect x="4" y="5.5" width="16" height="14" rx="3" /><path d="M8 3.5v4M16 3.5v4M4 10h16" /></>,
  activities: <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />,
  coach: <><path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6a2.5 2.5 0 0 1-2.5 2.5H11l-4 3.5V15h-.5A2.5 2.5 0 0 1 5 12.5z" /></>,
  more: <><circle cx="6" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="18" cy="12" r="1.3" /></>,
};
const Icon = ({ name }: { name: BottomTab }) => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{ICON[name]}</svg>
);

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
    const mq = window.matchMedia("(min-width: 801px)");
    const on = () => { if (mq.matches) setOpen(false); };
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
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

  // While a text field has focus the on-screen keyboard is up: hide the bar so it never sits on top of (or above) the keyboard.
  useEffect(() => {
    const on = (e: FocusEvent) => setTyping(opensKeyboard(e.target as HTMLElement | null));
    const off = () => setTyping(false);
    document.addEventListener("focusin", on); document.addEventListener("focusout", off);
    return () => { document.removeEventListener("focusin", on); document.removeEventListener("focusout", off); };
  }, []);

  return (
    <>
      {open && <div className="bnav-scrim" onClick={() => setOpen(false)} aria-hidden="true" />}
      {open && (
        <div className="bnav-panel" id="bnav-more" role="dialog" aria-label="More destinations" ref={panel}>
          {email && <div className="bnav-who muted small">{email}</div>}
          <ul>
            {MORE_NAV.map((n) => (
              <li key={n.href}>
                <Link href={n.href} className={isActive(path, n.href) ? "bnav-row on" : "bnav-row"} aria-current={isActive(path, n.href) ? "page" : undefined}>
                  <span>{n.label}</span>
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6" /></svg>
                </Link>
              </li>
            ))}
          </ul>
          {/* same call as the desktop button: signs out THIS device only */}
          <button type="button" className="bnav-row bnav-out" onClick={onSignOut}><span>Sign out</span></button>
        </div>
      )}
      <nav className={`bnav${typing ? " typing" : ""}`} aria-label="Primary">
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
