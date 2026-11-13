// Navigation model shared by the desktop sidebar and the mobile bottom bar. Pure: no React, no routing, no auth.
// Only existing routes are listed here; nothing in this file creates a page.

export interface NavItem { href: string; label: string }

/** Desktop sidebar: the original items in the original order (unchanged by the mobile navigation). */
export const DESKTOP_NAV: NavItem[] = [
  { href: "/today", label: "Today" },
  { href: "/activities", label: "Activities" },
  { href: "/strength", label: "Strength" },
  { href: "/integrations", label: "Connections" },
  { href: "/training", label: "Training" },
  { href: "/coach", label: "Coach" },
  { href: "/supplements", label: "Supplements" },
  { href: "/biomarkers", label: "Biomarkers" },
  { href: "/timeline", label: "Timeline" },
  { href: "/races", label: "Races" },
  { href: "/profile", label: "Profile" },
];

/** Mobile bottom bar: Today, Activities, Coach, then "More" (Design System 1.0). Training moved into More; its route is unchanged. */
export const PRIMARY_NAV: NavItem[] = [
  { href: "/today", label: "Today" },
  { href: "/activities", label: "Activities" },
  { href: "/coach", label: "Coach" },
];

/** The More sheet's groups. Destinations are looked up in the desktop list (same routes, same labels), so none can be invented, renamed or lost.
 *  "account" holds settings-type destinations; the account ACTIONS (who is signed in, Sign out) are not destinations and are drawn separately. */
export interface NavGroup { id: "train" | "health" | "account"; label: string; items: NavItem[] }
const pick = (...hrefs: string[]): NavItem[] => hrefs.map((h) => DESKTOP_NAV.find((n) => n.href === h)!);
export const MORE_GROUPS: NavGroup[] = [
  { id: "train", label: "Training", items: pick("/training", "/strength", "/races") },
  { id: "health", label: "Health", items: pick("/biomarkers", "/supplements", "/timeline") },
  { id: "account", label: "Settings and account", items: pick("/integrations", "/profile") },
];
/** Every destination that is not on the bottom bar, in the order the More sheet shows them. */
export const MORE_NAV: NavItem[] = MORE_GROUPS.flatMap((g) => g.items);

/** A route is active on its own path and on anything below it (/races/12 keeps Races active). */
export const isActive = (path: string, href: string): boolean => path === href || path.startsWith(href + "/");

/** The destination of the bottom bar that is highlighted: a primary item, "more" for any route inside More, or null (e.g. an unknown path). */
export type BottomTab = "today" | "activities" | "coach" | "more";
export function activeTab(path: string): BottomTab | null {
  const p = PRIMARY_NAV.find((n) => isActive(path, n.href));
  if (p) return p.href.slice(1) as BottomTab;
  return MORE_NAV.some((n) => isActive(path, n.href)) ? "more" : null;
}

/** True when focus is in something the on-screen keyboard opens for. The bottom bar hides meanwhile so it can never cover the keyboard. */
export function opensKeyboard(el: { tagName?: string; isContentEditable?: boolean; type?: string } | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !["button", "submit", "reset", "checkbox", "radio", "range", "file", "color", "image"].includes(String(el.type ?? "text").toLowerCase());
}

/** A short touchscreen held sideways (a phone in landscape): wider than 800px but not tall enough for the desktop layout. */
export const SHORT_LANDSCAPE_MEDIA = "(orientation: landscape) and (pointer: coarse) and (max-height: 500px) and (max-width: 1000px)";
/** The phone layout (bottom bar, compact sheets). Must stay equal to the CSS query in app/globals.css (tests compare them). */
export const PHONE_MEDIA = `(max-width: 800px), ${SHORT_LANDSCAPE_MEDIA}`;
