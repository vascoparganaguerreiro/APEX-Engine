// APEX Coach: request/response types, validation and text safety. Pure (no I/O). The only import is the gym assistant's workout
// snapshot validator (also pure).
// Everything the model returns or the browser sends is untrusted until it passes a validator in this file.
import { validateSnapshot, type WorkoutSnapshot } from "../strength/actions.ts";

export const CATEGORIES = ["profile", "activities", "wellness", "load", "races", "biomarkers", "supplements", "strength"] as const;
export type Category = (typeof CATEGORIES)[number];
/** What each category sends to the AI, shown to the user next to its consent switch. Never email, name, date of birth or credentials. */
export const CATEGORY_INFO: Record<Category, { label: string; sends: string }> = {
  profile: { label: "Profile baselines", sends: "Age (not date of birth), units, preferred sports, goal, experience, and the baselines you entered (resting HR, max HR, VO2 max, thresholds, FTP, weight, height) with their source." },
  activities: { label: "Recent activities", sends: "Sport, date, duration, distance, heart rate, power, load and RPE of your last sessions. Your notes are only included for a session you ask the Coach to evaluate." },
  wellness: { label: "Daily wellness", sends: "Your HRV, resting heart rate, sleep duration and sleep score for the last weeks, summarised against your own baseline." },
  load: { label: "Training load", sends: "Weekly load totals and fitness/fatigue/form (CTL, ATL, TSB) when there is enough history for them to be valid." },
  races: { label: "Race plans", sends: "Your upcoming races: name, date, sport, distance, target time, priority and your goal text." },
  biomarkers: { label: "Blood results (relevant only)", sends: "Only the markers or latest panel your question is about, with each laboratory's own units and reference ranges. Never your full history by default." },
  supplements: { label: "Supplements (when relevant)", sends: "Names, doses and start/stop dates of your active supplements, only when your question is about them." },
  strength: { label: "Strength training", sends: "Your current workout (exercises, sets, weights, reps, RPE/RIR, notes) and your logged history for the exercises in question: dates, top sets and estimated 1RMs. Nothing from other modules." },
};
export const INTENTS = ["chat", "session", "daily", "plan"] as const;
export type Intent = (typeof INTENTS)[number];
export const DOMAINS = ["general", "strength"] as const;                  // "strength" is reserved for the future gym assistant (same backend)
export type Domain = (typeof DOMAINS)[number];
export const COACH_SPORTS = ["run", "bike", "swim", "strength", "football", "other"] as const;
export type CoachSport = (typeof COACH_SPORTS)[number];
export const SPORT_NAME: Record<CoachSport, string> = { run: "Running", bike: "Cycling", swim: "Swimming", strength: "Strength training", football: "Football", other: "Other sport" };
/** UI/legacy sport words -> coach sport. */
export function normalizeSport(s: unknown): CoachSport | null {
  const v = String(s ?? "").toLowerCase();
  const map: Record<string, CoachSport> = { run: "run", running: "run", bike: "bike", cycling: "bike", swim: "swim", swimming: "swim", strength: "strength", gym: "strength", football: "football", soccer: "football", other: "other", triathlon: "other" };
  return map[v] ?? null;
}

// ------------------------------------------------------------------ text safety
const OPEN = "<untrusted_user_text>", CLOSE = "</untrusted_user_text>";
/** Clean user-supplied text: no control characters, bounded length, and it can never close our untrusted-text delimiter. */
export function sanitizeText(input: unknown, max: number): string {
  if (typeof input !== "string") return "";
  return input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").split(OPEN).join("").split(CLOSE).join("").replace(/[ \t]{3,}/g, "  ").replace(/\n{4,}/g, "\n\n\n").trim().slice(0, max);
}
/** Wrap untrusted text so the model treats it as data, never as instructions. */
export const untrusted = (text: string) => `${OPEN}${text}${CLOSE}`;

