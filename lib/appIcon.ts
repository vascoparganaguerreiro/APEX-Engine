// The APEX app icon: a bold, minimal geometric "A" on a full-bleed dark background. Pure data and geometry (no React, no I/O) so the route
// (app/icons/[size]/route.tsx) stays thin and the rules (sizes, maskable safe zone) are testable. Colours are the app's own tokens.
import { createElement } from "react";

export const ICON_BG = "#06080b";          // --bg, also the manifest background and theme colour
export const ICON_FROM = "#2ee6a6";        // --green
export const ICON_TO = "#4da3ff";          // --blue

/** The mark on a 100 x 100 grid: one outline (the A with its open base) and one counter (the closed triangle above the crossbar). Fill with the even-odd rule.
 *  Legs and crossbar are about 16 units thick, so it reads at 32 px as well as at 512 px. It spans x 10..90 and y 10..90, centred on (50, 50). */
export const MARK_OUTLINE = "M50 10 L90 90 L72 90 L63 72 L37 72 L28 90 L10 90 Z";
export const MARK_COUNTER = "M50 46 L57 60 L43 60 Z";
export const MARK_PATH = `${MARK_OUTLINE} ${MARK_COUNTER}`;
/** The farthest point of the mark from its centre, in grid units (the two feet). */
export const MARK_RADIUS = Math.hypot(40, 40);

export type IconKey = "32" | "180" | "192" | "512" | "maskable";
export type IconPurpose = "favicon" | "any" | "maskable";
/** px: the square canvas. mark: the size of the 100-unit grid as a share of the canvas (so the A itself is 80% of that). */
export const ICONS: Record<IconKey, { px: number; mark: number; purpose: IconPurpose }> = {
  "32": { px: 32, mark: 0.94, purpose: "favicon" },       // browser tab: as large as it can be (the A is 24 of 32 px wide)
  "180": { px: 180, mark: 0.74, purpose: "any" },         // iOS home screen (iOS rounds the corners itself)
  "192": { px: 192, mark: 0.74, purpose: "any" },         // Android / manifest
  "512": { px: 512, mark: 0.74, purpose: "any" },         // Android / manifest
  "maskable": { px: 512, mark: 0.6, purpose: "maskable" }, // Android adaptive icon: the system crops it (circle, squircle...), so the mark stays well inside
};
export const ICON_KEYS = Object.keys(ICONS) as IconKey[];
export const isIconKey = (s: string): s is IconKey => Object.prototype.hasOwnProperty.call(ICONS, s);

/** Side of the square that holds the mark, in pixels. */
export const markSize = (k: IconKey): number => Math.round(ICONS[k].px * ICONS[k].mark);
/** Distance from the canvas centre to the farthest point of the mark, as a share of the canvas side. */
export const markReach = (k: IconKey): number => (MARK_RADIUS / 100) * (markSize(k) / ICONS[k].px);
/** Maskable icons: the platform guarantees only the central circle of 80% of the canvas, i.e. radius 0.4. */
export const MASKABLE_SAFE_RADIUS = 0.4;

/** The icon as an element tree (React.createElement, no JSX, so tests can render it without a build): a full-bleed dark square, the A centred on it, drawn from
 *  MARK_PATH. A vector shape with the even-odd rule, not a font glyph, and no inset tile. The route and the tests render this same element. */
export function iconElement(k: IconKey) {
  const s = markSize(k);
  return createElement("div", { style: { width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: ICON_BG } },
    createElement("svg", { width: s, height: s, viewBox: "0 0 100 100" },
      createElement("defs", null,
        createElement("linearGradient", { id: "apex", x1: "0", y1: "0", x2: "1", y2: "1" },
          createElement("stop", { offset: "0", stopColor: ICON_FROM }), createElement("stop", { offset: "1", stopColor: ICON_TO }))),
      createElement("path", { d: MARK_PATH, fill: "url(#apex)", fillRule: "evenodd" })));
}
