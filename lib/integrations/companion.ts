// Contract for a FUTURE native APEX companion app (iOS HealthKit / Android Health Connect). No endpoint accepts this yet: a web app
// cannot read Apple Health or Health Connect, so nothing here pretends otherwise. When a native app exists, its upload endpoint
// validates payloads with `parseCompanionUpload` and stores them through the same observation pipeline (transport "companion_app").
//
// Type mapping (official identifiers):
//   HealthKit:      HKQuantityTypeIdentifierHeartRateVariabilitySDNN -> hrv_sdnn_ms (SDNN, NOT rMSSD), restingHeartRate -> resting_hr_bpm,
//                   vo2Max -> vo2max, HKCategoryTypeIdentifierSleepAnalysis -> sleep_minutes (asleep stages only), HKWorkout -> activity
//   Health Connect: HeartRateVariabilityRmssdRecord -> hrv_rmssd_ms, RestingHeartRateRecord -> resting_hr_bpm, Vo2MaxRecord -> vo2max,
//                   SleepSessionRecord -> sleep_minutes, ExerciseSessionRecord -> activity, StepsRecord -> steps, WeightRecord -> weight_kg
// The originating app/device (e.g. a Samsung watch writing into Health Connect) is reported per sample in `origin` when the platform
// exposes it (Health Connect metadata.dataOrigin, HealthKit sourceRevision); otherwise it stays "unknown".
import { makeObservation, type MetricName, type Observation } from "./normalize.ts";
import type { Origin } from "./providers.ts";

export type CompanionPlatform = "healthkit" | "health_connect";
export const COMPANION_METRICS: Record<CompanionPlatform, Partial<Record<string, MetricName>>> = {
  healthkit: {
    HKQuantityTypeIdentifierHeartRateVariabilitySDNN: "hrv_sdnn_ms", HKQuantityTypeIdentifierRestingHeartRate: "resting_hr_bpm",
    HKQuantityTypeIdentifierVO2Max: "vo2max", HKQuantityTypeIdentifierStepCount: "steps", HKQuantityTypeIdentifierBodyMass: "weight_kg",
    HKCategoryTypeIdentifierSleepAnalysis: "sleep_minutes",
  },
  health_connect: {
    HeartRateVariabilityRmssdRecord: "hrv_rmssd_ms", RestingHeartRateRecord: "resting_hr_bpm", Vo2MaxRecord: "vo2max",
    StepsRecord: "steps", WeightRecord: "weight_kg", SleepSessionRecord: "sleep_minutes",
  },
};

// Only identifiers known with confidence; anything else stays "unknown". The health STORE is not the origin: a Garmin sample synced
// into HealthKit is a Garmin measurement. Apple Watch samples carry a bundle id starting with "com.apple.health".
const ORIGINS: Array<[string, Origin]> = [
  ["com.apple.health", "apple_health"], ["com.sec.android.app.shealth", "samsung_health"], ["com.garmin.android.apps.connectmobile", "garmin"], ["fi.polar.polarflow", "polar"],
];
const originOf = (app: unknown): Origin => (typeof app === "string" ? ORIGINS.find(([p]) => app === p || app.startsWith(p + "."))?.[1] ?? "unknown" : "unknown");

export interface CompanionSample { type: string; id: string; value: number; start: string; end?: string | null; localDay: string; originApp?: string | null }
export interface CompanionUpload { version: 1; platform: CompanionPlatform; samples: CompanionSample[] }
export type CompanionParse = { ok: true; observations: Observation[]; rejected: number } | { ok: false; error: string };

/** Strict validation of a companion upload. Unknown types and invalid values are rejected (counted), never coerced. */
export function parseCompanionUpload(body: unknown): CompanionParse {
  const b = (body && typeof body === "object" ? body : {}) as Partial<CompanionUpload>;
  if (b.version !== 1) return { ok: false, error: "Unsupported upload version." };
  if (b.platform !== "healthkit" && b.platform !== "health_connect") return { ok: false, error: "Unknown platform." };
  if (!Array.isArray(b.samples) || b.samples.length > 5000) return { ok: false, error: "Samples must be a list of at most 5000 items." };
  const map = COMPANION_METRICS[b.platform];
  const out: Observation[] = [];
  let rejected = 0;
  for (const s of b.samples as CompanionSample[]) {
    const metric = s && typeof s.type === "string" ? map[s.type] : undefined;
    const origin = originOf(s?.originApp);
    const o = metric ? makeObservation({ provider: origin, transport: "companion_app", source_record_id: `${b.platform}:${s.id}`, metric, value: s.value, measured_at: s.end ?? s.start, local_day: s.localDay }) : null;
    if (o) out.push(o); else rejected++;
  }
  return { ok: true, observations: out, rejected };
}