const MEDICAL = /(chest (pain|pressure|tightness)|pain in (my )?chest|faint(ed|ing)?|passed out|black(ed)? out|short(ness)? of breath|can'?t breathe|palpitations?|irregular heart|heart racing at rest|dor (no|de) peito|aperto no peito|desmai|falta de ar|palpita|coughing (up )?blood|blood in (my )?(urine|stool)|sangue (na|no) (urina|fezes)|severe dizziness|tontura forte)/i;
const CRISIS = /(suicid|kill myself|end my life|self[- ]harm|want to die|quero morrer|tirar a minha vida|me matar)/i;
/** Symptoms during a workout that mean "stop this exercise", checked in the gym assistant before any AI call. */
const INJURY = /(sharp pain|stabbing pain|shooting pain|sudden pain|dizzy|dizziness|light[- ]?headed|faint|feel like passing out|black(ing)? out|vision (went|going) (dark|blurry)|\bnumb(ness)?\b|tingling|pins and needles|(heard|felt) a (pop|snap|tear)|something (popped|snapped|tore)|can'?t (move|lift|feel) my|nause(a|ous)|dor (aguda|forte|súbita)|tonto|tontura|desmai|dormência|formigueiro|estalo)/i;
export function redFlag(text: string, domain: Domain = "general"): "medical" | "crisis" | "injury" | null {
  if (CRISIS.test(text)) return "crisis";
  if (MEDICAL.test(text)) return "medical";
  if (domain === "strength" && INJURY.test(text)) return "injury";
  return null;
}
export const SAFETY_REPLY: Record<"medical" | "crisis" | "injury", string> = {
  injury: "Stop this exercise now and rest. Sharp or sudden pain, dizziness, faintness, numbness or a pop or snap are signs to stop, not to push through. If it does not settle quickly, or you have chest pain, trouble breathing or feel faint, get medical help (emergency services if it is severe). I can't diagnose injuries or prescribe rehab; a doctor or physiotherapist should assess it before you train it again.",
  medical: "What you describe can be a sign of something that needs a medical check. Please stop training for now and contact a doctor, or emergency services if the symptoms are severe, sudden or getting worse. APEX is a training and health-tracking tool, not a diagnostic service, so I won't give training advice until you have been assessed.",
  crisis: "I'm really sorry you are going through this. I can't help with this in a training app, but you deserve support right now. Please contact your local emergency number or a crisis line, or reach out to someone you trust. If you are in immediate danger, call emergency services.",
};

// ------------------------------------------------------------------ requests
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);
const isIso = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

export interface ManualSession {
  sport: CoachSport; date: string; mode: "completed" | "planned"; duration_min: number; distance_km: number | null; objective: string;
  avg_hr: number | null; max_hr: number | null; pace_s_per_km: number | null; power_w: number | null; rpe: number | null; structure: string; notes: string;
}
const optNum = (v: unknown, lo: number, hi: number, what: string): number | null | string => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : `${what} must be between ${lo} and ${hi}.`;
};
export function validateManualSession(raw: unknown, today: string): { ok: true; session: ManualSession } | { ok: false; error: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const sport = normalizeSport(r.sport);
  if (!sport) return { ok: false, error: "Choose a sport." };
  if (!isIso(r.date)) return { ok: false, error: "Training date is required." };
  const mode = r.mode === "planned" ? "planned" : r.mode === "completed" ? "completed" : null;
  if (!mode) return { ok: false, error: "Say whether the session is planned or completed." };
  if (mode === "completed" && r.date > today) return { ok: false, error: "A completed session cannot be in the future. Mark it as planned." };
  const nums = { duration: optNum(r.duration_min, 1, 1440, "Duration (minutes)"), dist: optNum(r.distance_km, 0, 1000, "Distance"), avg: optNum(r.avg_hr, 30, 250, "Average heart rate"),
    max: optNum(r.max_hr, 30, 250, "Maximum heart rate"), pace: optNum(r.pace_s_per_km, 60, 1800, "Pace"), power: optNum(r.power_w, 10, 2500, "Power"), rpe: optNum(r.rpe, 1, 10, "RPE") };
  for (const v of Object.values(nums)) if (typeof v === "string") return { ok: false, error: v };
  if (nums.duration === null) return { ok: false, error: "Duration is required." };
  if (nums.avg !== null && nums.max !== null && (nums.max as number) < (nums.avg as number)) return { ok: false, error: "Maximum heart rate cannot be below the average." };
  return { ok: true, session: {
    sport, date: r.date, mode, duration_min: nums.duration as number, distance_km: nums.dist as number | null, objective: sanitizeText(r.objective, 300), avg_hr: nums.avg as number | null,
    max_hr: nums.max as number | null, pace_s_per_km: nums.pace as number | null, power_w: nums.power as number | null, rpe: nums.rpe as number | null,
    structure: sanitizeText(r.structure, 1500), notes: sanitizeText(r.notes, 1500) } };
}

