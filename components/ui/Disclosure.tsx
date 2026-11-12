"use client";
import { useEffect, useState } from "react";
import { effectiveOpen } from "@/lib/disclosure";

// One expandable section, built on the native <details>/<summary>: Enter and Space toggle it, collapsed content leaves the tab order, and
// assistive technology announces the expanded state. The summary line always says what is inside, so closing it never hides a status.
// `forceOpen` opens it (and keeps it open) when it holds something the user must see, such as a failed save or a connection problem.
export default function Disclosure({ title, summary, defaultOpen = false, forceOpen = false, children }: {
  title: string; summary?: React.ReactNode; defaultOpen?: boolean; forceOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen]);
  const isOpen = effectiveOpen(open, forceOpen);
  return (
    <details className="disc" open={isOpen} onToggle={(e) => { if (!forceOpen) setOpen((e.currentTarget as HTMLDetailsElement).open); }}>
      <summary>
        <span className="disc-title">{title}</span>
        {summary !== undefined && summary !== null && <span className="disc-sum">{summary}</span>}
        <svg className="disc-chev" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M6 9l6 6 6-6" /></svg>
      </summary>
      <div className="disc-body">{children}</div>
    </details>
  );
}
