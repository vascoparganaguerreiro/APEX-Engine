// Provider catalogue for APEX Universal Connect. Pure data + pure status rules (no I/O), shared by the UI, the server and tests.
// Every capability below was checked against official documentation on 2026-11-12 (see docs/universal-connect.md). A category is
// listed only when APEX can actually receive it through the stated route; "unconfirmed" items are never shown as available.

export type ProviderId =
  | "intervals" | "garmin" | "coros" | "whoop" | "amazfit" | "polar" | "suunto" | "oura" | "apple_health" | "samsung_health" | "strava";

/** How data reaches APEX. Kept separate from the provider: Intervals is often only the transport. */
export type Transport = "direct" | "intervals" | "manual" | "companion_app" | "file";

/** Where a measurement was originally made. "unknown" when the transport does not say (e.g. Intervals wellness). */
export type Origin = ProviderId | "wahoo" | "zwift" | "huawei" | "concept2" | "unknown";

export type Category = "activities" | "hrv" | "resting_hr" | "sleep" | "vo2max" | "recovery_score" | "training_load" | "body";
export const CATEGORY_LABEL: Record<Category, string> = {
  activities: "Activities", hrv: "HRV", resting_hr: "Resting heart rate", sleep: "Sleep", vo2max: "VO2 max",
  recovery_score: "Vendor recovery score", training_load: "Training load", body: "Body measurements",
};

/** What APEX can do today for a provider, independent of the user's own connection. */
export type Route =
  | { kind: "direct"; env: readonly string[] }            // APEX connects itself; needs server credentials from these variables
  | { kind: "intervals" }                                 // only through the user's Intervals.icu account
  | { kind: "approval"; note: string }                    // the provider must approve APEX first
  | { kind: "native"; note: string }                      // needs a native mobile companion app
  | { kind: "unsupported"; note: string };

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  /** Routes in order of preference. */
  routes: readonly Route[];
  /** Categories APEX can receive through Intervals.icu (activities carry the brand; wellness does not). */
  viaIntervals: readonly Category[];
  /** Categories APEX receives through its own direct connection. */
  direct: readonly Category[];
  /** Intervals.icu `source` values that identify this provider's activities. */
  intervalsSources: readonly string[];
  permissions: string;
  limits: string;
}