export type CoachRequest =
  | { intent: "chat" | "plan"; message: string; conversationId: string | null; categories: Category[]; domain: Domain; raceId: number | null; strength?: WorkoutSnapshot | null }
  | { intent: "session"; activityId: number | null; manual: ManualSession | null; objective: string; clarification: string; categories: Category[] }
  | { intent: "daily"; categories: Category[] };

export function validateRequest(raw: unknown, today: string): { ok: true; req: CoachRequest } | { ok: false; error: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const intent = INTENTS.find((i) => i === r.intent);
  if (!intent) return { ok: false, error: "Unknown request type." };
  const cats = r.categories === undefined ? [] : r.categories;
  if (!Array.isArray(cats) || cats.length > CATEGORIES.length || cats.some((c) => !(CATEGORIES as readonly string[]).includes(c as string)) || new Set(cats).size !== cats.length) return { ok: false, error: "Invalid data categories." };
  const categories = cats as Category[];
  if (intent === "daily") return { ok: true, req: { intent, categories } };
  if (intent === "session") {
    const activityId = r.activityId === null || r.activityId === undefined ? null : Number(r.activityId);
    if (activityId !== null && (!Number.isInteger(activityId) || activityId <= 0)) return { ok: false, error: "Invalid activity." };
    let manual: ManualSession | null = null;
    if (r.manual !== undefined && r.manual !== null) { const m = validateManualSession(r.manual, today); if (!m.ok) return m; manual = m.session; }
    if ((activityId === null) === (manual === null)) return { ok: false, error: "Choose an imported activity or describe a workout, not both." };
    return { ok: true, req: { intent, activityId, manual, objective: sanitizeText(r.objective, 300), clarification: sanitizeText(r.clarification, 1000), categories } };
  }
  const message = sanitizeText(r.message, 2000);
  if (!message) return { ok: false, error: "Write a question first." };
  const conversationId = r.conversationId === null || r.conversationId === undefined ? null : r.conversationId;
  if (conversationId !== null && !isUuid(conversationId)) return { ok: false, error: "Invalid conversation." };
  const domain = r.domain === undefined ? "general" : DOMAINS.find((d) => d === r.domain);
  if (!domain) return { ok: false, error: "Invalid conversation type." };
  const raceId = r.raceId === null || r.raceId === undefined ? null : Number(r.raceId);
  if (raceId !== null && (!Number.isInteger(raceId) || raceId <= 0)) return { ok: false, error: "Invalid race." };
  let strength: WorkoutSnapshot | null = null;
  if (r.strength !== undefined && r.strength !== null) {
    if (domain !== "strength") return { ok: false, error: "A workout can only be sent to the gym assistant." };
    const s = validateSnapshot(r.strength);
    if (!s.ok) return { ok: false, error: s.error };
    strength = s.snap;
  }
  return { ok: true, req: { intent, message, conversationId, categories, domain, raceId, strength } };
}

