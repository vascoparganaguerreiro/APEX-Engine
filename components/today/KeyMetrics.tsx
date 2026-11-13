import MetricCard from "@/components/ui/MetricCard";
import { MetricSkeleton } from "@/components/ui/Skeleton";
import SectionHeader from "@/components/ui/SectionHeader";
import { LENS_METRICS, groupEmpty, metricSpecs, type Lens, type MetricInput, type NextAction } from "@/lib/today/lens";

/** The main physiological metrics, in the order that suits the person's view. Every value comes from the existing summaries; a missing one shows an honest empty state. */
export default function KeyMetrics({ lens, input, loading, nextKind }: { lens: Lens; input: MetricInput; loading: boolean; nextKind: NextAction["kind"] | null }) {
  const { filled, missing } = loading ? { filled: [], missing: [] } : groupEmpty(metricSpecs(input, LENS_METRICS[lens]), nextKind, input.wellnessProblem);
  return (
    <section aria-labelledby="td-metrics-h" aria-busy={loading || undefined}>
      <SectionHeader title="Key metrics" id="td-metrics-h" />
      <div className="ds-metric-grid">
        {loading ? LENS_METRICS[lens].slice(0, 4).map((k) => <MetricSkeleton key={k} />) : filled.map(({ key, ...m }) => <MetricCard key={key} {...m} />)}
        {!loading && missing.length > 0 && (
          <article className="ds-metric ds-metric-empty ds-missing" aria-label="Not available yet">
            <header className="ds-metric-head"><h3>Not available yet</h3></header>
            <ul className="ds-missing-list">{missing.map((g) => <li key={g.message}><b>{g.labels.join(", ")}</b><span>{g.message}</span></li>)}</ul>
          </article>
        )}
      </div>
      {loading && <p className="muted small" role="status">Loading your metrics…</p>}
    </section>
  );
}
