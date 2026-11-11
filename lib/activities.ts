// Activity helpers: formatting, weeks and totals. Pure functions, no imports.

export interface Activity {
  id: number;
  started_at: string;
  sport: string;
  title: string | null;
  duration_s: number | null;
  distance_m: number | null;
  avg_hr: number | null;
  load: number | null;
  note: string | null;
  ai_summary: string | null;
  ai_summary_at: string | null;
}

export const SPORT_LABEL: Record<string, string> = {
  run: "Run", bike: "Bike", swim: "Swim", strength: "Strength", other: "Other",
};

export function formatDuration(s: number | null): string {
  if (!s || s <= 0) return "—";
  const total = Math.round(s / 60);          // round once, so 59m59s becomes 1h 00m, never "60m"
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h === 0 ? `${m}m` : `${h}h ${String(m).padStart(2, "0")}m`;
}

export function formatDistance(m: number | null): string {
  if (!m || m <= 0) return "—";
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

const mmss = (sec: number) => {
  let m = Math.floor(sec / 60);
  let s = Math.round(sec % 60);
  if (s === 60) { m += 1; s = 0; }
  return `${m}:${String(s).padStart(2, "0")}`;
};

/** Run: min/km. Bike: km/h. Swim: min per 100 m. Anything else: null. */
export function paceLabel(sport: string, durationS: number | null, distanceM: number | null): string | null {
  if (!durationS || !distanceM || durationS <= 0 || distanceM <= 0) return null;
  if (sport === "run") return `${mmss(durationS / (distanceM / 1000))}/km`;
  if (sport === "bike") return `${((distanceM / 1000) / (durationS / 3600)).toFixed(1)} km/h`;
  if (sport === "swim") return `${mmss(durationS / (distanceM / 100))}/100m`;
  return null;
}

/** The calendar day (YYYY-MM-DD) of a timestamp in the given time zone (default: this device's). */
export function localDay(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  try {
    return d.toLocaleDateString("sv-SE", timeZone ? { timeZone } : undefined);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function addDaysIso(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The Monday of the week that contains `day`. */
export function weekStart(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDaysIso(day, -((dow + 6) % 7));
}

/** Filter by sport ("all" keeps everything) and a free-text search over title, note and sport name. */
export function filterActivities(acts: Activity[], sport: string, query: string): Activity[] {
  const q = query.trim().toLowerCase();
  return acts.filter((a) => {
    if (sport !== "all" && a.sport !== sport) return false;
    if (!q) return true;
    const hay = `${a.title ?? ""} ${a.note ?? ""} ${SPORT_LABEL[a.sport] ?? a.sport}`.toLowerCase();
    return hay.includes(q);
  });
}

export interface ActivitySummary {
  sessions: number;
  distanceM: number;
  durationS: number;
  load: number;
  /** Average pace/speed for a single distance sport; null when sports are mixed or data is missing. */
  pace: string | null;
}

export function summarizeActivities(acts: Activity[], sport: string): ActivitySummary {
  let distanceM = 0, durationS = 0, load = 0, paceDist = 0, paceDur = 0;
  for (const a of acts) {
    durationS += a.duration_s ?? 0;
    load += a.load ?? 0;
    if (a.distance_m && ["run", "bike", "swim"].includes(a.sport)) distanceM += a.distance_m;
    if (a.distance_m && a.duration_s) { paceDist += a.distance_m; paceDur += a.duration_s; }
  }
  return {
    sessions: acts.length, distanceM, durationS, load: Math.round(load),
    pace: ["run", "bike", "swim"].includes(sport) ? paceLabel(sport, paceDur, paceDist) : null,
  };
}

export interface WeekTotals {
  sessions: number;
  minutes: number;
  load: number;
  km: Record<string, number>; // run / bike / swim distance in km
}

export function weekTotals(acts: Activity[], start: string, timeZone?: string): WeekTotals {
  const end = addDaysIso(start, 6);
  const t: WeekTotals = { sessions: 0, minutes: 0, load: 0, km: {} };
  for (const a of acts) {
    const day = localDay(a.started_at, timeZone);
    if (day < start || day > end) continue;
    t.sessions += 1;
    t.minutes += (a.duration_s ?? 0) / 60;
    t.load += a.load ?? 0;
    if (a.distance_m && ["run", "bike", "swim"].includes(a.sport)) {
      t.km[a.sport] = (t.km[a.sport] ?? 0) + a.distance_m / 1000;
    }
  }
  t.minutes = Math.round(t.minutes);
  t.load = Math.round(t.load);
  return t;
}
