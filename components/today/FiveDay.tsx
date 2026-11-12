"use client";
import Link from "next/link";
import { shortDate, type DayCol } from "@/lib/today/model";

const ICON: Record<string, string> = { race: "🏁", activity: "●", strength: "▲", workout_active: "▶", supplements: "◆" };
const STATUS: Record<string, string> = { planned: "Planned", done: "Done", in_progress: "In progress" };

/** Today + four days. Only real records; an empty day stays quietly empty. */
export default function FiveDay({ days }: { days: DayCol[] }) {
  const any = days.some((d) => d.items.length);
  return (
    <section className="td-five" aria-label="Next five days">
      <div className="td-section-head"><h2>Next five days</h2><span className="td-meta">races, sessions done today and scheduled supplement doses</span></div>
      <div className="td-days">
        {days.map((d) => (
          <div key={d.day} className={`td-day${d.label === "Today" ? " now" : ""}`}>
            <div className="td-dayhead"><b>{d.label}</b><small>{shortDate(d.day)}</small></div>
            {d.items.length === 0 ? <span className="td-dayempty" aria-label="Nothing recorded">–</span> : d.items.map((it, i) => (
              <Link key={i} href={it.href} className={`td-item k-${it.kind} s-${it.status}`}>
                <span className="td-itemicon" aria-hidden>{ICON[it.kind]}</span>
                <span className="td-itemtext"><b>{it.title}</b><small>{STATUS[it.status]} · {it.detail}</small></span>
              </Link>
            ))}
          </div>
        ))}
      </div>
      <p className="td-meta" style={{ marginTop: 8 }}>{any ? "" : "Nothing scheduled in the next five days. "}APEX has no training calendar yet, so planned workouts are not shown here; races and supplement schedules are.</p>
    </section>
  );
}
