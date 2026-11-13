// Profile-aware PRESENTATION of Today. Pure: no React, no storage, no network.
//
// Nothing here measures or calculates anything physiological. Every number comes from the existing summaries in lib/today/model.ts
// (the readiness estimate, personal baselines, training form and load), and every sentence about readiness is the engine's own
// `guidance`. This file only decides WHICH of those existing values come first, and what the one "next step" is.
//
// Which view applies (lib/experience.ts resolveExperience): the experience the person chose (kept per account in this browser) first; with no choice, the
// one derived from their primary goal (lib/profile.ts GOALS, fixed table below); with neither, Performance (the layout Today already had), and the page says so.
import { freshnessBadge, type Tone } from "../ui.ts";
import { relDay, shortDate, type EnduranceSummary, type Reading, type StrengthSummary, type SupplementSummary, type WellnessSummary } from "./model.ts";
import { formFacts, sourceText } from "./format.ts";

export type Lens = "performance" | "wellness" | "longevity";
export const LENS_LABEL: Record<Lens, string> = { performance: "Performance", wellness: "Health & Wellness", longevity: "Longevity" };

const GOAL_LENS: Record<string, Lens> = {
  race_performance: "performance", speed: "performance", endurance: "performance",
  general_fitness: "wellness", weight_management: "wellness", return_from_injury: "wellness",
  health: "longevity",                                  // "Health and longevity"
};
export function lensFromGoal(goal: string | null | undefined): { lens: Lens; basis: "goal" | "default" } {
  const l = goal ? GOAL_LENS[goal] : undefined;
  return l ? { lens: l, basis: "goal" } : { lens: "performance", basis: "default" };
}

export type MetricKey = "readiness" | "sleep" | "hrv" | "rhr" | "recovery" | "form" | "weekload" | "sessions";
export type SectionKey = "wellness" | "endurance" | "strength" | "race" | "supplements" | "biomarkers";

/** Which headline metrics, in which order. Performance: readiness and training context first. Wellness: sleep, energy and recovery first.
 *  Longevity: sleep and recovery signals, then consistency of activity. */
export const LENS_METRICS: Record<Lens, MetricKey[]> = {
  performance: ["readiness", "hrv", "rhr", "form", "weekload", "sleep", "recovery"],
  wellness: ["sleep", "readiness", "hrv", "rhr", "recovery", "sessions"],
  longevity: ["sleep", "hrv", "rhr", "sessions", "readiness", "recovery"],
};
/** Order of the detail cards below the headline metrics. Every card is always present; only the order changes. */
export const LENS_SECTIONS: Record<Lens, SectionKey[]> = {
  performance: ["endurance", "strength", "race", "wellness", "supplements", "biomarkers"],
  wellness: ["wellness", "supplements", "strength", "endurance", "biomarkers", "race"],
  longevity: ["biomarkers", "strength", "wellness", "endurance", "supplements", "race"],
};

// ------------------------------------------------------------------ metric cards
export interface MetricSpec {
  key: MetricKey; label: string; value: string | null; unit?: string; tone?: Tone;
  /** One short line shown with the value (for example "+5% vs your average"). Neutral wording: a higher or lower number is never called good or bad here. */
  delta: string | null;
  /** The longer comparison or context sentence. Shown in the expandable details. */
  context: string | null;
  /** Separately labelled supporting values (for example Fitness and Fatigue). */
  facts?: Array<{ label: string; value: string }>;
  /** Where the value came from and when, in plain words. Shown in the expandable details. */
  source?: string | null;
  badge: { text: string; tone: Tone } | null; explain: string; empty: string;
  /** "wellness": the empty text is the generic wellness instruction (log or connect), which the Next step card may already be giving. */
  emptyKind?: "wellness";
  progress: { value: number | null; max: number | null; label: string; text: string } | null;
}
export const fmtSleep = (min: number): string => `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, "0")} min`;
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const BAND_TEXT = { above: "At or above your usual", mixed: "Mixed compared with your usual", below: "Below your usual" } as const;
const BAND_TONE = { above: "ok", mixed: "info", below: "warn" } as const;

export interface MetricInput {
  w: WellnessSummary | null; wellnessProblem: string | null; e: EnduranceSummary | null; st: StrengthSummary | null;
  whoop: { value: number; day: string | null } | null; sleepGoalH: number | null; today: string;
}

