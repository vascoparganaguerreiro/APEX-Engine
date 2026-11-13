"use client";
// The six Today module cards. Each shows only data that exists, with the day it belongs to, and a calm empty state otherwise.
import Link from "next/link";
import EmptyState from "@/components/ui/EmptyState";
import { EMPTY } from "@/lib/emptyStates";
import type { ReactNode } from "react";
import { formatDistance, formatDuration } from "@/lib/activities";
import { formatDuration as raceTime, formatDistance as raceDistance, PRIORITY_LABEL } from "@/lib/races";
import { racePhase } from "@/lib/engine";
import {
  relDay, shortDate, nextRaceInfo, type BiomarkerSummary, type EnduranceSummary, type Freshness, type Reading, type StrengthSummary,
  type ReadinessEstimate, type SupplementSummary, type WellnessSummary,
} from "@/lib/today/model";
import type { Race } from "@/lib/races";
import { formFacts, READINESS_EXPLAINER, readinessFreshnessLine, sourceText, sportLabel } from "@/lib/today/format";
import type { Section } from "@/lib/today/load";

type Accent = "green" | "blue" | "amber" | "violet" | "red" | "teal";
export function Module({ title, accent, href, linkText, status, className = "", children }: {
  title: string; accent: Accent; href: string; linkText: string; status?: ReactNode; className?: string; children: ReactNode;
}) {
  return (
    <section className={`td-card td-${accent} ${className}`} aria-label={title}>
      <header className="td-card-head"><span className="td-dot" aria-hidden /> <h3>{title}</h3>{status && <span className="td-status">{status}</span>}</header>
      <div className="td-card-body">{children}</div>
      <Link className="td-link" href={href}>{linkText} <span aria-hidden>→</span></Link>
    </section>
  );
}
const FRESH_LABEL: Record<Freshness, string> = { today: "Today", yesterday: "Yesterday", stale: "Older", missing: "No data" };
export const Fresh = ({ f }: { f: Freshness }) => <span className={`td-pill f-${f}`}>{FRESH_LABEL[f]}</span>;
const Empty = ({ children }: { children: ReactNode }) => <p className="td-empty">{children}</p>;
const Unavailable = ({ s }: { s: { status: "unavailable"; reason: string } }) => <Empty>{s.reason}</Empty>;
const when = (r: Reading, today: string) => (r.freshness === "today" ? "today" : `${relDay(r.day, today)} · ${shortDate(r.day)}`);

// ------------------------------------------------------------------ 1 Wellness
/** The detail card adds what the headline metrics above do not show: where each number came from and when, the readiness breakdown, the device sleep score and what is
 *  missing from the estimate. It does not repeat the values or explanations. `quiet`: the Next step card is already asking for wellness (or saying it is unavailable).
 *  `guidanceAbove`: the Next step card already shows today's guidance. */
export function WellnessCard({ s, w, today, goal, lastSyncAt = null, onLog, quiet = false, guidanceAbove = false }: { s: Section<unknown>; w: WellnessSummary | null; today: string; goal: number | null; lastSyncAt?: string | null; onLog: () => void; quiet?: boolean; guidanceAbove?: boolean }) {
  const status = !w ? null : w.state === "current" ? <Fresh f="today" /> : w.state === "partial" ? <span className="td-pill f-yesterday">Partly today</span> : w.state === "stale" ? <Fresh f="stale" /> : <Fresh f="missing" />;
  return (
    <Module title="Wellness" accent="green" href="/integrations" linkText="Data sources" status={<>{status}<button type="button" className="td-inline" onClick={onLog}>Log a day</button></>} className="td-span-4">
      {quiet && (s.status === "unavailable" || !w || w.state === "missing") ? (
        <Empty>{s.status === "unavailable" ? "Not shown while wellness data is unavailable." : "Where each reading came from, and how the readiness estimate was made, will appear here once today's wellness is in."}</Empty>
      ) : s.status === "unavailable" ? <Unavailable s={s} /> : !w || w.state === "missing" ? (
        <EmptyState compact copy={EMPTY["today-wellness"]} onAction={onLog} />
      ) : (
        <>
          <div className="td-sources">
            <b className="td-subhead">Where today&apos;s numbers come from</b>
            <ul>
              {([["HRV (rMSSD)", w.hrv], ["Resting heart rate", w.rhr], ["Sleep", w.sleep]] as const).filter(([, r]) => r).map(([label, r]) => (
                <li key={label}><span>{label}</span><span className="td-meta">{when(r!, today)} · {sourceText(r!.source)}</span></li>
              ))}
            </ul>
            {w.sleep && !goal && <p className="td-meta">No sleep goal is set, so sleep is left out of the readiness estimate. <Link href="/profile">Set one in Profile</Link>.</p>}
          </div>
          <div className="td-sources">
            <b className="td-subhead">APEX Readiness Estimate{w.estimate.status === "ok" ? ` · ${w.estimate.score} / 100` : ""}</b>
            <p className="td-meta">{READINESS_EXPLAINER}</p>
            <p className="td-meta">{readinessFreshnessLine(w.state, lastSyncAt)}</p>
          </div>
          <ReadinessBlock est={w.estimate} guidanceAbove={guidanceAbove} />
          {w.sleepScore && (
            <div className="td-vendor">
              {w.sleepScore && <span>Sleep score <b>{Math.round(w.sleepScore.value)}</b> <span className="td-meta">device score via Intervals.icu · {when(w.sleepScore, today)}</span></span>}
            </div>
          )}
        </>
      )}
    </Module>
  );
}

