// Calendar-day helpers. Days are ISO strings "YYYY-MM-DD" and all arithmetic is done in UTC, so there are no
// time-zone or daylight-saving surprises. No imports (shared by the pure modules and their tests).

/** Today's date as YYYY-MM-DD in the user's own time zone. */
export const todayIso = () => new Date().toLocaleDateString("sv-SE");

/** `day` plus `n` calendar days (n may be negative). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (negative when b is earlier). */
export function daysBetween(a: string, b: string): number {
  const t = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(b) - t(a)) / 86_400_000);
}