const NO_WELLNESS = "No value yet. Log it in Quick log or connect a device.";
export function metricSpecs(i: MetricInput, keys: readonly MetricKey[]): MetricSpec[] {
  const { w, e, st, today } = i;
  const missing = (why: string) => (i.wellnessProblem ?? why);
  /** "yesterday, Thu 12 Nov · synced from Intervals.icu". An unknown or absent source is "source not recorded", never the raw stored value. */
  const provenance = (r: Reading | null): string | null => (r ? `${r.freshness === "today" ? "Today" : `${relDay(r.day, today)}, ${shortDate(r.day)}`} · ${sourceText(r.source)}` : null);
  const build: Record<MetricKey, () => MetricSpec> = {
    readiness: () => {
      const est = w?.estimate;
      const ok = est?.status === "ok" ? est : null;
      return {
        key: "readiness", label: "Readiness estimate", value: ok ? String(ok.score) : null, unit: ok ? "/ 100" : undefined,
        delta: ok ? BAND_TEXT[ok.band] : null,
        context: ok ? `${BAND_TEXT[ok.band]} · ${ok.confidence} confidence${ok.provisional ? " (provisional)" : ""}` : null,
        tone: ok ? BAND_TONE[ok.band] : undefined, badge: ok?.provisional ? { text: "Provisional", tone: "warn" } : null,
        explain: "APEX Readiness Estimate: today's measurements compared with your own baseline. It is an estimate, not a clinical measurement or a diagnosis.",
        empty: est?.status === "insufficient" ? `Not enough data yet. ${est.reasons[0] ?? ""}`.trim() : missing("Not enough data yet."), progress: null,
        emptyKind: est?.status === "insufficient" ? undefined : "wellness",
      };
    },
    hrv: () => {
      const r = w?.hrv ?? null, b = w?.hrvVsBaseline ?? null;
      return {
        key: "hrv", label: "HRV (rMSSD)", value: r ? String(Math.round(r.value)) : null, unit: r ? "ms" : undefined,
        delta: r && b && r.day === today ? `${signed(b.pct)}% vs your average` : null, source: provenance(r),
        context: r ? (b && r.day === today ? `${signed(b.pct)}% vs your ${b.days}-day average (${b.mean} ms)` : b ? `Compared with your ${b.days}-day average of ${b.mean} ms` : "Not enough history for your personal average yet") : null,
        badge: r ? freshnessBadge(r.freshness, relDay(r.day, today)) : null,
        explain: "APEX shows heart-rate variability (HRV) as rMSSD, in milliseconds. It reflects how your body is responding to recent load and recovery. Other apps and devices may report a different HRV measure (for example SDNN), and those numbers are not comparable with this one. It is only meaningful against your own average, never against other people.",
        empty: missing(NO_WELLNESS), progress: null, emptyKind: "wellness",
      };
    },
    rhr: () => {
      const r = w?.rhr ?? null, b = w?.rhrVsBaseline ?? null;
      return {
        key: "rhr", label: "Resting heart rate", value: r ? String(Math.round(r.value)) : null, unit: r ? "bpm" : undefined,
        delta: r && b ? `${signed(b.diff)} bpm vs your average` : null, source: provenance(r),
        context: r ? (b ? `${signed(b.diff)} bpm vs your ${b.days}-day average (${b.mean} bpm)` : "Not enough history for your personal average yet") : null,
        badge: r ? freshnessBadge(r.freshness, relDay(r.day, today)) : null,
        explain: "Your heart rate at rest. A change from your own usual level can reflect fatigue, stress, illness or fitness. Look at the trend, not one day.",
        empty: missing(NO_WELLNESS), progress: null, emptyKind: "wellness",
      };
    },
    sleep: () => {
      const r = w?.sleep ?? null, goal = i.sleepGoalH;
      return {
        key: "sleep", label: "Sleep", value: r ? fmtSleep(r.value) : null,
        delta: r && goal ? `Goal ${goal} h` : null, source: provenance(r),
        context: r ? (goal ? `Your goal: ${goal} h` : "No sleep goal set") : null,
        badge: r ? freshnessBadge(r.freshness, relDay(r.day, today)) : null,
        explain: "How long you slept, compared with the sleep goal you set in your profile. The sleep score, when shown elsewhere, comes from your device and is not comparable between vendors.",
        empty: missing(NO_WELLNESS), emptyKind: "wellness",
        progress: r && goal ? { value: r.value, max: goal * 60, label: "Sleep compared with your goal", text: `${fmtSleep(r.value)} of ${goal} h` } : null,
      };
    },
    recovery: () => ({
      key: "recovery", label: "Recovery (WHOOP)", value: i.whoop ? String(Math.round(i.whoop.value)) : null, unit: i.whoop ? "%" : undefined,
      delta: null, source: i.whoop ? `WHOOP${i.whoop.day ? `, ${relDay(i.whoop.day, today)}` : ""}` : null,
      context: i.whoop ? (i.whoop.day ? `Recorded ${relDay(i.whoop.day, today)}` : null) : null,
      badge: i.whoop?.day && i.whoop.day !== today ? { text: "Not today", tone: "info" } : null,
      explain: "WHOOP's own recovery score, shown as it comes from WHOOP. It is a different measure from the APEX readiness estimate and the two are not combined.",
      empty: "Connect WHOOP in Connections to see this.", progress: null,
    }),
    form: () => {
      const f = e?.form ? formFacts(e.form) : null;
      return {
        key: "form", label: "Training form", value: f ? f.tsb : null, unit: f ? "TSB" : undefined,
        delta: f?.state ?? null, facts: f ? [{ label: "Fitness", value: f.fitness }, { label: "Fatigue", value: f.fatigue }] : undefined,
        context: f ? `${f.state ? `${f.state}. ` : ""}Fitness ${f.fitness}, fatigue ${f.fatigue}.` : null, badge: null,
        explain: "Form (TSB) is fitness minus fatigue in the training-load model. Negative values mean recent load is high compared with what you are used to; it needs a history of activities with a training load.",
        empty: "Needs activities with a training load.", progress: null,
      };
    },
    weekload: () => ({
      key: "weekload", label: "Load, last 7 days", value: e && e.week.sessions > 0 ? String(e.week.load) : null,
      delta: e && e.week.sessions > 0 ? `${e.week.sessions} session${e.week.sessions === 1 ? "" : "s"}` : null,
      context: e && e.week.sessions > 0 ? `${e.week.sessions} session${e.week.sessions === 1 ? "" : "s"} · previous 7 days: ${e.week.prevLoad}` : null, badge: null,
      explain: "The total training load of your endurance sessions over the last seven days, next to the seven days before.",
      empty: "No endurance sessions in the last 7 days.", progress: null,
    }),
    sessions: () => {
      const n = (e?.week.sessions ?? 0) + (st?.weekSessions ?? 0), known = e !== null || st !== null;
      return {
        key: "sessions", label: "Active sessions", value: known ? String(n) : null, unit: known ? (n === 1 ? "session" : "sessions") : undefined,
        delta: null,
        context: known ? "Endurance (last 7 days) plus strength (this week)" : null, badge: null,
        explain: "How many training sessions you logged recently, as a simple measure of consistency. It does not judge intensity or quality.",
        empty: "No activity data yet. Sync or import activities, or log a workout.", progress: null,
      };
    },
  };
  // Recovery comes only from WHOOP: with no WHOOP value there is nothing to show and nothing to promote, so it is left out (not an empty card).
  return keys.filter((k) => k !== "recovery" || i.whoop !== null).map((k) => build[k]());
}

