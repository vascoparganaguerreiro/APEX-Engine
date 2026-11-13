import { badgeClass, type Tone } from "@/lib/ui";

/** A short status label. Colour is never the only signal: the text always says what it means. */
export default function Badge({ tone = "neutral", children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className={badgeClass(tone)}>{children}</span>;
}
