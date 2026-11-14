// Prompts and Gemini helpers for the training summaries. Pure functions, no imports.

export const SUMMARY_SYSTEM = `You are APEX, a sports-science assistant writing a short training summary for ONE endurance athlete about their own data.

Rules:
- Use ONLY the data given below. If something is missing, leave it out; never invent numbers, races or sessions.
- Plain text, 4 to 6 short sentences, no headings and no bullet lists.
- First say what happened, then how it compares with the athlete's recent training, then at most one practical takeaway for the next few days.
- If the athlete wrote a note about a session, take it into account and mention it naturally.
- Training load is an estimate and HRV is noisy: say so briefly when a conclusion depends on them.
- You are not a doctor. Do not diagnose or recommend medication. For pain, injury or unusual symptoms, suggest seeing a qualified professional.
- Write in English.`;

export interface Brief {
  day: string; sport: string; title: string | null; minutes: number; km: number | null;
  pace: string | null; avgHr: number | null; load: number | null; note: string | null;
}
export interface LoadState { ctl: number; atl: number; tsb: number; state: string }
export interface Morning { hrv: number | null; rhr: number | null; sleepH: number | null; sleepScore: number | null }
export interface RaceInfo { name: string; days: number }

const n0 = (x: number | null | undefined, unit = "") => (x === null || x === undefined ? "n/a" : `${Math.round(x)}${unit}`);
const loadLine = (l: LoadState | null) =>
  l ? `Training load model: CTL (fitness) ${l.ctl.toFixed(0)}, ATL (fatigue) ${l.atl.toFixed(0)}, TSB (form) ${l.tsb >= 0 ? "+" : ""}${l.tsb.toFixed(0)} (${l.state})` : "Training load model: not available";
const raceLine = (r: RaceInfo | null) =>
  !r ? "Next race: none registered" : `Next race: ${r.name} ${r.days === 0 ? "today" : r.days === 1 ? "in 1 day" : `in ${r.days} days`}`;

const dayNumber = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d) / 86_400_000; };

/** The first race on or after `today` (both "YYYY-MM-DD"), counted from today. Races that are already over are
 *  never "next", whatever day the summarised session or week was on. */
export function nextRace(races: ReadonlyArray<{ name?: unknown; race_date?: unknown }>, today: string): RaceInfo | null {
  let best: { name: string; date: string } | null = null;
  for (const r of races) {
    const date = typeof r.race_date === "string" ? r.race_date.slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today) continue;
    if (!best || date < best.date) best = { name: String(r.name ?? "Race"), date };
  }
  return best ? { name: best.name, days: Math.round(dayNumber(best.date) - dayNumber(today)) } : null;
}
const briefLine = (b: Brief) =>
  `${b.day} ${b.sport}${b.title ? ` "${b.title}"` : ""}: ${b.minutes} min` +
  `${b.km !== null ? `, ${b.km.toFixed(1)} km` : ""}${b.pace ? `, ${b.pace}` : ""}` +
  `${b.avgHr !== null ? `, avg HR ${Math.round(b.avgHr)}` : ""}, load ${n0(b.load)}` +
  `${b.note ? `. Athlete's note: "${b.note}"` : ""}`;

export interface ActivityContext {
  today: string;
  activity: Brief;
  sameSportRecent: Brief[];                 // up to 6 earlier sessions of the same sport
  typical: { sessions: number; avgMinutes: number | null; avgLoad: number | null }; // same sport, last 6 weeks
  load: LoadState | null;
  morning: Morning | null;
  sevenDay: { hrv: number | null; rhr: number | null; sleepH: number | null } | null;
  race: RaceInfo | null;
}

export function buildActivityPrompt(c: ActivityContext): string {
  const L = [`Today: ${c.today}`, "", "SESSION TO SUMMARISE:", briefLine(c.activity), ""];
  L.push(`Same-sport sessions in the last 6 weeks: ${c.typical.sessions}` +
    (c.typical.sessions ? `, average ${n0(c.typical.avgMinutes)} min and load ${n0(c.typical.avgLoad)}` : ""));
  if (c.sameSportRecent.length) { L.push("Recent sessions of this sport:"); c.sameSportRecent.forEach((b) => L.push("- " + briefLine(b))); }
  L.push("", loadLine(c.load));
  if (c.morning) L.push(`That morning: HRV ${n0(c.morning.hrv, " ms")}, resting HR ${n0(c.morning.rhr)}, sleep ${c.morning.sleepH === null ? "n/a" : c.morning.sleepH.toFixed(1) + " h"}, sleep score ${n0(c.morning.sleepScore)}`);
  if (c.sevenDay) L.push(`Previous 7-day averages: HRV ${n0(c.sevenDay.hrv, " ms")}, resting HR ${n0(c.sevenDay.rhr)}, sleep ${c.sevenDay.sleepH === null ? "n/a" : c.sevenDay.sleepH.toFixed(1) + " h"}`);
  L.push(raceLine(c.race), "", "Write the summary now.");
  return L.join("\n");
}

