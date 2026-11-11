// APEX engine: pure functions (no React, no Supabase). A faithful port of engine.py.
// Dates are ISO strings "YYYY-MM-DD" so there are no time-zone surprises.

export type Verdict = "PUSH" | "HOLD" | "RECOVER";
export interface Readiness {
  score: number;            // 0-100
  verdict: Verdict;
  hrvZ: number | null;
  baselineDays: number;     // how many prior HRV days the baseline uses
}

const clip = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const clean = (xs: ReadonlyArray<number | null | undefined>): number[] =>
  xs.filter((v): v is number => v !== null && v !== undefined).map(Number);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const pstdev = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};
// Python's round() rounds halves to the nearest EVEN number; match it so both apps agree.
const pyRound = (x: number) => {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

/** Mean and SD of prior HRV days. Needs at least 3 days; SD has a 5% floor. */
export function hrvBaseline(prior: ReadonlyArray<number | null | undefined>): [number, number] | null {
  const v = clean(prior);
  if (v.length < 3) return null;
  const m = mean(v);
  return [m, Math.max(pstdev(v), 0.05 * m)];
}

/** Weighted 0-100 readiness from HRV (45%), resting HR (25%) and sleep (30%).
 *  Missing inputs are skipped and the remaining weights are renormalised. */
export function readiness(args: {
  hrv: number | null; rhr: number | null; sleepH: number | null;
  hrvPrior?: ReadonlyArray<number | null | undefined>;
  rhrPrior?: ReadonlyArray<number | null | undefined>;
  sleepGoalH?: number;
}): Readiness | null {
  const { hrv, rhr, sleepH, hrvPrior = [], rhrPrior = [], sleepGoalH = 8 } = args;
  const parts: Array<[number, number]> = [];
  let z: number | null = null;

  if (hrv !== null) {
    const base = hrvBaseline(hrvPrior);
    if (base) {
      z = (hrv - base[0]) / base[1];
      parts.push([0.45, ((clip(z, -2, 2) + 2) / 4) * 100]);
    } else parts.push([0.45, 50]);
  }
  if (rhr !== null) {
    const prior = clean(rhrPrior);
    if (prior.length >= 3) {
      const delta = mean(prior) - rhr; // lower RHR than usual is good
      parts.push([0.25, ((clip(delta, -8, 8) + 8) / 16) * 100]);
    } else parts.push([0.25, 50]);
  }
  if (sleepH !== null && sleepGoalH > 0) {
    parts.push([0.3, clip(sleepH / sleepGoalH, 0, 1) * 100]);
  }
  if (parts.length === 0) return null;

  const totalW = parts.reduce((a, [w]) => a + w, 0);
  const score = pyRound(parts.reduce((a, [w, s]) => a + w * s, 0) / totalW);
  const verdict: Verdict = score >= 70 ? "PUSH" : score >= 45 ? "HOLD" : "RECOVER";
  return { score, verdict, hrvZ: z, baselineDays: clean(hrvPrior).length };
}

export const TAPER_DAYS: Record<string, number> = {
  "10k": 5, half_marathon: 10, marathon: 18, trail: 14, triathlon_sprint: 5,
  triathlon_olympic: 8, half_ironman: 12, ironman: 18, cycling: 8, other: 10,
};

export function racePhase(daysToRace: number, raceType: string): string {
  if (daysToRace < 0) return "Completed";
  if (daysToRace === 0) return "Race day";
  const taper = TAPER_DAYS[raceType] ?? 10;
  if (daysToRace <= taper) return "Taper";
  if (daysToRace <= taper + 14) return "Peak load";
  if (daysToRace <= 84) return "Build";
  return "Base";
}

/** Banister impulse-response model: one [CTL, ATL, TSB] per day. */
export function banister(loads: number[], ctl0 = 0, atl0 = 0, ctlTau = 42, atlTau = 7): Array<[number, number, number]> {
  let ctl = ctl0, atl = atl0;
  return loads.map((load) => {
    ctl += (load - ctl) / ctlTau;
    atl += (load - atl) / atlTau;
    return [ctl, atl, ctl - atl];
  });
}

/** Session-RPE load, scaled so that 1 hour at RPE 6 is about 60. */
export const estimateLoad = (durationMin: number, rpe: number) => Math.round((durationMin * rpe / 6) * 10) / 10;

export function tsbState(tsb: number): string {
  if (tsb > 25) return "Detraining risk";
  if (tsb >= 5) return "Peak form window";
  if (tsb >= -10) return "Productive training";
  if (tsb >= -30) return "Elevated fatigue";
  return "Overtraining risk";
}

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export const daysBetween = (a: string, b: string) => {
  const t = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(b) - t(a)) / 86_400_000);
};

/** (day, load, CTL, ATL, TSB) for every day from start to end; rest days count as 0. */
export function loadSeries(daily: Record<string, number>, start: string, end: string) {
  const days: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  const vals = banister(days.map((d) => daily[d] ?? 0));
  return days.map((d, i) => ({ day: d, load: daily[d] ?? 0, ctl: vals[i][0], atl: vals[i][1], tsb: vals[i][2] }));
}

/** Form (TSB) on race morning if you train at avgLoad until then; the last taperDays run at avgLoad * taperFactor. */
export function projectTsb(ctl: number, atl: number, daysToRace: number, avgLoad: number,
                           taperDays = 0, taperFactor = 0.5, ctlTau = 42, atlTau = 7): number {
  const n = Math.max(daysToRace - 1, 0);
  for (let i = 0; i < n; i++) {
    const load = n - i <= taperDays ? avgLoad * taperFactor : avgLoad;
    ctl += (load - ctl) / ctlTau;
    atl += (load - atl) / atlTau;
  }
  return ctl - atl;
}