// ------------------------------------------------------------------ AI output validation
export function parseJsonLoose(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* not JSON */ } }
  throw new SchemaError("The Coach returned an unreadable answer.");
}
export class SchemaError extends Error {}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const strList = (v: unknown, max: number, len: number): string[] => (Array.isArray(v) ? v.map((x) => str(x, len)).filter((x): x is string => x !== null).slice(0, max) : []);
export type Confidence = "low" | "medium" | "high";
const conf = (v: unknown): Confidence => (v === "high" || v === "medium" ? v : "low");
const CONF_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
export const minConfidence = (a: Confidence, b: Confidence): Confidence => (CONF_RANK[a] <= CONF_RANK[b] ? a : b);

export interface ChatAI { answer: string; confidence: Confidence; needs_info: string[]; follow_ups: string[]; used_data: string[] }
export function parseChatAI(raw: unknown): ChatAI {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const answer = str(o.answer, 6000);
  if (!answer) throw new SchemaError("The Coach returned an empty answer.");
  return { answer, confidence: conf(o.confidence), needs_info: strList(o.needs_info, 3, 300), follow_ups: strList(o.follow_ups, 3, 120), used_data: strList(o.used_data, 8, 40) };
}

export interface SessionAI {
  status: "scored" | "needs_info"; summary: string; confidence: Confidence;
  breakdown: Array<{ key: string; points: number; reason: string; basis: "measured" | "reported" | "interpretation" }>;
  strengths: string[]; weaknesses: string[]; recommendations: string[]; historical_comment: string | null; clarifying_questions: string[];
}
export function parseSessionAI(raw: unknown, allowedKeys: readonly string[]): SessionAI {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const summary = str(o.summary, 1200);
  if (!summary) throw new SchemaError("The Coach returned an incomplete evaluation.");
  const seen = new Set<string>(), breakdown: SessionAI["breakdown"] = [];
  for (const b of Array.isArray(o.breakdown) ? o.breakdown : []) {
    const e = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
    const key = typeof e.key === "string" ? e.key : "", points = typeof e.points === "number" ? e.points : Number(e.points), reason = str(e.reason, 500);
    if (!allowedKeys.includes(key) || seen.has(key) || !Number.isFinite(points) || points < 0 || !reason) continue;      // unknown, repeated or malformed rows are dropped, never trusted
    seen.add(key);
    breakdown.push({ key, points, reason, basis: e.basis === "measured" || e.basis === "reported" ? e.basis : "interpretation" });
  }
  return {
    status: o.status === "needs_info" ? "needs_info" : "scored", summary, confidence: conf(o.confidence), breakdown,
    strengths: strList(o.strengths, 5, 300), weaknesses: strList(o.weaknesses, 5, 300), recommendations: strList(o.recommendations, 5, 400),
    historical_comment: str(o.historical_comment, 600), clarifying_questions: strList(o.clarifying_questions, 4, 300),
  };
}

export interface DailyAI {
  summary: string; recovery: string; vs_baseline: Array<{ topic: string; note: string }>; load_trend: string | null; suggestions: string[];
  missing_data: string[]; caution: string | null; confidence: Confidence;
}
/** No score, colour or "ready / not ready" label is accepted from the model: only descriptions. */
export function parseDailyAI(raw: unknown): DailyAI {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const summary = str(o.summary, 1200), recovery = str(o.recovery, 1500);
  if (!summary || !recovery) throw new SchemaError("The Coach returned an incomplete daily analysis.");
  const vs = (Array.isArray(o.vs_baseline) ? o.vs_baseline : []).map((x) => { const e = (x && typeof x === "object" ? x : {}) as Record<string, unknown>; const topic = str(e.topic, 60), note = str(e.note, 400); return topic && note ? { topic, note } : null; }).filter((x): x is { topic: string; note: string } => x !== null).slice(0, 6);
  return { summary, recovery, vs_baseline: vs, load_trend: str(o.load_trend, 600), suggestions: strList(o.suggestions, 5, 400), missing_data: strList(o.missing_data, 6, 200), caution: str(o.caution, 400), confidence: conf(o.confidence) };
}