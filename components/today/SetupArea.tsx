import Link from "next/link";
import type { EmptyGroup } from "@/lib/today/lens";
import type { SetupModel } from "@/lib/today/setup";

/** ONE compact area for everything that is missing or unfinished: metrics that are not recorded (said once, grouped), profile or connection steps
 *  that matter for this person, and, collapsed, optional modules that are simply empty. Honest wording, no promotion, no fake values. */
export default function SetupArea({ groups, setup }: { groups: EmptyGroup[]; setup: SetupModel }) {
  if (groups.length === 0 && setup.needed.length === 0 && setup.optional.length === 0) return null;
  return (
    <section className="ds-setup" aria-labelledby="td-setup-h">
      <h3 id="td-setup-h">Missing or not set up</h3>
      {(groups.length > 0 || setup.needed.length > 0) && (
        <ul className="ds-setup-list">
          {groups.map((g) => <li key={g.message}><b>{g.labels.join(", ")}</b><span>{g.message}</span></li>)}
          {setup.needed.map((n) => <li key={n.id}><span>{n.text}</span>{n.actionLabel && <Link className="ds-setup-link" href={n.href}>{n.actionLabel}</Link>}</li>)}
        </ul>
      )}
      {setup.optional.length > 0 && (
        <details className="ds-setup-more">
          <summary>More you can add</summary>
          <ul>{setup.optional.map((o) => <li key={o.id}><Link href={o.href}>{o.text}</Link></li>)}</ul>
        </details>
      )}
    </section>
  );
}