// ------------------------------------------------------------------ empty metrics, grouped
export interface EmptyGroup { labels: string[]; message: string }
/** Metrics with a value stay as cards. Metrics without one are listed ONCE, grouped by what is missing, instead of one repeated card each.
 *  When the Next step card is already asking for wellness (or saying it is unavailable) the wellness lines point to it instead of repeating the instruction. */
export type FilledMetric = MetricSpec & { value: string };
export function groupEmpty(specs: MetricSpec[], nextKind: NextAction["kind"] | null, problem: string | null): { filled: FilledMetric[]; missing: EmptyGroup[] } {
  const filled = specs.filter((m): m is FilledMetric => m.value !== null);
  const order: string[] = [], by = new Map<string, string[]>();
  for (const m of specs) {
    if (m.value !== null) continue;
    let msg = m.empty;
    if (m.emptyKind === "wellness") {
      if (problem && nextKind === "data-unavailable") msg = "Not shown while wellness data is unavailable.";
      else if (!problem && nextKind === "log-wellness") msg = "No reading for today yet.";
    }
    if (!by.has(msg)) { by.set(msg, []); order.push(msg); }
    by.get(msg)!.push(m.label);
  }
  return { filled, missing: order.map((message) => ({ labels: by.get(message)!, message })) };
}

