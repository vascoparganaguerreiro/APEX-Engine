import Link from "next/link";
import type { EmptyCopy, EmptyIcon } from "@/lib/emptyStates";

// Shared educational empty state. Presentation only. It is shown by pages ONLY for a genuinely empty, successfully loaded list (see
// lib/emptyStates.ts loadView); a failed request uses LoadProblem below instead. No chart, number or sample data appears in it.
const PATH: Record<EmptyIcon, React.ReactNode> = {
  activity: <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />,
  dumbbell: <path d="M6 8v8M3.5 10v4M18 8v8M20.5 10v4M6 12h12" />,
  routine: <><rect x="5" y="4" width="14" height="16" rx="3" /><path d="M9 9h6M9 13h6M9 17h3" /></>,
  drop: <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" />,
  flag: <path d="M6 21V4M6 5h11l-2 4 2 4H6" />,
  pill: <><rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-45 12 12)" /><path d="M9.5 9.5l5 5" /></>,
  calendar: <><rect x="4" y="5.5" width="16" height="14" rx="3" /><path d="M8 3.5v4M16 3.5v4M4 10h16" /></>,
  heart: <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />,
};

export default function EmptyState({ copy, onAction, compact = false, headingLevel = 3 }: { copy: EmptyCopy; onAction?: () => void; compact?: boolean; headingLevel?: 2 | 3 | 4 }) {
  const H = `h${headingLevel}` as "h2" | "h3" | "h4";
  const { cta, secondary } = copy;
  const primary = cta.href
    ? <Link className={compact ? "btn ghost tiny" : "btn"} href={cta.href}>{cta.label}</Link>
    : <button type="button" className={compact ? "btn ghost tiny" : "btn"} onClick={onAction}>{cta.label}</button>;
  return (
    <section className={compact ? "empty compact" : "empty"} aria-label={copy.title}>
      {!compact && (
        <div className="empty-ic" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" focusable="false">{PATH[copy.icon]}</svg>
        </div>
      )}
      <div className="empty-body">
        {compact ? <p className="empty-title"><b>{copy.title}</b></p> : <H className="empty-title">{copy.title}</H>}
        <p className="empty-why">{copy.why}</p>
        <p className="empty-need"><b>To get started:</b> {copy.need}</p>
        <div className="empty-cta">
          {primary}
          {secondary && <Link className="empty-link" href={secondary.href}>{secondary.label}</Link>}
        </div>
      </div>
    </section>
  );
}

/** A request that FAILED. It is never an empty state: it says something went wrong and offers a retry where one is possible. */
export function LoadProblem({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="notice error" role="alert">
      {message}
      {onRetry && <> <button type="button" className="btn ghost tiny" onClick={onRetry}>Try again</button></>}
    </div>
  );
}
