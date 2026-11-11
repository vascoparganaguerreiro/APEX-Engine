"use client";

export interface Line { label: string; color: string; values: Array<number | null>; dashed?: boolean }

const W = 600, H = 190, PL = 36, PR = 10, PT = 12, PB = 24;

/** Dependency-free SVG line chart. Gaps (null) break the line. `zero` draws a reference line at 0. */
export default function TrendChart({ title, days, lines, zero = false, unit = "" }: {
  title: string; days: string[]; lines: Line[]; zero?: boolean; unit?: string;
}) {
  const all = lines.flatMap((l) => l.values).filter((v): v is number => v !== null);
  const hasData = all.length > 0;
  let lo = hasData ? Math.min(...all, zero ? 0 : Infinity) : 0;
  let hi = hasData ? Math.max(...all, zero ? 0 : -Infinity) : 1;
  if (hi - lo < 1) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;

  const n = Math.max(days.length - 1, 1);
  const x = (i: number) => PL + (i / n) * (W - PL - PR);
  const y = (v: number) => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);
  const path = (vals: Array<number | null>) => {
    let d = "", pen = false;
    vals.forEach((v, i) => {
      if (v === null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
  const labelAt = [0, Math.floor(days.length / 2), days.length - 1].filter((i, k, a) => i >= 0 && a.indexOf(i) === k);

  return (
    <div className="card chart">
      <div className="act-head">
        <b>{title}</b>
        <span className="legend">
          {lines.map((l) => (
            <span key={l.label} className="muted small"><i style={{ background: l.color }} />{l.label}</span>
          ))}
        </span>
      </div>
      {!hasData ? (
        <p className="muted small">No data in this period.</p>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${title} trend over ${days.length} days`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PL} x2={W - PR} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth="1" />
              <text x={PL - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{Math.round(t)}{unit}</text>
            </g>
          ))}
          {zero && <line x1={PL} x2={W - PR} y1={y(0)} y2={y(0)} stroke="var(--muted)" strokeWidth="1" strokeDasharray="4 4" />}
          {lines.map((l) => (
            <path key={l.label} d={path(l.values)} fill="none" stroke={l.color} strokeWidth="2.2"
              strokeLinejoin="round" strokeLinecap="round" strokeDasharray={l.dashed ? "5 4" : undefined} />
          ))}
          {lines.map((l) => {
            const last = l.values.length - 1;
            const v = l.values[last];
            return v === null || v === undefined ? null : <circle key={l.label} cx={x(last)} cy={y(v)} r="3.5" fill={l.color} />;
          })}
          {labelAt.map((i) => (
            <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"} fontSize="11" fill="var(--muted)">
              {days[i].slice(5)}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}