const NEEDS_APP_NOTE = "A web app cannot read this data. It needs a native APEX companion app (not built yet).";

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "intervals", name: "Intervals.icu", routes: [{ kind: "direct", env: [] }], intervalsSources: [],
    viaIntervals: [], direct: ["activities", "hrv", "resting_hr", "sleep", "vo2max", "recovery_score", "training_load", "body"],
    permissions: "API key (read) stored encrypted on the server. OAuth sign-in becomes available once APEX's Intervals.icu app is approved.",
    limits: "Activities recorded on Strava are not available through the Intervals.icu API. Wellness values do not say which device measured them.",
  },
  {
    id: "garmin", name: "Garmin", routes: [{ kind: "intervals" }, { kind: "approval", note: "Direct Garmin Connect access needs Garmin's developer programme (business approval). The personal API's documentation is only visible to approved accounts." }],
    intervalsSources: ["GARMIN_CONNECT"], viaIntervals: ["activities", "training_load"], direct: [],
    permissions: "Granted in Intervals.icu (Settings > Connections > Garmin).",
    limits: "Wellness from Garmin reaches APEX through Intervals.icu, but Intervals.icu does not label it as Garmin, so APEX shows it as 'origin not reported'.",
  },
  {
    id: "coros", name: "COROS", routes: [{ kind: "intervals" }, { kind: "approval", note: "COROS API access is by application to COROS." }],
    intervalsSources: ["COROS"], viaIntervals: ["activities", "training_load"], direct: [],
    permissions: "Granted in Intervals.icu.", limits: "COROS training scores are not available to APEX.",
  },
  {
    id: "whoop", name: "WHOOP", routes: [{ kind: "direct", env: ["WHOOP_CLIENT_ID", "WHOOP_CLIENT_SECRET", "WHOOP_REDIRECT_URI"] }],
    intervalsSources: [], viaIntervals: [], direct: ["activities", "hrv", "resting_hr", "sleep", "recovery_score", "body"],
    permissions: "Read-only: recovery, cycles, sleep, workouts, body measurements, plus offline access to stay connected. You can revoke it here or in the WHOOP app.",
    limits: "WHOOP strain and recovery are WHOOP-specific scores; APEX never mixes them with other vendors' scores. Until WHOOP approves APEX's app, at most 10 members can connect.",
  },
  {
    id: "amazfit", name: "Amazfit / Zepp", routes: [{ kind: "intervals" }],
    intervalsSources: ["ZEPP"], viaIntervals: ["activities", "training_load"], direct: [],
    permissions: "Granted in Intervals.icu.", limits: "No official health-data API was found; only activities arrive through Intervals.icu.",
  },
  {
    id: "polar", name: "Polar", routes: [{ kind: "intervals" }],
    intervalsSources: ["POLAR"], viaIntervals: ["activities", "training_load"], direct: [],
    permissions: "Granted in Intervals.icu.",
    limits: "A direct Polar AccessLink connection (Nightly Recharge, sleep) is possible later. AccessLink only returns exercises from the last 30 days, and only those after you connect.",
  },
  {
    id: "suunto", name: "Suunto", routes: [{ kind: "intervals" }, { kind: "approval", note: "Suunto's API is only for approved partners." }],
    intervalsSources: ["SUUNTO"], viaIntervals: ["activities", "training_load"], direct: [],
    permissions: "Granted in Intervals.icu.", limits: "Suunto does not offer API access for personal use.",
  },
  {
    id: "oura", name: "Oura", routes: [{ kind: "unsupported", note: "Oura's API (OAuth 2.0) is a candidate for a direct connection. It is not built yet: its specification must be re-checked first." }],
    intervalsSources: [], viaIntervals: [], direct: [],
    permissions: "Not connected.", limits: "Oura readiness is an Oura-specific score and would be stored separately.",
  },
  {
    id: "apple_health", name: "Apple Health", routes: [{ kind: "native", note: NEEDS_APP_NOTE + " Apple Health is only readable on the iPhone through HealthKit." }],
    intervalsSources: [], viaIntervals: [], direct: [],
    permissions: "Would be granted per data type on the iPhone.", limits: "Apple Watch HRV is SDNN, which is not comparable with the rMSSD that most other devices report.",
  },
  {
    id: "samsung_health", name: "Samsung Health", routes: [{ kind: "native", note: NEEDS_APP_NOTE + " Samsung Health data is read on the phone through Health Connect or Samsung's Health Data SDK (which needs a Samsung partnership)." }],
    intervalsSources: [], viaIntervals: [], direct: [],
    permissions: "Would be granted per data type on the phone.", limits: "Health Connect only returns 30 days of history unless the user grants history access.",
  },
  {
    id: "strava", name: "Strava", routes: [{ kind: "unsupported", note: "Not connected directly. Strava's API terms restrict AI use and must be reviewed first. Intervals.icu does not pass Strava activities through its API." }],
    intervalsSources: ["STRAVA"], viaIntervals: [], direct: [],
    permissions: "Not connected.", limits: "Record activities on your watch's own platform (Garmin, COROS…) and link it to Intervals.icu instead.",
  },
];

export const providerInfo = (id: ProviderId): ProviderInfo => PROVIDERS.find((p) => p.id === id)!;

/** Intervals.icu activity `source` (official enum) -> where the activity was recorded. Unknown or generic sources stay "unknown". */
const ORIGIN_BY_SOURCE: Record<string, Origin> = {
  GARMIN_CONNECT: "garmin", COROS: "coros", POLAR: "polar", SUUNTO: "suunto", ZEPP: "amazfit", STRAVA: "strava",
  WAHOO: "wahoo", ZWIFT: "zwift", HUAWEI: "huawei", CONCEPT2: "concept2",
  // UPLOAD, MANUAL, OAUTH_CLIENT, DROPBOX say how the file arrived, not which device recorded it.
};
export function originFromIntervalsSource(source: unknown): Origin {
  return typeof source === "string" ? ORIGIN_BY_SOURCE[source.trim().toUpperCase()] ?? "unknown" : "unknown";
}

