import Badge from "./Badge";
import Progress from "./Progress";
import type { Tone } from "@/lib/ui";

export interface MetricProps {
  label: string;
  /** The readable value, or null when there is none: the card then shows `empty` (an honest empty state), never a placeholder number. */
  value: string | null;
  unit?: string;
  /** Comparison with the person's own baseline or goal, when it exists. */
  context?: string | null;
  tone?: Tone;
  badge?: { text: string; tone: Tone } | null;
  /** What it means, in one or two sentences (collapsed by default). */
  explain: string;
  /** Shown instead of a value: what is missing and what to do about it. */
  empty: string;
  progress?: { value: number | null; max: number | null; label: string; text: string } | null;
}

/** One physiological metric: label, value, context, short explanation, and an honest empty state. */
export default function MetricCard(m: MetricProps) {
  const has = m.value !== null;
  return (
    <article className={`ds-metric${has ? "" : " ds-metric-empty"}${m.tone ? ` ds-tone-${m.tone}` : ""}`} aria-label={m.label}>
      <header className="ds-metric-head"><h3>{m.label}</h3>{m.badge && <Badge tone={m.badge.tone}>{m.badge.text}</Badge>}</header>
      {has ? (
        <>
          <p className="ds-metric-value"><b>{m.value}</b>{m.unit && <small>{m.unit}</small>}</p>
          {m.context && <p className="ds-metric-context">{m.context}</p>}
          {m.progress && <Progress {...m.progress} />}
        </>
      ) : <p className="ds-metric-none">{m.empty}</p>}
      <details className="ds-explain"><summary>What this means</summary><p>{m.explain}</p></details>
    </article>
  );
}
