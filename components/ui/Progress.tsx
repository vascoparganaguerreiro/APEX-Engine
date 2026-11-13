import { progressPct } from "@/lib/ui";

/** A labelled progress bar (role="progressbar"). `text` is the readable form of the same information, for example "6 h 40 min of 8 h". */
export default function Progress({ value, max, label, text }: { value: number | null; max: number | null; label: string; text?: string }) {
  const pct = progressPct(value, max);
  return (
    <div className="ds-progress">
      <div className="ds-progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={text}>
        <i style={{ width: `${pct}%` }} />
      </div>
      {text && <small className="muted">{text}</small>}
    </div>
  );
}
