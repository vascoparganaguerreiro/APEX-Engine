"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/useAuth";
import { errMsg, loadPanels, loadResults, loadSupplementsAndSchedules } from "@/lib/health/load";
import { buildTimeline, type TimelineItem } from "@/lib/health/core";

const GLYPH = { panel: "🩸", start: "▲", stop: "■", schedule: "◆" } as const;
const COLOR = { panel: "var(--blue)", start: "var(--green)", stop: "var(--amber)", schedule: "var(--muted)" } as const;

export default function TimelinePage() {
  const { session } = useAuth();
  const [items, setItems] = useState<TimelineItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState({ panel: true, supplements: true });

  useEffect(() => {
    if (!session) return;
    Promise.all([loadPanels(), loadResults(), loadSupplementsAndSchedules()])
      .then(([p, r, s]) => setItems(buildTimeline(p, r, s.supplements, s.schedules))).catch((e) => setError(errMsg(e)));
  }, [session]);

  const grouped = useMemo(() => {
    const g = new Map<string, TimelineItem[]>();
    for (const it of items ?? []) {
      if ((it.kind === "panel" && !show.panel) || (it.kind !== "panel" && !show.supplements)) continue;
      const m = it.date.slice(0, 7);
      g.set(m, [...(g.get(m) ?? []), it]);
    }
    return [...g.entries()];
  }, [items, show]);

  return (
    <>
      <div className="eyebrow">Health</div>
      <h1>Health timeline</h1>
      <p className="muted small">Blood tests and supplement changes in one place. The order shows timing only, not cause and effect.</p>
      {error && <div className="notice error">{error}</div>}
      {items === null && !error && <p className="muted">Loading…</p>}
      <div className="row" style={{ marginBottom: 14 }}>
        <button className={show.panel ? "chip on" : "chip"} aria-pressed={show.panel} onClick={() => setShow({ ...show, panel: !show.panel })}>Blood tests</button>
        <button className={show.supplements ? "chip on" : "chip"} aria-pressed={show.supplements} onClick={() => setShow({ ...show, supplements: !show.supplements })}>Supplements</button>
      </div>
      {items !== null && items.length === 0 && (
        <div className="notice">Nothing here yet. Add a <Link href="/supplements" style={{ color: "var(--green)" }}>supplement</Link> or a <Link href="/biomarkers/panels/new" style={{ color: "var(--green)" }}>blood test</Link> to build your timeline.</div>
      )}
      {grouped.map(([month, list]) => (
        <section key={month}>
          <h2 style={{ fontSize: 18 }}>{month}</h2>
          <div className="card">
            {list.map((it, i) => {
              const body = (<><span className="tl-dot" style={{ color: COLOR[it.kind] }} aria-hidden>{GLYPH[it.kind]}</span><span className="muted small tl-date">{it.date}</span><span><b>{it.title}</b>{it.detail && <span className="muted small"> · {it.detail}</span>}</span></>);
              return it.href
                ? <Link key={`${it.date}-${i}`} href={it.href} className="doserow" style={{ textDecoration: "none", color: "inherit" }}>{body}</Link>
                : <div key={`${it.date}-${i}`} className="doserow">{body}</div>;
            })}
          </div>
        </section>
      ))}
    </>
  );
}
