"use client";
import { rangeStatus, sameRange, type SupplementEvent, type UnitSeries } from "@/lib/health/core";

const W = 640, H = 240, PL = 46, PR = 14, PT = 20, PB = 28;
const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const COLOR = { within: "var(--green)", below: "var(--amber)", above: "var(--red)", unknown: "var(--blue)" } as const;

/** One unit only (the caller splits by unit). Points are real measurements; each lab range is drawn at its own date
 *  (never as one continuous band), and the line is dashed wherever the reference range changed between two tests. */
export default function BiomarkerChart({ series, events }: { series: UnitSeries; events: SupplementEvent[] }) {
  const pts = series.points;
  const t0 = ms(pts[0].collected_on), t1 = ms(pts[pts.length - 1].collected_on);
  const span = Math.max(t1 - t0, DAY);
  const vals = pts.flatMap((p) => [p.value, p.ref_low, p.ref_high]).filter((v): v is number => v !== null);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
  const x = (d: string) => (pts.length === 1 ? (PL + W - PR) / 2 : PL + ((ms(d) - t0) / span) * (W - PL - PR));
  const y = (v: number) => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);
  const inside = events.filter((e) => ms(e.date) >= t0 && ms(e.date) <= t1);
  const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
  const fmt = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(Math.abs(n) >= 10 ? 1 : 2));
  const mark = { start: "var(--green)", stop: "var(--amber)", schedule: "var(--blue)" } as const;
  const glyph = { start: "▲", stop: "■", schedule: "◆" } as const;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${series.points.length} measurements in ${series.unit}`}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PL} x2={W - PR} y1={y(t)} y2={y(t)} stroke="var(--line)" />
          <text x={PL - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{fmt(t)}</text>
        </g>
      ))}
      {inside.map((e, i) => (
        <g key={`${e.type}-${e.supplement_id}-${e.date}-${i}`}>
          <line x1={x(e.date)} x2={x(e.date)} y1={PT - 6} y2={H - PB} stroke={mark[e.type]} strokeDasharray="3 4" opacity="0.7" />
          <text x={x(e.date)} y={PT - 8} textAnchor="middle" fontSize="10" fill={mark[e.type]}><title>{`${e.date}: ${e.label}`}</title>{glyph[e.type]}</text>
        </g>
      ))}
      {pts.map((p) => p.ref_low !== null || p.ref_high !== null ? (
        <line key={`r${p.id}`} x1={x(p.collected_on)} x2={x(p.collected_on)} stroke="var(--green)" strokeWidth="7" strokeLinecap="round" opacity="0.22"
          y1={y(p.ref_high ?? hi - pad)} y2={y(p.ref_low ?? lo + pad)} />
      ) : null)}
      {pts.slice(1).map((p, i) => {
        const a = pts[i];
        return <line key={`l${p.id}`} x1={x(a.collected_on)} y1={y(a.value)} x2={x(p.collected_on)} y2={y(p.value)} stroke="var(--blue)" strokeWidth="2"
          strokeDasharray={sameRange(a, p) ? undefined : "5 5"} opacity={sameRange(a, p) ? 1 : 0.6} />;
      })}
      {pts.map((p) => (
        <circle key={p.id} cx={x(p.collected_on)} cy={y(p.value)} r="5" fill={COLOR[rangeStatus(p.value, p.ref_low, p.ref_high)]} stroke="var(--bg)" strokeWidth="1.5">
          <title>{`${p.collected_on}: ${p.value} ${p.unit}${p.ref_low !== null || p.ref_high !== null ? ` (lab range ${p.ref_low ?? "–"} to ${p.ref_high ?? "–"})` : ""}`}</title>
        </circle>
      ))}
      <text x={PL} y={H - 8} fontSize="11" fill="var(--muted)">{pts[0].collected_on}</text>
      {pts.length > 1 && <text x={W - PR} y={H - 8} textAnchor="end" fontSize="11" fill="var(--muted)">{pts[pts.length - 1].collected_on}</text>}
    </svg>
  );
}
