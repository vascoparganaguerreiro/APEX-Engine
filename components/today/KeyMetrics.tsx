import MetricCard from "@/components/ui/MetricCard";
import { MetricSkeleton } from "@/components/ui/Skeleton";
import SectionHeader from "@/components/ui/SectionHeader";
import SetupArea from "@/components/today/SetupArea";
import { LENS_METRICS, groupEmpty, metricSpecs, type Lens, type MetricInput, type NextAction } from "@/lib/today/lens";
import type { SetupModel } from "@/lib/today/setup";

/** The main physiological metrics, in the order that suits the person's view. Every value comes from the existing summaries. Metrics without a value
 *  are not drawn as empty cards: they are listed once, with anything else that is missing, in the setup area underneath. */
export default function KeyMetrics({ lens, input, loading, nextKind, setup }: { lens: Lens; input: MetricInput; loading: boolean; nextKind: NextAction["kind"] | null; setup: SetupModel }) {
  const { filled, missing } = loading ? { filled: [], missing: [] } : groupEmpty(metricSpecs(input, LENS_METRICS[lens]), nextKind, input.wellnessProblem);
  return (
    <section aria-labelledby="td-metrics-h" aria-busy={loading || undefined}>
      <SectionHeader title="Key metrics" id="td-metrics-h" />
      {(loading || filled.length > 0) && (
        <div className="ds-metric-grid">
          {loading ? LENS_METRICS[lens].slice(0, 4).map((k) => <MetricSkeleton key={k} />) : filled.map(({ key, ...m }) => <MetricCard key={key} {...m} />)}
        </div>
      )}
      {loading && <p className="muted small" role="status">Loading your metrics…</p>}
      {!loading && <SetupArea groups={missing} setup={setup} />}
    </section>
  );
}
