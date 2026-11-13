import Badge from "./Badge";
import Progress from "./Progress";
import type { Tone } from "@/lib/ui";

export interface MetricProps {
  label: string;
  /** The readable value. Metrics without one are not drawn as cards: they are listed once in the setup area (components/today/SetupArea.tsx). */
  value: string;
  unit?: string;
  /** One short line next to the value, in neutral wording (for example "+5% vs your average"). */
  delta?: string | null;
  /** The longer comparison or context sentence. Kept in the expandable details. */
  context?: string | null;
  /** Separately labelled supporting values (for example Fitness and Fatigue). */
  facts?: Array<{ label: string; value: string }>;
  /** Where the value came from and when. Kept in the expandable details. */
  source?: string | null;
  /** Status styling only where an existing validated interpretation provides it (the readiness band). Absent means neutral. */
  tone?: Tone;
  badge?: { text: string; tone: Tone } | null;
  /** What it means, in one or two sentences (in the expandable details). */
  explain: string;
  progress?: { value: number | null; max: number | null; label: string; text: string } | null;
}

/** One metric with a value, compact: name, value and unit first. Everything longer (comparison, source, meaning) is one tap away in "Details". */
export default function MetricCard(m: MetricProps) {
  const showContext = !!m.context && m.context !== m.delta;
  return (
    <article className={`ds-metric${m.tone ? ` ds-tone-${m.tone}` : ""}`}>
      <header className="ds-metric-head"><h3>{m.label}</h3>{m.badge && <Badge tone={m.badge.tone}>{m.badge.text}</Badge>}</header>
      <p className="ds-metric-value"><b>{m.value}</b>{m.unit && <small>{m.unit}</small>}</p>
      {m.delta && <p className="ds-metric-delta">{m.delta}</p>}
      {m.facts && m.facts.length > 0 && (
        <dl className="ds-facts">{m.facts.map((f) => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>
      )}
      {m.progress && <Progress {...m.progress} />}
      <details className="ds-explain">
        <summary>Details</summary>
        {showContext && <p>{m.context}</p>}
        {m.source && <p>Source: {m.source}</p>}
        <p>{m.explain}</p>
      </details>
    </article>
  );
}
