// Design System 1.0: the small pure helpers behind components/ui (no React, no DOM), so the rules are unit-testable.
// Tokens themselves live in app/globals.css (:root). Breakpoints (CSS media queries cannot read variables, so they are documented here and kept in
// one place): phone <= 520px, mobile layout <= 800px (bottom navigation), tablet <= 1100px, desktop above.

export const BREAKPOINTS = { phone: 520, mobile: 800, tablet: 1100 } as const;

export type Tone = "neutral" | "ok" | "info" | "warn" | "danger";
export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "md" | "sm";

/** One class string per variant/size/state. Existing `.btn`, `.btn.ghost` and `.btn.tiny` keep working; "ds-" classes only add states. */
export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md", extra = ""): string {
  const v = variant === "primary" ? "" : variant === "ghost" ? " ghost" : " secondary";
  return `btn ds-btn${v}${size === "sm" ? " tiny" : ""}${extra ? ` ${extra}` : ""}`;
}
export const badgeClass = (tone: Tone = "neutral"): string => `ds-badge ds-${tone}`;

/** Bar fill 0..100 for a value against a maximum. Presentation only: no value is changed, and an invalid input gives 0. */
export function progressPct(value: number | null | undefined, max: number | null | undefined): number {
  if (typeof value !== "number" || typeof max !== "number" || !Number.isFinite(value) || !Number.isFinite(max) || max <= 0 || value < 0) return 0;
  return Math.min(100, Math.round((value / max) * 100));
}

/** How old a reading is, as a badge: today's values carry no badge; older ones say so (never shown as if they were today's). */
export function freshnessBadge(freshness: "today" | "yesterday" | "stale" | "missing", ageText?: string): { text: string; tone: Tone } | null {
  if (freshness === "today") return null;
  if (freshness === "yesterday") return { text: "From yesterday", tone: "info" };
  if (freshness === "stale") return { text: ageText ? `Older: ${ageText}` : "Older data", tone: "warn" };
  return { text: "No data", tone: "neutral" };
}
