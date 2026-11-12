// Global Omni-Action model. Pure: no React, no routing, no storage, no network.
//
// Every action opens a workflow that ALREADY exists in APEX. Two kinds:
//   * "route"  : a page that owns the form (blood test, Strength Hub, Connections ...).
//   * "page"   : a drawer or form living inside a page (Today's Quick log, the Coach tabs, the Training "add" form). If the user is already
//                on that page the action is sent to it as an event; otherwise the page is opened with a query parameter that it reads once.
// Deliberately NOT listed (no supported workflow exists for them today): logging an activity by hand, adding a training note or symptom.

export const OMNI_OPEN_EVENT = "apex:omni-open";
export const OMNI_RUN_EVENT = "apex:omni-run";

export type OmniId = "log-wellness" | "log-supplements" | "add-blood-test" | "start-workout" | "import-strength" | "plan-session" | "ask-coach" | "evaluate-session" | "sync-activities";

export interface OmniAction {
  id: OmniId; label: string; hint: string; keywords: string[];
  /** Where the action opens (a real existing route, possibly with a query parameter that page reads). */
  href: string;
  /** When set, the action belongs to this page: if the user is on it, an event is sent instead of navigating. */
  page?: string;
}

export const OMNI_ACTIONS: OmniAction[] = [
  { id: "log-wellness", label: "Log wellness", hint: "HRV, resting heart rate, sleep", keywords: ["hrv", "rhr", "resting", "heart", "sleep", "morning", "readiness"], href: "/today?quick=wellness", page: "/today" },
  { id: "log-supplements", label: "Log supplements", hint: "Mark today's doses taken or skipped", keywords: ["supplement", "dose", "vitamin", "taken", "intake"], href: "/today?quick=supplements", page: "/today" },
  { id: "add-blood-test", label: "Add a blood test", hint: "Biomarkers: enter results or upload a report", keywords: ["biomarker", "blood", "lab", "panel", "ferritin", "results"], href: "/biomarkers/panels/new" },
  { id: "start-workout", label: "Start a workout", hint: "Strength Hub, works offline", keywords: ["strength", "gym", "lift", "workout", "routine", "train"], href: "/strength" },
  { id: "import-strength", label: "Import strength history", hint: "Add past sessions from a Hevy export", keywords: ["strength", "hevy", "csv", "import", "session", "history", "add"], href: "/strength/import" },
  { id: "plan-session", label: "Plan a training session", hint: "Add a session to your calendar", keywords: ["calendar", "plan", "schedule", "session", "workout", "run", "ride", "rest", "milestone", "add"], href: "/training?add=1", page: "/training" },
  { id: "ask-coach", label: "Ask the Coach", hint: "Chat about your training and recovery", keywords: ["coach", "ask", "chat", "question", "ai"], href: "/coach?tab=ask", page: "/coach" },
  { id: "evaluate-session", label: "Evaluate a session", hint: "APEX Coach scores a workout", keywords: ["coach", "evaluate", "score", "session", "workout", "review"], href: "/coach?tab=session", page: "/coach" },
  { id: "sync-activities", label: "Sync or import activities", hint: "Connections: Intervals.icu, WHOOP and more", keywords: ["activity", "activities", "sync", "import", "garmin", "intervals", "connect", "device", "log"], href: "/integrations" },
];

// ------------------------------------------------------------------ keyboard
export interface KeyLike { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }
/** Ctrl+K (Windows/Linux) or Cmd+K (Mac), without Alt or Shift. */
export const isPaletteShortcut = (e: KeyLike): boolean => !!(e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === "k";
/** "⌘K" on Apple platforms, "Ctrl K" elsewhere. */
export const shortcutLabel = (platform: string): string => (/mac|iphone|ipad|ipod/i.test(platform) ? "⌘K" : "Ctrl K");

/** Wrap-around move through a list (ArrowDown = +1, ArrowUp = -1). */
export const moveIndex = (i: number, delta: number, n: number): number => (n <= 0 ? -1 : (((i + delta) % n) + n) % n);

// ------------------------------------------------------------------ search
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
/** Actions matching every word of the query (label, hint or keywords). Label matches first; an empty query returns everything in order. */
export function filterActions(query: string, actions: OmniAction[] = OMNI_ACTIONS): OmniAction[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return actions;
  const scored: Array<[OmniAction, number]> = [];
  for (const a of actions) {
    const label = norm(a.label), rest = norm(`${a.hint} ${a.keywords.join(" ")}`);
    let score = 0, ok = true;
    for (const w of words) {
      if (label.startsWith(w) || label.includes(` ${w}`)) score += 3;
      else if (label.includes(w)) score += 2;
      else if (rest.includes(w)) score += 1;
      else { ok = false; break; }
    }
    if (ok) scored.push([a, score]);
  }
  return scored.sort((x, y) => y[1] - x[1] || OMNI_ACTIONS.indexOf(x[0]) - OMNI_ACTIONS.indexOf(y[0])).map(([a]) => a);
}

// ------------------------------------------------------------------ routing
export type OmniTarget = { kind: "navigate"; href: string } | { kind: "event"; id: OmniId };
/** On the action's own page it is delivered as an event (no reload, no URL change); anywhere else the page is opened. */
export function resolveTarget(a: OmniAction, pathname: string): OmniTarget {
  if (a.page && (pathname === a.page || pathname.startsWith(a.page + "/"))) return { kind: "event", id: a.id };
  return { kind: "navigate", href: a.href };
}

// ------------------------------------------------------------------ the parameters pages read once on arrival
const param = (search: string, key: string): string | null => { try { return new URLSearchParams(search).get(key); } catch { return null; } };
export const quickFromSearch = (search: string): "wellness" | "supplements" | null => { const v = param(search, "quick"); return v === "wellness" || v === "supplements" ? v : null; };
export const COACH_TABS = ["session", "daily", "ask", "plan"] as const;
export type CoachTab = (typeof COACH_TABS)[number];
export const coachTabFromSearch = (search: string): CoachTab | null => { const v = param(search, "tab"); return (COACH_TABS as readonly string[]).includes(v ?? "") ? (v as CoachTab) : null; };
/** `?add=1` (today) or `?add=YYYY-MM-DD`. Returns "today", a valid date, or null. */
export function addFromSearch(search: string): "today" | string | null {
  const v = param(search, "add");
  if (v === null) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { const [y, m, d] = v.split("-").map(Number), t = new Date(Date.UTC(y, m - 1, d)); if (t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d) return v; }
  return "today";
}

/** What the event listeners receive: which action was run. */
export interface OmniRunDetail { id: OmniId }
export function emitRun(id: OmniId, target: Pick<EventTarget, "dispatchEvent"> = window): void {
  target.dispatchEvent(new CustomEvent<OmniRunDetail>(OMNI_RUN_EVENT, { detail: { id } }));
}