// ------------------------------------------------------------------ status shown to the user
export type CardStatus = "connected" | "available" | "via_intervals" | "requires_approval" | "requires_native_app" | "not_supported";
export const STATUS_LABEL: Record<CardStatus, string> = {
  connected: "Connected", available: "Available to connect", via_intervals: "Connected through Intervals.icu",
  requires_approval: "Requires external approval", requires_native_app: "Requires a native companion app", not_supported: "Not yet supported",
};

export interface UserIntegrationState {
  intervalsConnected: boolean;
  /** Providers with a direct connection row in status connected / reauth_required / error. */
  direct: Partial<Record<ProviderId, "connected" | "reauth_required" | "error" | "disconnected">>;
  /** Origins seen in the user's activities (from activities.origin). */
  seenOrigins: ReadonlySet<string>;
  /** Server variables present (names only, never values). */
  configured: ReadonlySet<string>;
}

export interface CardState { status: CardStatus; directLabel: "Direct" | "Through Intervals.icu" | "Needs companion app" | "Not connected"; canConnect: boolean; setupMissing: string[]; seenInData: boolean; note: string | null }

/** Truthful availability for one provider card. A provider is "connected through Intervals" only when Intervals is connected AND the
 *  provider can reach APEX that way; "seenInData" adds that its activities were actually found. */
export function cardState(p: ProviderInfo, s: UserIntegrationState): CardState {
  const direct = p.routes.find((r): r is Extract<Route, { kind: "direct" }> => r.kind === "direct");
  const seen = p.intervalsSources.some((src) => s.seenOrigins.has(src));
  if (p.id === "intervals") {
    return { status: s.intervalsConnected ? "connected" : "available", directLabel: "Direct", canConnect: !s.intervalsConnected, setupMissing: [], seenInData: false, note: null };
  }
  const own = s.direct[p.id];
  if (direct && own && own !== "disconnected") {
    return { status: "connected", directLabel: "Direct", canConnect: own === "reauth_required", setupMissing: [], seenInData: seen,
      note: own === "reauth_required" ? "Access expired or was revoked. Connect again." : own === "error" ? "The last sync failed." : null };
  }
  if (p.routes.some((r) => r.kind === "intervals") && s.intervalsConnected && p.viaIntervals.length > 0) {
    return { status: "via_intervals", directLabel: "Through Intervals.icu", canConnect: false, setupMissing: [], seenInData: seen,
      note: seen ? null : "No activities from this brand found yet. Link it in Intervals.icu if you use it." };
  }
  if (direct) {
    const missing = direct.env.filter((e) => !s.configured.has(e));
    return { status: "available", directLabel: "Direct", canConnect: missing.length === 0, setupMissing: missing, seenInData: seen,
      note: missing.length ? "The server is not set up for this connection yet (app registration pending)." : null };
  }
  if (p.routes.some((r) => r.kind === "intervals")) {
    return { status: "available", directLabel: "Through Intervals.icu", canConnect: false, setupMissing: [], seenInData: seen, note: "Connect Intervals.icu first, then link this brand inside Intervals.icu." };
  }
  const first = p.routes[0];
  if (first.kind === "approval") return { status: "requires_approval", directLabel: "Not connected", canConnect: false, setupMissing: [], seenInData: seen, note: first.note };
  if (first.kind === "native") return { status: "requires_native_app", directLabel: "Needs companion app", canConnect: false, setupMissing: [], seenInData: seen, note: first.note };
  return { status: "not_supported", directLabel: "Not connected", canConnect: false, setupMissing: [], seenInData: seen, note: first.kind === "unsupported" ? first.note : null };
}
