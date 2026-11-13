// What is missing or unfinished on Today, as ONE short list (together with the unrecorded metrics that KeyMetrics groups: lens.ts groupEmpty). Pure: it only reads facts the page already has. Nothing here is a measurement,
// and a missing item never implies that something was measured. Actions are offered only where they are relevant to this person's own data,
// profile and connections: an optional module that is simply empty is a quiet link, never a promotion.

export type LoadState = "loading" | "unavailable" | "ok";
export interface SetupInput {
  wellness: LoadState; wellnessMissing: boolean; hasSleepReading: boolean; sleepGoalH: number | null;
  activities: LoadState; hasActivity: boolean; hasStrength: boolean; strength: LoadState; intervalsConnected: boolean;
  race: LoadState; hasRace: boolean; biomarkers: LoadState; hasBiomarkers: boolean; supplements: LoadState; hasSupplements: boolean;
}
export interface SetupItem { id: string; text: string; href: string; actionLabel?: string }
export interface SetupModel { needed: SetupItem[]; optional: SetupItem[] }

export function setupModel(i: SetupInput): SetupModel {
  const needed: SetupItem[] = [], optional: SetupItem[] = [];
  // Profile: a sleep goal decides whether sleep can count toward readiness. Relevant only when wellness data exists to use it.
  if (i.wellness === "ok" && !i.wellnessMissing && i.sleepGoalH === null && i.hasSleepReading) {
    needed.push({ id: "sleep-goal", text: "No sleep goal is set, so sleep is left out of the readiness estimate.", href: "/profile", actionLabel: "Set a sleep goal" });
  }
  // Activities: only suggest connecting a source when none is connected. A connected source with no recent sessions has nothing to set up.
  if (i.activities === "ok" && i.strength === "ok" && !i.hasActivity && !i.hasStrength && !i.intervalsConnected) {
    needed.push({ id: "activities", text: "No activities yet.", href: "/integrations", actionLabel: "Connect a data source" });
  }
  // Optional modules: listed quietly, only when their data loaded fine and is empty. They are not cards and not promotions.
  if (i.race === "ok" && !i.hasRace) optional.push({ id: "race", text: "Add a race", href: "/races" });
  if (i.biomarkers === "ok" && !i.hasBiomarkers) optional.push({ id: "biomarkers", text: "Add a blood test", href: "/biomarkers" });
  if (i.supplements === "ok" && !i.hasSupplements) optional.push({ id: "supplements", text: "Add supplements", href: "/supplements" });
  if (i.strength === "ok" && !i.hasStrength) optional.push({ id: "strength", text: "Start a strength workout", href: "/strength" });
  return { needed, optional };
}