export interface WeekSide { sessions: number; minutes: number; load: number; km: Record<string, number> }
export interface WeekContext {
  today: string; weekStart: string; weekEnd: string;
  thisWeek: WeekSide; previousWeek: WeekSide; fourWeekAvg: { sessions: number; minutes: number; load: number };
  sessions: Brief[];
  load: LoadState | null;
  health: { hrv: number | null; rhr: number | null; sleepH: number | null; prevHrv: number | null; prevRhr: number | null; prevSleepH: number | null } | null;
  race: RaceInfo | null;
}

const kmText = (k: Record<string, number>) => {
  const parts = Object.entries(k).map(([s, v]) => `${s} ${v.toFixed(1)} km`);
  return parts.length ? parts.join(", ") : "no distance sessions";
};

export function buildWeekPrompt(c: WeekContext): string {
  const L = [`Today: ${c.today}`, `Week to summarise: ${c.weekStart} to ${c.weekEnd} (Monday to Sunday)`, ""];
  L.push(`This week: ${c.thisWeek.sessions} sessions, ${c.thisWeek.minutes} min, total load ${c.thisWeek.load}; ${kmText(c.thisWeek.km)}`);
  L.push(`Previous week: ${c.previousWeek.sessions} sessions, ${c.previousWeek.minutes} min, total load ${c.previousWeek.load}; ${kmText(c.previousWeek.km)}`);
  L.push(`Average of the 4 weeks before this one: ${c.fourWeekAvg.sessions.toFixed(1)} sessions, ${Math.round(c.fourWeekAvg.minutes)} min, load ${Math.round(c.fourWeekAvg.load)}`);
  L.push("", "Sessions this week:");
  if (c.sessions.length) c.sessions.forEach((b) => L.push("- " + briefLine(b))); else L.push("- none recorded");
  L.push("", loadLine(c.load));
  if (c.health) {
    const h = c.health;
    L.push(`Recovery this week (average): HRV ${n0(h.hrv, " ms")}, resting HR ${n0(h.rhr)}, sleep ${h.sleepH === null ? "n/a" : h.sleepH.toFixed(1) + " h"}; ` +
      `previous week: HRV ${n0(h.prevHrv, " ms")}, resting HR ${n0(h.prevRhr)}, sleep ${h.prevSleepH === null ? "n/a" : h.prevSleepH.toFixed(1) + " h"}`);
  }
  L.push(raceLine(c.race), "", "Write the weekly summary now.");
  return L.join("\n");
}

// ----------------------------------------------------------- Gemini helpers
const NOT_CHAT = ["image", "tts", "live", "audio", "embedding", "imagen", "veo", "robotics", "computer", "learnlm", "gemma", "nano", "banana", "aqa", "native"];

/** Best text models first: flash before lite before pro, stable before preview, newest first. */
export function rankModels(models: Array<{ name?: string; supportedGenerationMethods?: string[] }>): string[] {
  const found = new Set<string>();
  for (const m of models) {
    const name = (m.name ?? "").replace("models/", "");
    const methods = m.supportedGenerationMethods ?? [];
    if (!name.startsWith("gemini-") || NOT_CHAT.some((b) => name.includes(b))) continue;
    if (methods.length && !methods.includes("generateContent")) continue;
    if (!/^[a-z0-9.\-]+$/.test(name)) continue;
    found.add(name);
  }
  const score = (n: string): [number, number, number] => {
    const v = /gemini-(\d+(?:\.\d+)?)/.exec(n);
    const tier = n.includes("flash") && !n.includes("lite") ? 2 : n.includes("lite") ? 1 : 0;
    const stable = /preview|exp/.test(n) ? 0 : 1;
    return [tier, stable, v ? parseFloat(v[1]) : 0];
  };
  return [...found].sort((a, b) => {
    const A = score(a), B = score(b);
    return B[0] - A[0] || B[1] - A[1] || B[2] - A[2] || a.localeCompare(b);
  });
}

/** Text of a Gemini generateContent response, or null. */
export function extractText(resp: unknown): string | null {
  const r = resp as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> } | null;
  const parts = r?.candidates?.[0]?.content?.parts;
  if (!parts) return null;
  const text = parts.map((p) => p.text ?? "").join("").trim();
  return text || null;
}
