import Link from "next/link";
import { FORMATS, PRIORITY_LABEL, SPORT_LABEL, STATUS_LABEL, countdown, formatDate, formatDistance, formatDuration, type Race } from "@/lib/races";

export const PriorityPill = ({ p }: { p: Race["priority"] }) => <span className={`prio prio-${p}`} title={PRIORITY_LABEL[p]}>{p}</span>;

export function raceMeta(r: Race): string {
  const fmt = FORMATS[r.sport].find((f) => f.value === r.race_type)?.label;
  return [SPORT_LABEL[r.sport], fmt && fmt !== "Other" ? fmt : null, formatDistance(r.distance, r.distance_unit) || null].filter(Boolean).join(" · ");
}

/** The "next race" strip, used on the Today page. */
export function NextRaceCard({ race, today }: { race: Race; today: string }) {
  const c = countdown(race.race_date, today);
  return (
    <Link href={`/races/${race.id}`} className="card nextrace">
      <PriorityPill p={race.priority} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <small className="muted">Next race</small>
        <div><b>{race.name}</b> <span className="muted small">· {formatDate(race.race_date)}</span></div>
      </div>
      <div className="nextrace-days"><b>{c.label}</b><small className="muted">{c.detail}</small></div>
    </Link>
  );
}

export function RaceSummary({ r, today }: { r: Race; today: string }) {
  const c = countdown(r.race_date, today);
  return (
    <>
      <div className="act-head">
        <PriorityPill p={r.priority} />
        <Link href={`/races/${r.id}`} style={{ color: "inherit", textDecoration: "none" }}><b>{r.name}</b></Link>
        {r.status !== "planned" && <span className={r.status === "completed" ? "badge" : "badge off"}>{STATUS_LABEL[r.status]}</span>}
      </div>
      <p className="muted small" style={{ margin: "0 0 4px" }}>{raceMeta(r)}</p>
      <p className="small" style={{ margin: "0 0 4px" }}>{formatDate(r.race_date)}{r.location ? ` · ${r.location}` : ""} · <b>{c.label}</b>{!c.past && c.detail && c.days > 1 ? <span className="muted"> ({c.detail})</span> : null}</p>
      {r.target_time_s && <p className="small" style={{ margin: "0 0 4px" }}>Target time: <b>{formatDuration(r.target_time_s)}</b></p>}
      {r.goal && <p className="small muted" style={{ margin: "0 0 4px" }}>Goal: {r.goal}</p>}
    </>
  );
}