import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import { emphasis, type NextAction } from "@/lib/today/lens";

/** The one clear next step. Opens a page or the existing Quick log; it never writes anything itself. It is drawn strongly only when attention or a
 *  meaningful action is needed; on a routine day it is a calm, neutral card with a quiet button. */
export default function NextActionCard({ a, onAction }: { a: NextAction; onAction: (action: "log-wellness" | "log-supplements") => void }) {
  if (a.kind === "loading") return <section className="ds-next ds-next-loading" aria-busy="true" aria-label="Next step"><p className="muted" role="status">{a.title}</p></section>;
  const cta = a.cta, strong = emphasis(a.kind) === "strong", variant = strong ? "primary" : "secondary";
  return (
    <section className={`ds-next ${strong ? "ds-next-strong" : "ds-next-neutral"}`} aria-labelledby="td-next-h">
      <div className="ds-next-body">
        <div className="eyebrow">Next step {a.badge && <Badge tone={a.badge.tone}>{a.badge.text}</Badge>}</div>
        <h2 id="td-next-h">{a.title}</h2>
        <p>{a.detail}</p>
      </div>
      {cta && (cta.href ? <Button href={cta.href} variant={variant}>{cta.label}</Button> : <Button variant={variant} onClick={() => onAction(cta.action!)}>{cta.label}</Button>)}
    </section>
  );
}
