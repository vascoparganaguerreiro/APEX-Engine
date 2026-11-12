"use client";
import { PriorityPill } from "@/components/races/RaceBits";
import { WEEKDAYS, KIND_LABEL, type CalendarDay, type GridDay } from "@/lib/calendar/model";

const mark = (p: CalendarDay["planned"][number]) => (p.status === "completed" ? "✓" : p.status === "skipped" ? "–" : "○");

/** One day cell. Planned entries are dashed ("○"); recorded sessions are solid ("●"); races carry their priority. The three are
 *  different elements with different styles so a plan can never be mistaken for something that happened. */
function Cell({ d, today, compact, selected, onOpen }: { d: CalendarDay; today: string; compact: boolean; selected: boolean; onOpen: (day: string) => void }) {
  const max = compact ? 2 : 6;
  const rows: Array<{ key: string; cls: string; text: string; node?: React.ReactNode }> = [];
  for (const r of d.races) rows.push({ key: `r${r.id}`, cls: "race", text: r.name, node: <PriorityPill p={r.priority} /> });
  for (const p of d.planned) rows.push({ key: `p${p.id}`, cls: `plan s-${p.status} k-${p.kind}`, text: `${mark(p)} ${p.title}` });
  for (const c of d.completed) rows.push({ key: `c${c.kind}${c.id}`, cls: "done", text: `● ${c.title}` });
  const hidden = rows.length - max;
  return (
    <button type="button" className={`cal-cell${d.day === today ? " now" : ""}${selected ? " sel" : ""}`} onClick={() => onOpen(d.day)}
      aria-label={`${d.day}: ${d.races.length} race, ${d.planned.length} planned, ${d.completed.length} completed`}>
      <span className="cal-num">{Number(d.day.slice(8))}</span>
      {rows.slice(0, max).map((r) => <span key={r.key} className={`cal-chip ${r.cls}`} title={r.text}>{r.node}<span className="cal-txt">{r.text}</span></span>)}
      {hidden > 0 && <span className="cal-more">+{hidden} more</span>}
    </button>
  );
}

export function WeekGrid({ days, today, selected, onOpen }: { days: CalendarDay[]; today: string; selected: string | null; onOpen: (d: string) => void }) {
  return (
    <div className="cal-week" role="grid" aria-label="Week">
      {days.map((d, i) => (
        <div key={d.day} className="cal-weekcol"><div className="cal-wd">{WEEKDAYS[i]}</div><Cell d={d} today={today} compact={false} selected={selected === d.day} onOpen={onOpen} /></div>
      ))}
    </div>
  );
}

export function MonthGrid({ grid, byDay, today, selected, onOpen }: { grid: GridDay[][]; byDay: Map<string, CalendarDay>; today: string; selected: string | null; onOpen: (d: string) => void }) {
  return (
    <div className="cal-month" role="grid" aria-label="Month">
      {WEEKDAYS.map((w) => <div key={w} className="cal-wd">{w}</div>)}
      {grid.flat().map((g) => (
        <div key={g.day} className={g.inMonth ? "" : "cal-out"}><Cell d={byDay.get(g.day) ?? { day: g.day, planned: [], completed: [], races: [] }} today={today} compact selected={selected === g.day} onOpen={onOpen} /></div>
      ))}
    </div>
  );
}

export const Legend = () => (
  <div className="cal-legend small muted" aria-label="Legend">
    <span><span className="cal-chip plan">○ planned</span></span><span><span className="cal-chip plan s-completed">✓ completed plan</span></span>
    <span><span className="cal-chip done">● recorded session</span></span><span><span className="cal-chip race">race</span></span>
    <span>Types: {Object.values(KIND_LABEL).join(", ")}</span>
  </div>
);
