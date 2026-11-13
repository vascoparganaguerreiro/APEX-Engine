/** Loading placeholder shapes. Decorative (hidden from screen readers); the region that owns them sets aria-busy and a text status. */
export function Skeleton({ height = 16, width = "100%" }: { height?: number; width?: number | string }) {
  return <div className="ds-skel" style={{ height, width }} aria-hidden="true" />;
}
export function MetricSkeleton() {
  return <div className="ds-metric ds-metric-loading" aria-hidden="true"><Skeleton height={12} width="45%" /><Skeleton height={30} width="60%" /><Skeleton height={12} width="80%" /></div>;
}
