"use client";
import { useState } from "react";
import Link from "next/link";
import { shortDate, type DayCol } from "@/lib/today/model";
import { sportLabel } from "@/lib/today/format";

const ICON: Record<string, string> = { race: "🏁", activity: "●", strength: "▲", workout_active: "▶", supplements: "◆", planned: "○" };
const STATUS: Record<string, string> = { planned: "Planned", done: "Done", in_progress: "In progress", skipped: "Skipped" };
const KIND: Record<string, string> = { race: "race", activity: "activity", strength: "strength session", workout_active: "workout in progress", supplements: "supplements", planned: "planned workout" };
const dayNumber = (day: string) => shortDate(day).split(" ")[1] ?? "";
/** The detail text of an item. Activities carry a raw sport id from the database: it is shown as its label (unknown ids are "Activity"). */
const detailOf = (it: DayCol["items"][number]) => (it.kind === "activity" ? sportLabel(it.detail) : it.detail);

/** Today + four days as a compact, horizontally scrollable date strip. Tap a day to see its items underneath (today is selected first).
 *  Dots appear only for days that have real records; an empty day has none. The strip is in date order, which is also the reading and tab order. */
export default function FiveDay({ days }: { days: DayCol[] }) {
  const [sel, setSel] = useState<string | null>(null);
  const cur = days.find((d) => d.day === sel) ?? days[0];
  const any = days.some((d) => d.items.length);
  if (!cur) return null;
  return (
    <section className="td-five" aria-labelledby="td-five-h">
      <div className="td-section-head"><h2 id="td-five-h">Next five days</h2><span className="td-meta">Races, planned workouts, sessions and supplement doses</span></div>
      <div className="td-strip" role="group" aria-label="Choose a day">
        {days.map((d) => {
          const on = d.day === cur.day, kinds = [...new Set(d.items.map((i) => i.kind))];
          return (
            <button key={d.day} type="button" className={`td-chip${on ? " sel" : ""}${d.label === "Today" ? " now" : ""}`} aria-pressed={on} aria-current={d.label === "Today" ? "date" : undefined}
              aria-label={`${d.label}, ${shortDate(d.day)}: ${d.items.length === 0 ? "nothing recorded" : `${d.items.length} item${d.items.length === 1 ? "" : "s"} (${kinds.map((k) => KIND[k]).join(", ")})`}`}
              onClick={() => setSel(d.day)}>
              <small>{d.label}</small><b>{dayNumber(d.day)}</b>
              <span className="td-chipdots" aria-hidden="true">{kinds.map((k) => <i key={k} className={`td-dot2 k-${k}`} />)}</span>
            </button>
          );
        })}
      </div>
      <div className="td-dayplan" aria-live="polite">
        <h3>{cur.label}, {shortDate(cur.day)}</h3>
        {cur.items.length === 0 ? <p className="td-meta">{cur.label === "Today" ? "No activity recorded or workout planned today." : "No workouts planned."}</p> : (
          <ul className="td-planlist">
            {cur.items.map((it, i) => (
              <li key={i}><Link href={it.href} className={`td-item k-${it.kind} s-${it.status}`}>
                <span className="td-itemicon" aria-hidden>{ICON[it.kind]}</span>
                <span className="td-itemtext"><b>{it.title}</b><small>{STATUS[it.status]} · {detailOf(it)}</small></span>
              </Link></li>
            ))}
          </ul>
        )}
      </div>
      <p className="td-meta" style={{ marginTop: 8 }}>{any ? "" : "Nothing in the next five days. "}Add planned workouts in <Link href="/training" className="td-link">Training</Link>; APEX does not plan for you.</p>
    </section>
  );
}
