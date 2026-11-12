// Educational empty states (UI/UX Phase 3A). Pure: no React, no storage, no network.
//
// THE RULE: an empty state may only be shown when the data was loaded successfully and there is genuinely nothing. A failed request,
// a missing set-up (migration not applied) or a request still in flight is a different situation with a different message, and must
// never be dressed up as "you have no data yet". `loadView` is the single place that decides it.
//
// Nothing here carries a number, a chart or a sample value: the copy explains a feature and what activates it, and never shows or
// implies a measurement.

export type LoadView = "loading" | "error" | "setup" | "empty" | "ready";

/** What a list/module should render. Order matters: a failure or a missing set-up always wins over "empty", and "loading" over everything
 *  that needs data. `count` is only looked at once loading has finished and nothing went wrong. */
export function loadView(a: { loaded: boolean; error?: string | null; notSetUp?: boolean; count: number }): LoadView {
  if (a.error) return "error";
  if (a.notSetUp) return "setup";
  if (!a.loaded) return "loading";
  return a.count > 0 ? "ready" : "empty";
}

export type EmptyIcon = "activity" | "dumbbell" | "routine" | "drop" | "flag" | "pill" | "calendar" | "heart";

export interface EmptyCta {
  label: string;
  /** An existing page. Exactly one of href / action is set. */
  href?: string;
  /** An existing form or action on the same page, wired by the page itself. */
  action?: string;
}
export interface EmptyCopy {
  icon: EmptyIcon;
  /** Short, plain statement of the situation. */
  title: string;
  /** What the feature is for, in simple language. */
  why: string;
  /** What data or action turns it on. */
  need: string;
  cta: EmptyCta;
  secondary?: { label: string; href: string };
}

export type EmptyKey =
  | "activities" | "strength-history" | "routines" | "biomarkers" | "races" | "supplements" | "training"
  | "today-wellness" | "today-endurance" | "today-strength" | "today-biomarkers" | "today-supplements" | "today-race";

export const EMPTY: Record<EmptyKey, EmptyCopy> = {
  activities: {
    icon: "activity", title: "No activities yet",
    why: "Activities lists every run, ride, swim and gym session by week, with distance, time and training load, and it feeds your fitness and fatigue trends.",
    need: "It fills in by itself once a device or platform is connected and synced. Intervals.icu can bring in activities recorded on Garmin and other devices.",
    cta: { label: "Connect a device", href: "/integrations" },
  },
  "strength-history": {
    icon: "dumbbell", title: "No finished workouts yet",
    why: "Strength Hub logs your sets, reps and weights, then shows personal records and progress for each exercise.",
    need: "Finish a workout and it appears here. Already train with Hevy? Import your history instead.",
    cta: { label: "Start your first workout", action: "start-workout" }, secondary: { label: "Import Hevy history", href: "/strength/import" },
  },
  routines: {
    icon: "routine", title: "No routines yet",
    why: "A routine is a reusable workout: the exercises, sets and rest you repeat each week.",
    need: "Build one from scratch or start from a template, then start it in one tap from Strength.",
    cta: { label: "Create a routine", action: "new-routine" },
  },
  biomarkers: {
    icon: "drop", title: "No blood tests yet",
    why: "Biomarkers follows each marker across your tests, using the laboratory's own units and reference ranges. It shows timing and trends, never a diagnosis.",
    need: "Add a test by typing in the results or by uploading a lab report as a PDF or photo.",
    cta: { label: "Add your first blood test", href: "/biomarkers/panels/new" },
  },
  races: {
    icon: "flag", title: "No races yet",
    why: "A race gives you a countdown, shows on Today, and lets the Coach plan around your goal.",
    need: "Add a race with its date and priority: A for your main goal, B for important, C for a training race.",
    cta: { label: "Add your first race", action: "new-race" },
  },
  supplements: {
    icon: "pill", title: "No supplements yet",
    why: "A personal log of what you take and when, so you can see how consistent you are and line changes up with your blood tests.",
    need: "Add a supplement with its dose and schedule, then mark each dose taken or skipped. APEX never recommends supplements or doses.",
    cta: { label: "Add a supplement", action: "new-supplement" },
  },
  training: {
    icon: "calendar", title: "Nothing planned in this period",
    why: "The calendar sets what you plan beside what you actually did, so you can see how a week compares with your intention.",
    need: "Add a session: a run, ride, swim or strength workout, a rest day or a milestone. Nothing is ever planned for you.",
    cta: { label: "Add a session", action: "new-plan" },
  },
  "today-wellness": {
    icon: "heart", title: "No wellness data yet",
    why: "Your readiness estimate compares overnight HRV, resting heart rate and sleep with your own usual.",
    need: "Log a day by hand, or connect a device. It needs a few days of your own data before a baseline exists.",
    cta: { label: "Log wellness", action: "log-wellness" }, secondary: { label: "Connect a device", href: "/integrations" },
  },
  "today-endurance": {
    icon: "activity", title: "No recent activities",
    why: "Shows your latest session and the fitness, fatigue and form model built from your training load.",
    need: "Connect Intervals.icu or another device and sync your activities.",
    cta: { label: "Connect a device", href: "/integrations" },
  },
  "today-strength": {
    icon: "dumbbell", title: "No recent gym sessions",
    why: "Shows your latest gym session and your weekly working sets.",
    need: "Start a workout in Strength Hub, or import your Hevy history.",
    cta: { label: "Start a workout", href: "/strength" }, secondary: { label: "Import Hevy history", href: "/strength/import" },
  },
  "today-biomarkers": {
    icon: "drop", title: "No blood tests yet",
    why: "Follows each marker over time, with the laboratory's own ranges.",
    need: "Add a lab report, or type results in by hand.",
    cta: { label: "Add a blood test", href: "/biomarkers/panels/new" },
  },
  "today-supplements": {
    icon: "pill", title: "No supplements yet",
    why: "Lets you mark each dose taken or skipped right from Today.",
    need: "Add a supplement with a schedule first.",
    cta: { label: "Add a supplement", href: "/supplements" },
  },
  "today-race": {
    icon: "flag", title: "No upcoming race",
    why: "Gives you a countdown and race-aware coaching.",
    need: "Add a race with its date.",
    cta: { label: "Add a race", href: "/races" },
  },
};
