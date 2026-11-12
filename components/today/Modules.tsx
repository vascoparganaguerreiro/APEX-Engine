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
  SOURCE_TEXT, relDay, shortDate, nextRaceInfo, type BiomarkerSummary, type EnduranceSummary, type Freshness, type Reading, type StrengthSummary,
  type ReadinessEstimate, type SupplementSummary, type WellnessSummary,
} from "@/lib/today/model";
import type { Race } from "@/lib/races";
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

function Metric({ label, r, fmt, today, extra }: { label: string; r: Reading | null; fmt: (v: number) => string; today: string; extra?: ReactNode }) {
  return (
    <div className={`td-metric${r && r.freshness !== "today" ? " dim" : ""}`}>
      <small>{label}</small>
      {r ? <b>{fmt(r.value)}</b> : <b className="td-none">—</b>}
      <span className="td-meta">{r ? <>{when(r, today)}{r.source ? ` · ${SOURCE_TEXT[r.source] ?? r.source}` : ""}</> : "not recorded"}</span>
      {extra}
    </div>
  );
}

// ------------------------------------------------------------------ 1 Wellness
export function WellnessCard({ s, w, today, goal, whoop, onLog }: { s: Section<unknown>; w: WellnessSummary | null; today: string; goal: number | null; whoop: { value: number; day: string | null } | null; onLog: () => void }) {
  const status = !w ? null : w.state === "current" ? <Fresh f="today" /> : w.state === "partial" ? <span className="td-pill f-yesterday">Partly today</span> : w.state === "stale" ? <Fresh f="stale" /> : <Fresh f="missing" />;
  return (
    <Module title="Wellness" accent="green" href="/integrations" linkText="Data sources" status={<>{status}<button type="button" className="td-inline" onClick={onLog}>Log a day</button></>} className="td-span-4">
      {s.status === "unavailable" ? <Unavailable s={s} /> : !w || w.state === "missing" ? (
        <EmptyState compact copy={EMPTY["today-wellness"]} onAction={onLog} />
      ) : (
        <>
          <div className="td-metrics3">
            <Metric label="HRV (rMSSD)" r={w.hrv} today={today} fmt={(v) => `${Math.round(v)} ms`}
              extra={w.hrvVsBaseline && <em className={w.hrvVsBaseline.pct >= 0 ? "up" : "down"}>{w.hrvVsBaseline.pct >= 0 ? "+" : ""}{w.hrvVsBaseline.pct}% vs your {w.hrvVsBaseline.days}-day average ({w.hrvVsBaseline.mean} ms)</em>} />
            <Metric label="Resting HR" r={w.rhr} today={today} fmt={(v) => `${Math.round(v)} bpm`}
              extra={w.rhrVsBaseline && <em className={w.rhrVsBaseline.diff <= 0 ? "up" : "down"}>{w.rhrVsBaseline.diff > 0 ? "+" : ""}{w.rhrVsBaseline.diff} bpm vs your {w.rhrVsBaseline.days}-day average</em>} />
            <Metric label="Sleep" r={w.sleep} today={today} fmt={(v) => `${Math.floor(v / 60)}h ${String(Math.round(v % 60)).padStart(2, "0")}m`}
              extra={<em className="muted">{goal ? `goal ${goal.toFixed(1)} h` : <>no sleep goal set (<Link href="/profile">Profile</Link>)</>}</em>} />
          </div>
          <ReadinessBlock est={w.estimate} />
          {(w.sleepScore || whoop) && (
            <div className="td-vendor">
              {w.sleepScore && <span>Sleep score <b>{Math.round(w.sleepScore.value)}</b> <span className="td-meta">device score via Intervals.icu · {when(w.sleepScore, today)}</span></span>}
              {whoop && <span>WHOOP Recovery <b>{Math.round(whoop.value)}%</b> <span className="td-meta">WHOOP&apos;s own score{whoop.day ? ` · ${relDay(whoop.day, today)}` : ""}</span></span>}
            </div>
          )}
        </>
      )}
    </Module>
  );
}

/** APEX Readiness Estimate: deterministic (lib/today/model.ts readinessEstimate). Shows its inputs, references, confidence and limits. */
const CONF_TEXT: Record<string, string> = { high: "High confidence", medium: "Medium confidence", low: "Low confidence · provisional" };
export function ReadinessBlock({ est }: { est: ReadinessEstimate }) {
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
      <div className="td-readyscore" style={{ ["--p" as string]: `${est.score}%` }}><b>{est.score}</b><small>/100</small></div>
      <div style={{ minWidth: 0 }}>
        <b>{est.name}</b> <span className={`pill conf-${est.confidence}`}>{CONF_TEXT[est.confidence]}</span>
        <ul className="td-reasons">
          {est.components.map((c) => <li key={c.key}><b>{c.label}</b> today {c.today} {c.unit} vs {c.referenceLabel} {c.reference} {c.unit} <span className="td-meta">· sub-score {c.subscore} · counts {Math.round(c.effectiveWeight * 100)}%</span></li>)}
          {est.excluded.map((x) => <li key={x} className="td-meta">Not used: {x}</li>)}
        </ul>
        <details className="td-how">
          <summary>How it is calculated</summary>
          <p className="td-meta">Only today&apos;s measurements are used. HRV: how many standard deviations today is from your average of the previous 28 days (at least 5 days), limited to ±2 and mapped to 0–100. Resting HR: bpm below (better) or above your 28-day average, limited to ±8 and mapped to 0–100. Sleep: hours slept as a share of your sleep goal, up to 100. Weights HRV 45%, resting HR 25%, sleep 30%; a measurement that cannot be used is left out and the others are scaled up, never filled in. Confidence: high with all three and baselines of 14+ days; medium with three and 7+ days, or two with 14+ days; otherwise low (provisional).</p>
        </details>
        {est.guidance ? <p className="small" style={{ margin: "6px 0 0" }}>{est.guidance} You decide.</p>
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
            <b>{e.last.title || e.last.sport}</b>
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
            {e.form ? <div><small>Form (TSB)</small><b>{e.form.tsb > 0 ? "+" : ""}{e.form.tsb}</b><span className="td-meta">{e.form.state} · fitness {e.form.ctl}, fatigue {e.form.atl} (model)</span></div>
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