// ------------------------------------------------------------------ the one next step
export interface NextAction {
  kind: "loading" | "data-unavailable" | "resume-workout" | "log-wellness" | "readiness-guidance" | "provisional" | "log-supplements" | "ask-coach";
  title: string; detail: string; badge: { text: string; tone: Tone } | null;
  /** A page to open, or a Today action (opens the Quick log). */
  cta: { label: string; href?: string; action?: "log-wellness" | "log-supplements" } | null;
}
export interface ActionInput {
  w: WellnessSummary | null; loading: boolean; activeWorkout: { title: string } | null; sup: SupplementSummary | null;
  /** The reason the wellness data could not be loaded, or null/absent when it loaded. "Could not load" is not the same as "no measurements". */
  problem?: string | null;
}
/** First rule that applies wins. Everything is read from existing summaries; no new advice is written here. */
export function nextAction(a: ActionInput): NextAction {
  if (a.activeWorkout) return { kind: "resume-workout", title: "Continue your workout", detail: `${a.activeWorkout.title} is in progress on this device.`, badge: { text: "In progress", tone: "info" }, cta: { label: "Open workout", href: "/strength" } };
  if (a.loading && !a.w) return { kind: "loading", title: "Checking your day…", detail: "", badge: null, cta: null };
  // The wellness data could not be loaded: say so. Nothing is inferred about the person's measurements and nothing is recommended from it.
  if (a.problem) return { kind: "data-unavailable", title: "Wellness data is unavailable", detail: `${/[.!?]$/.test(a.problem.trim()) ? a.problem.trim() : `${a.problem.trim()}.`} Your readiness and today's guidance cannot be shown until it loads.`, badge: { text: "Unavailable", tone: "warn" }, cta: null };
  const w = a.w;
  if (!w || w.state === "missing") return { kind: "log-wellness", title: "Add today's wellness", detail: "APEX has no HRV, resting heart rate or sleep for you yet. Log them or connect a device to get a readiness estimate.", badge: null, cta: { label: "Log wellness", action: "log-wellness" } };
  const est = w.estimate;
  if (est.status === "ok" && est.guidance) return { kind: "readiness-guidance", title: "Today's guidance", detail: est.guidance, badge: { text: `${est.confidence} confidence`, tone: est.confidence === "low" ? "warn" : "info" }, cta: { label: "Ask the Coach", href: "/coach?tab=daily" } };
  if (est.status === "ok") return { kind: "provisional", title: "Your estimate is provisional", detail: "There is not enough of your own history yet, so APEX gives no training suggestion today. Go by how you feel.", badge: { text: "Provisional", tone: "warn" }, cta: { label: "Log wellness", action: "log-wellness" } };
  if (w.state !== "current") return { kind: "log-wellness", title: "Complete today's wellness", detail: est.reasons[0] ?? "Some of today's values are missing, so there is no readiness estimate yet.", badge: null, cta: { label: "Log wellness", action: "log-wellness" } };
  if (a.sup && a.sup.pending > 0) return { kind: "log-supplements", title: "Log your supplements", detail: `${a.sup.pending} dose${a.sup.pending === 1 ? "" : "s"} still to log today.`, badge: null, cta: { label: "Log supplements", action: "log-supplements" } };
  return { kind: "ask-coach", title: "Plan with the Coach", detail: "Your wellness is in. Ask the Coach about today's training or recovery.", badge: null, cta: { label: "Ask the Coach", href: "/coach?tab=daily" } };
}

/** How strongly the Next step card is drawn. Strong only when attention or a meaningful action is needed (a workout in progress, wellness to log,
 *  data that could not be loaded); a routine day gets a calm, neutral card. Presentation only: which step is chosen is decided by nextAction. */
export function emphasis(kind: NextAction["kind"]): "strong" | "neutral" {
  return kind === "resume-workout" || kind === "log-wellness" || kind === "data-unavailable" ? "strong" : "neutral";
}
