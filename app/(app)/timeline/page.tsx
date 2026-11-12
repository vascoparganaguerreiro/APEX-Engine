"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/useAuth";
import { getSupabase } from "@/lib/supabase";
import { errMsg, loadPanels, loadResults, loadSupplementsAndSchedules } from "@/lib/health/load";
import { buildTimeline, type TimelineItem } from "@/lib/health/core";
import { activitySources, loadLinksOrNone, strengthSources, type Db } from "@/lib/strength/data";
import { trainingItems, type Source } from "@/lib/strength/dedup";
import { localDay } from "@/lib/activities";

const GLYPH = { panel: "🩸", start: "▲", stop: "■", schedule: "◆", training: "●" } as const;
const COLOR = { panel: "var(--blue)", start: "var(--green)", stop: "var(--amber)", schedule: "var(--muted)", training: "var(--green)" } as const;
type Row = { date: string; kind: keyof typeof GLYPH; title: string; detail: string | null; href: string | null };

/** Training records for the timeline: each real workout once (a Garmin activity merged with its Hevy log is one entry). Optional: if the
 *  Strength Hub migration is not applied, activities still appear, each on its own. */
async function loadTraining(): Promise<Row[]> {
  const db = getSupabase() as unknown as Db, since = new Date(Date.now() - 365 * 86_400_000).toISOString();
  const [acts, str, links] = await Promise.all([activitySources(db, since).catch(() => [] as Source[]), strengthSources(db, since).catch(() => [] as Source[]), loadLinksOrNone(db)]);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return trainingItems([...acts, ...str], links).map((t) => ({
    date: localDay(t.startedAt, tz), kind: "training" as const, title: t.title, href: t.href,
    detail: [t.sport, t.durationS ? `${Math.round(t.durationS / 60)} min` : null, t.detail || null, t.merged ? `merged: ${t.sources.join(" + ")}` : t.sources[0]].filter(Boolean).join(" · "),
  }));
}

export default function TimelinePage() {
  const { session } = useAuth();
  const [items, setItems] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState({ panel: true, supplements: true, training: true });

  useEffect(() => {
    if (!session) return;
    Promise.all([loadPanels(), loadResults(), loadSupplementsAndSchedules(), loadTraining().catch(() => [] as Row[])])
      .then(([p, r, s, t]) => {
        const health: Row[] = buildTimeline(p, r, s.supplements, s.schedules).map((it: TimelineItem) => ({ date: it.date, kind: it.kind, title: it.title, detail: it.detail ?? null, href: it.href ?? null }));
        setItems([...health, ...t].sort((a, b) => b.date.localeCompare(a.date)));
      }).catch((e) => setError(errMsg(e)));
  }, [session]);

  const grouped = useMemo(() => {
    const g = new Map<string, Row[]>();
    for (const it of items ?? []) {
      if ((it.kind === "panel" && !show.panel) || (it.kind === "training" && !show.training) || (it.kind !== "panel" && it.kind !== "training" && !show.supplements)) continue;
      const m = it.date.slice(0, 7);
      g.set(m, [...(g.get(m) ?? []), it]);
    }
    return [...g.entries()];
  }, [items, show]);

  return (
    <>
      <div className="eyebrow">Health</div>
      <h1>Timeline</h1>
      <p className="muted small">Blood tests, supplement changes and training in one place. The order shows timing only, not cause and effect.</p>
      {error && <div className="notice error">{error}</div>}
      {items === null && !error && <p className="muted">Loading…</p>}
      <div className="row" style={{ marginBottom: 14 }}>
        <button className={show.panel ? "chip on" : "chip"} aria-pressed={show.panel} onClick={() => setShow({ ...show, panel: !show.panel })}>Blood tests</button>
        <button className={show.supplements ? "chip on" : "chip"} aria-pressed={show.supplements} onClick={() => setShow({ ...show, supplements: !show.supplements })}>Supplements</button>
        <button className={show.training ? "chip on" : "chip"} aria-pressed={show.training} onClick={() => setShow({ ...show, training: !show.training })}>Training</button>
      </div>
      {items !== null && items.length === 0 && (
        <div className="notice">Nothing here yet. Add a <Link href="/supplements" style={{ color: "var(--green)" }}>supplement</Link>, a <Link href="/biomarkers/panels/new" style={{ color: "var(--green)" }}>blood test</Link> or a <Link href="/strength" style={{ color: "var(--green)" }}>workout</Link> to build your timeline.</div>
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
