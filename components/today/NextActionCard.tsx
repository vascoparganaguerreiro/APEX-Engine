import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import type { NextAction } from "@/lib/today/lens";

/** The one clear next step. Opens a page or the existing Quick log; it never writes anything itself. */
export default function NextActionCard({ a, onAction }: { a: NextAction; onAction: (action: "log-wellness" | "log-supplements") => void }) {
  if (a.kind === "loading") return <section className="ds-next ds-next-loading" aria-busy="true" aria-label="Next step"><p className="muted" role="status">{a.title}</p></section>;
  const cta = a.cta;
  return (
    <section className="ds-next" aria-labelledby="td-next-h">
      <div className="ds-next-body">
        <div className="eyebrow">Next step {a.badge && <Badge tone={a.badge.tone}>{a.badge.text}</Badge>}</div>
        <h2 id="td-next-h">{a.title}</h2>
        <p>{a.detail}</p>
      </div>
      {cta && (cta.href ? <Button href={cta.href}>{cta.label}</Button> : <Button onClick={() => onAction(cta.action!)}>{cta.label}</Button>)}
    </section>
  );
}