/** APEX Readiness Estimate, how it was made: deterministic (lib/today/model.ts readinessEstimate). The score, confidence and band are in Key metrics and the Next step card;
 *  this block adds the exclusions and limits (visible) and the inputs, weights and method (expandable). */
export function ReadinessBlock({ est, guidanceAbove = false }: { est: ReadinessEstimate; guidanceAbove?: boolean }) {
  if (est.status === "insufficient") {
    return (
      <div className="td-ready insufficient" aria-label={est.name}>
        <div className="td-readyscore none"><b>–</b></div>
        <div>
          <b>{est.name}</b> <span className="td-pill">Insufficient data</span>
          <p className="td-meta">{est.reasons[0]}</p>
          {est.reasons.length > 1 && <ul className="td-reasons">{est.reasons.slice(1).map((r) => <li key={r}>{r}</li>)}</ul>}
        </div>
      </div>
    );
  }
  return (
    <div className={`td-ready${est.provisional ? " provisional" : ""}`} aria-label={est.name}>
      <div style={{ minWidth: 0 }}>
        <b className="td-subhead">How the readiness estimate was made</b>
        {est.excluded.length > 0 && <ul className="td-reasons">{est.excluded.map((x) => <li key={x} className="td-meta">Not used: {x}</li>)}</ul>}
        <details className="td-how">
          <summary>Calculation details: inputs, weights and method</summary>
          <ul className="td-reasons">{est.components.map((c) => <li key={c.key}><b>{c.label}</b> today {c.today} {c.unit} vs {c.referenceLabel} {c.reference} {c.unit} <span className="td-meta">· sub-score {c.subscore} · counts {Math.round(c.effectiveWeight * 100)}%</span></li>)}</ul>
          <p className="td-meta" style={{ marginTop: 6 }}>Only today&apos;s measurements are used. HRV: how many standard deviations today is from your average of the previous 28 days (at least 5 days), limited to ±2 and mapped to 0–100. Resting HR: bpm below (better) or above your 28-day average, limited to ±8 and mapped to 0–100. Sleep: hours slept as a share of your sleep goal, up to 100. Weights HRV 45%, resting HR 25%, sleep 30%; a measurement that cannot be used is left out and the others are scaled up, never filled in. Confidence: high with all three and baselines of 14+ days; medium with three and 7+ days, or two with 14+ days; otherwise low (provisional).</p>
        </details>
        {guidanceAbove ? <p className="td-meta" style={{ margin: "6px 0 0" }}>Today&apos;s guidance is in the Next step above. You decide.</p>
          : est.guidance ? <p className="small" style={{ margin: "6px 0 0" }}>{est.guidance} You decide.</p>
          : <p className="td-meta" style={{ margin: "6px 0 0" }}>Provisional: too little data or a short baseline, so no training suggestion is made. Go by your plan and how you feel.</p>}
        <p className="td-meta" style={{ margin: "4px 0 0" }}>{est.disclaimer}</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 2 Endurance
export function EnduranceCard({ s, e, today }: { s: Section<unknown>; e: EnduranceSummary | null; today: string }) {
  const max = e ? Math.max(1, ...e.bars.map((b) => b.load ?? 0)) : 1;
  return (
    <Module title="Endurance" accent="blue" href="/activities" linkText="All activities" className="td-span-3"
      status={e?.last ? <span className="td-pill">{relDay(e.last.day, today)}</span> : null}>
      {s.status === "unavailable" ? <Unavailable s={s} /> : !e || !e.last ? <EmptyState compact copy={EMPTY["today-endurance"]} /> : (
        <>
          <div className="td-headline">
            <b>{e.last.title || sportLabel(e.last.sport)}</b>
            <span className="td-meta">{shortDate(e.last.day)} · {formatDuration(e.last.duration_s)}{e.last.distance_m ? ` · ${formatDistance(e.last.distance_m)}` : ""}{e.last.load ? ` · load ${Math.round(e.last.load)}` : ""}</span>
          </div>
          <div className="td-bars" role="img" aria-label="Training load per day, last 7 days">
            {e.bars.map((b) => (
              <div key={b.day} className="td-bar" title={`${shortDate(b.day)}: ${b.load === null ? "no activity" : `load ${b.load}`}`}>
                <i style={{ height: b.load === null ? 0 : `${Math.max(6, (b.load / max) * 100)}%` }} className={b.load === null ? "none" : ""} />
                <small>{shortDate(b.day).slice(0, 2)}</small>
              </div>
            ))}
          </div>
          <div className="td-stats">
            <div><small>7 days</small><b>{e.week.sessions} session{e.week.sessions === 1 ? "" : "s"}</b><span className="td-meta">{formatDuration(e.week.durationS)} · load {e.week.load} (prior 7 days {e.week.prevLoad})</span></div>
            {e.form ? (() => { const f = formFacts(e.form); return (
              <>
                <div><small>Form (TSB)</small><b>{f.tsb}</b><span className="td-meta">{f.state ?? "From the load model"}</span></div>
                <div><small>Fitness</small><b>{f.fitness}</b><span className="td-meta">load model</span></div>
                <div><small>Fatigue</small><b>{f.fatigue}</b><span className="td-meta">load model</span></div>
              </>
            ); })()
              : <div><small>Form</small><b className="td-none">—</b><span className="td-meta">needs activities with a training load</span></div>}
          </div>
        </>
      )}
    </Module>
  );
}

// ------------------------------------------------------------------ 3 Strength
export function StrengthCard({ s, st, today, active }: { s: Section<unknown>; st: StrengthSummary | null; today: string; active: { title: string; startedAt: string } | null }) {
  return (
    <Module title="Strength" accent="violet" href="/strength" linkText={active ? "Continue workout" : "Strength Hub"} className="td-span-3"
      status={active ? <span className="td-pill f-today">In progress</span> : st?.last ? <span className="td-pill">{relDay(st.last.day, today)}</span> : null}>
      {active && <div className="td-headline"><b>{active.title}</b><span className="td-meta">Started {new Date(active.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · saved on this device</span></div>}
      {s.status === "unavailable" ? <Unavailable s={s} /> : !st || !st.last ? (!active && <EmptyState compact copy={EMPTY["today-strength"]} />) : (
        <>
          {!active && <div className="td-headline"><b>{st.last.title}</b><span className="td-meta">{shortDate(st.last.day)} · {st.last.exercises} exercise{st.last.exercises === 1 ? "" : "s"} · {st.last.sets} working set{st.last.sets === 1 ? "" : "s"}{st.last.durationS ? ` · ${formatDuration(st.last.durationS)}` : ""}</span></div>}
          <div className="td-stats">
            <div><small>This week</small><b>{st.thisWeekSets} sets</b><span className="td-meta">{st.weekSessions} session{st.weekSessions === 1 ? "" : "s"} since Monday</span></div>
            <div><small>4-week average</small><b>{st.avgWeeklySets4 === null ? "—" : `${st.avgWeeklySets4} sets`}</b><span className="td-meta">{st.avgWeeklySets4 === null ? "no earlier weeks yet" : "working sets per week"}</span></div>
          </div>
        </>
      )}
    </Module>
  );
}

// ------------------------------------------------------------------ 4 Biomarkers
export function BiomarkersCard({ s, b, today }: { s: Section<unknown>; b: BiomarkerSummary | null; today: string }) {
  return (
    <Module title="Biomarkers" accent="red" href={b ? `/biomarkers/panels/${b.panel.id}` : "/biomarkers"} linkText={b ? "Open latest panel" : "Biomarkers"} className="td-span-3"
      status={b ? <span className="td-pill">{b.daysAgo === 0 ? "today" : relDay(b.panel.collected_on, today)}</span> : null}>
      {s.status === "unavailable" ? <Unavailable s={s} /> : !b ? <EmptyState compact copy={EMPTY["today-biomarkers"]} /> : (
        <>
          <div className="td-headline"><b>Blood test{b.panel.lab_name ? ` · ${b.panel.lab_name}` : ""}</b><span className="td-meta">Collected {shortDate(b.panel.collected_on)} ({b.daysAgo} days ago)</span></div>
          <div className="td-stats">
            <div><small>Results</small><b>{b.results}</b><span className="td-meta">{b.noRange ? `${b.noRange} without a lab range` : "all with a lab range"}</span></div>
            <div><small>Outside lab range</small><b className={b.outside ? "warn" : ""}>{b.outside}</b><span className="td-meta">{b.outside ? "by the laboratory's own range: discuss with your clinician" : "none flagged by the laboratory range"}</span></div>
          </div>
        </>
      )}
    </Module>
  );
}

// ------------------------------------------------------------------ 5 Supplements
export function SupplementsCard({ s, sup, onLog }: { s: Section<unknown>; sup: SupplementSummary | null; onLog: () => void }) {
  const total = sup?.due.length ?? 0, done = sup ? sup.taken + sup.skipped : 0;
  return (
    <Module title="Supplements" accent="amber" href="/supplements" linkText="Supplements" className="td-span-3"
      status={total ? <span className={`td-pill ${done === total ? "f-today" : ""}`}>{done}/{total} logged</span> : null}>
      {s.status === "unavailable" ? <Unavailable s={s} /> : !sup || (sup.active === 0 && total === 0) ? <EmptyState compact copy={EMPTY["today-supplements"]} /> : (
        <>
          <div className="td-progress" aria-label={`${done} of ${total} doses logged`}><i style={{ width: total ? `${(done / total) * 100}%` : 0 }} /></div>
          <div className="td-stats">
            <div><small>Active</small><b>{sup.active}</b><span className="td-meta">supplement{sup.active === 1 ? "" : "s"}</span></div>
            <div><small>Today</small><b>{total ? `${sup.taken} taken` : "—"}</b><span className="td-meta">{total ? `${sup.skipped} skipped · ${sup.pending} to log` : "nothing scheduled today"}</span></div>
          </div>
          {sup.pending > 0 && <button type="button" className="td-inline" onClick={onLog}>Log today&apos;s doses</button>}
        </>
      )}
    </Module>
  );
}

// ------------------------------------------------------------------ 6 Races
export function RaceCard({ s, race, today }: { s: Section<unknown>; race: Race | null; today: string }) {
  const r = nextRaceInfo(race, today);
  return (
    <Module title="Next race" accent="teal" href={r ? `/races/${r.race.id}` : "/races"} linkText={r ? "Race details" : "Races"} className="td-span-2"
      status={r ? <span className={`prio prio-${r.race.priority}`} title={PRIORITY_LABEL[r.race.priority]}>{r.race.priority}</span> : null}>
      {s.status === "unavailable" ? <Unavailable s={s} /> : !r ? <EmptyState compact copy={EMPTY["today-race"]} /> : (
        <>
          <div className="td-count"><b>{r.cd.days}</b><small>{r.cd.days === 1 ? "day" : "days"}</small></div>
          <div className="td-headline"><b>{r.race.name}</b><span className="td-meta">{shortDate(r.race.race_date)}{r.race.location ? ` · ${r.race.location}` : ""}{r.race.distance ? ` · ${raceDistance(r.race.distance, r.race.distance_unit)}` : ""}</span></div>
          <div className="td-stats one">
            <div><small>Target</small><b>{r.race.target_time_s ? raceTime(r.race.target_time_s) : "—"}</b><span className="td-meta">{r.race.goal || (r.race.target_time_s ? "your target time" : "no target set")}</span></div>
            <div><small>Phase</small><b>{racePhase(r.cd.days, r.race.race_type)}</b><span className="td-meta">by weeks to race</span></div>
          </div>
        </>
      )}
    </Module>
  );
}
