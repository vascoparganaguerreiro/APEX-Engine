// APEX Coach orchestration. Every dependency (data access, limiter, Gemini, storage) is injected, so the same backend serves the
// session evaluator, the daily coach, the chat and (later) the gym assistant, and every step is testable with fakes.
// Order: consent -> safety screen -> essentials check -> durable rate limit -> load only the authorised and relevant context -> model
// (validated, one safe retry) -> server-side scoring -> save. Nothing is written until an answer has been accepted.
import { coachContext, type Profile } from "../profile.ts";
import {
  SAFETY_REPLY, SchemaError, minConfidence, parseChatAI, parseDailyAI, parseJsonLoose, parseSessionAI, redFlag,
  type Category, type Confidence, type CoachRequest, type Domain,
} from "./schema.ts";
import {
  RUBRIC_NOTE, SCORE_KEYS, availableKeys, categoryFor, computeScore, confidenceFor, evidenceFor, missingEssentials,
  type ExcludedCategory, type ScoredCategory, type SessionFacts,
} from "./scoring.ts";
import {
  assembleContext, biomarkerLines, compareToHistory, dailyFacts, describeSession, factsFromActivity, factsFromManual, loadFacts, loadLines, planContext, raceLines,
  recoveryContext, supplementLines, dayOf, type ActivityRow, type Block, type DailyRow, type Fact, type RaceLite, type ResultRow, type SupplementLite,
} from "./context.ts";
import { chatPrompt, dailyPrompt, gymPrompt, sessionPrompt, systemPrompt } from "./prompts.ts";
import { strengthBlocks } from "./strength.ts";
import { parseProposals, type Proposal } from "../strength/actions.ts";
import type { HSession } from "../strength/analytics.ts";

export class CoachError extends Error {
  status: number; extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) { super(message); this.status = status; this.extra = extra; }
}
export const MAX_CONTEXT_CHARS = 12_000;

export interface StoredMessage { role: "user" | "assistant"; content: string; meta: Record<string, unknown> }
export interface UsageRecord { tokensIn: number; tokensOut: number; model: string | null; outcome: "ok" | "error" }
export interface CoachDeps {
  today: string;
  consume(kind: string): Promise<{ allowed: boolean; retryAfterSeconds: number; usageId: string | null }>;
  recordUsage(usageId: string | null, u: UsageRecord): Promise<void>;
  generate(system: string, user: string): Promise<{ text: string; usage: { promptTokens: number; outputTokens: number }; model: string }>;
  loadProfile(): Promise<Profile | null>;
  loadActivities(days: number): Promise<ActivityRow[]>;
  getActivity(id: number): Promise<ActivityRow | null>;
  loadDaily(days: number): Promise<DailyRow[]>;
  loadRaces(): Promise<RaceLite[]>;
  loadBiomarkers(): Promise<ResultRow[]>;
  loadSupplements(): Promise<SupplementLite[]>;
  loadConversation(id: string): Promise<{ id: string; domain: Domain } | null>;
  loadMessages(conversationId: string, limit: number): Promise<StoredMessage[]>;
  createConversation(title: string, domain: Domain): Promise<string>;
  addMessages(conversationId: string, msgs: StoredMessage[]): Promise<void>;
  saveAssessment(a: { kind: "session" | "daily"; mode: string | null; sport: string | null; subject: Record<string, unknown>; result: Record<string, unknown>; score: number | null; confidence: Confidence; categories: string[] }): Promise<string>;
  /** Logged strength sessions (Strength Hub). Optional: without it, or before migration 13, the gym assistant simply has no history. */
  loadStrengthHistory?(keys: string[] | null, days: number): Promise<HSession[]>;
}

// ------------------------------------------------------------------ results returned to the app
export interface CoachMeta { confidence: Confidence; used_data: string[]; categories_sent: string[]; not_sent: string[]; truncated: string[]; follow_ups: string[]; needs_info: string[]; safety?: boolean }
/** proposals: workout changes Ask APEX suggests. They are validated against an allowlist and are NEVER applied by the server; the app
 *  shows each one and applies it only after the user confirms. */
export interface ChatResult { kind: "chat"; conversationId: string | null; answer: string; meta: CoachMeta; saved: boolean; proposals?: Proposal[] }
export interface SessionResult {
  kind: "session"; status: "scored" | "needs_info"; mode: "completed" | "planned"; sport: string; facts: Fact[]; score: number | null; category: string | null; confidence: Confidence; summary: string | null;
  breakdown: ScoredCategory[]; excluded: ExcludedCategory[]; strengths: string[]; weaknesses: string[]; recommendations: string[];
  history: { available: boolean; note: string; changes: Fact[]; sessionsCompared: number; comment: string | null }; questions: string[]; rubricNote: string; categories_sent: string[]; id: string | null; saved: boolean;
}
export interface DailyResult {
  kind: "daily"; status: "ok" | "needs_data"; facts: Fact[]; missing: string[]; summary: string | null; recovery: string | null; vs_baseline: Array<{ topic: string; note: string }>;
  load_trend: string | null; suggestions: string[]; caution: string | null; confidence: Confidence; categories_sent: string[]; id: string | null; saved: boolean;
}
export type CoachResult = ChatResult | SessionResult | DailyResult;

// ------------------------------------------------------------------ helpers
const usageOf = () => ({ tokensIn: 0, tokensOut: 0, model: null as string | null });

async function runModel<T>(deps: CoachDeps, system: string, user: string, parse: (raw: unknown) => T, acc: ReturnType<typeof usageOf>): Promise<T> {
  let prompt = user;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await deps.generate(system, prompt);
    acc.tokensIn += r.usage.promptTokens; acc.tokensOut += r.usage.outputTokens; acc.model = r.model;
    try { return parse(parseJsonLoose(r.text)); }
    catch (e) {
      if (!(e instanceof SchemaError)) throw e;
      if (attempt === 1) throw new CoachError(502, "The Coach returned an answer that could not be used. Please try again.");
      prompt = `${user}\n\nYour previous reply did not match the schema. Reply again with ONLY the JSON object.`;      // safe: nothing has been saved yet
    }
  }
  throw new CoachError(502, "The Coach returned an answer that could not be used. Please try again.");
}

async function limited(deps: CoachDeps, kind: string) {
  const q = await deps.consume(kind);
  if (!q.allowed) throw new CoachError(429, `You have reached the Coach limit for now. Try again in ${q.retryAfterSeconds < 90 ? `about ${Math.max(1, q.retryAfterSeconds)} seconds` : `about ${Math.ceil(q.retryAfterSeconds / 60)} minutes`}.`, { retryAfterSeconds: q.retryAfterSeconds });
  return q.usageId;
}

/** Wrap a model-using flow so token usage is recorded whether it succeeds or fails. */
async function metered<T>(deps: CoachDeps, usageId: string | null, run: (acc: ReturnType<typeof usageOf>) => Promise<T>): Promise<T> {
  const acc = usageOf();
  try { const out = await run(acc); await deps.recordUsage(usageId, { ...acc, outcome: "ok" }).catch(() => undefined); return out; }
  catch (e) { await deps.recordUsage(usageId, { ...acc, outcome: "error" }).catch(() => undefined); throw e; }
}

export function profileFacts(p: Profile, today: string): Fact[] {
  const c = coachContext(p, today), out: Fact[] = [];
  if (c.age !== null) out.push({ label: "Age", value: String(c.age) });
  out.push({ label: "Units", value: c.units });
  if (c.preferred_sports.length) out.push({ label: "Preferred sports", value: c.preferred_sports.join(", ") });
  if (c.primary_goal) out.push({ label: "Primary goal", value: c.primary_goal.replace(/_/g, " ") });
  if (c.experience_level) out.push({ label: "Training experience", value: c.experience_level });
  const src = (s: string) => (s === "not_recorded" ? "source not recorded" : s);
  for (const [k, v] of Object.entries(c.baselines as Record<string, { value: number; unit: string; source: string }>)) out.push({ label: `Baseline ${k.replace(/_/g, " ")}`, value: `${v.value} ${v.unit} (${src(v.source)})` });
  return out;
}
const activityLine = (a: ActivityRow, tz: string): Fact => ({
  label: dayOf(a.started_at, tz),
  value: [a.sport, a.duration_s ? `${Math.round(a.duration_s / 60)} min` : null, a.distance_m ? `${Math.round(a.distance_m / 100) / 10} km` : null, a.avg_hr ? `avg HR ${a.avg_hr}` : null, a.avg_power_w ? `${a.avg_power_w} W` : null, a.load ? `load ${a.load}` : null, a.rpe ? `RPE ${a.rpe}` : null].filter(Boolean).join(", "),
});

// ------------------------------------------------------------------ entry point
export async function runCoach(deps: CoachDeps, req: CoachRequest, consent: boolean): Promise<CoachResult> {
  if (req.categories.length > 0 && !consent) throw new CoachError(400, "Confirm that you agree to share the selected data with the AI.");
  if (req.intent === "daily") return runDaily(deps, req);
  if (req.intent === "session") return runSession(deps, req);
  return runChat(deps, req);
}

// ------------------------------------------------------------------ session evaluation
async function runSession(deps: CoachDeps, req: Extract<CoachRequest, { intent: "session" }>): Promise<SessionResult> {
  const profile = await deps.loadProfile().catch(() => null);
  const tz = profile?.timezone ?? "UTC";
  let facts: SessionFacts, activityId: number | null = null;
  if (req.activityId !== null) {
    const a = await deps.getActivity(req.activityId);                      // read-only: an imported activity is never modified or duplicated
    if (!a) throw new CoachError(404, "Activity not found.");
    activityId = a.id; facts = factsFromActivity(a, tz, req.objective, req.clarification);
  } else facts = factsFromManual(req.manual!, req.clarification);
  if (req.manual && !facts.objective && req.objective) facts = { ...facts, objective: req.objective };

  const text = [facts.objective, facts.structure, facts.notes].join("\n");
  const flag = redFlag(text);
  if (flag) throw new CoachError(422, SAFETY_REPLY[flag], { safety: flag });

  const base = { kind: "session" as const, mode: facts.mode, sport: facts.sport, facts: describeSession(facts), rubricNote: RUBRIC_NOTE };
  const questions = missingEssentials(facts);
  const empty = { score: null, category: null, summary: null, breakdown: [], excluded: [], strengths: [], weaknesses: [], recommendations: [], history: { available: false, note: "", changes: [], sessionsCompared: 0, comment: null }, categories_sent: [], id: null, saved: false };
  if (questions.length) return { ...base, ...empty, status: "needs_info", confidence: "low", questions };      // asked before any AI call or quota use

  const plan = planContext({ intent: "session", question: "", authorized: req.categories, previous: [] });
  const cats = new Set<Category>(plan.categories);
  const [activities, daily] = await Promise.all([cats.has("activities") ? deps.loadActivities(90) : Promise.resolve([] as ActivityRow[]), cats.has("wellness") ? deps.loadDaily(30) : Promise.resolve([] as DailyRow[])]);
  const history = activities.filter((a) => a.id !== activityId);
  const comparison = cats.has("activities") ? compareToHistory(facts, history, tz, activityId) : { available: false, sessionsCompared: 0, windowDays: 56, note: "Recent activities were not shared with the Coach, so no comparison was made.", medians: { duration_min: null, distance_km: null, avg_hr: null, load: null, pace_s_per_km: null }, changes: [] as Fact[] };
  const recov = recoveryContext(facts, history, daily, { activities: cats.has("activities"), wellness: cats.has("wellness") }, tz, activityId);
  const evidence = evidenceFor(facts, { sameSportCount: comparison.sessionsCompared }, recov.evidence);
  const available = availableKeys(evidence);

  const blocks: Block[] = [{ category: "session", title: "Session (measured or reported)", facts: describeSession(facts), priority: 0 }];
  if (cats.has("profile") && profile) blocks.push({ category: "profile", title: "Personal baselines", facts: profileFacts(profile, deps.today), priority: 1 });
  blocks.push({ category: "history", title: "History comparison", facts: [{ label: "Available", value: comparison.available ? "yes" : "no" }, { label: "Note", value: comparison.note }, ...comparison.changes], priority: 2 });
  if (recov.lines.length) blocks.push({ category: "activities", title: "Scheduling context", facts: recov.lines, priority: 3 });
  if (cats.has("wellness") && daily.length) blocks.push({ category: "wellness", title: "Recent wellness", facts: dailyFacts(daily, facts.date, profile?.sleep_goal_h ?? null).lines, priority: 4 });
  if (cats.has("load") && activities.length) blocks.push({ category: "load", title: "Training load", facts: loadLines(loadFacts(activities, deps.today, tz)), priority: 5 });
  const ctx = assembleContext(blocks, MAX_CONTEXT_CHARS);
  const sent = [...new Set(blocks.map((b) => b.category).filter((c): c is Category => c !== "session" && c !== "history"))];

  const usageId = await limited(deps, "session");
  const ai = await metered(deps, usageId, (acc) => runModel(deps, systemPrompt("chat"), sessionPrompt({ mode: facts.mode, sport: facts.sport, available, contextText: ctx.text, userNotes: [facts.notes, facts.structure].filter(Boolean).join("\n"), clarification: "" }), (raw) => parseSessionAI(raw, SCORE_KEYS), acc));

  const scored = computeScore(ai.breakdown, evidence, facts.sport);
  const cleanHistory = { available: comparison.available, note: comparison.note, changes: comparison.changes, sessionsCompared: comparison.sessionsCompared, comment: comparison.available ? ai.historical_comment : null };
  const enoughToScore = scored.score !== null && ai.status === "scored";
  const confidence = enoughToScore ? minConfidence(confidenceFor(scored, facts, { sameSportCount: comparison.sessionsCompared }), ai.confidence) : "low";
  const result: SessionResult = {
    ...base, status: enoughToScore ? "scored" : "needs_info", score: enoughToScore ? scored.score : null, category: enoughToScore ? categoryFor(scored.score as number, facts.mode) : null, confidence, summary: ai.summary,
    breakdown: scored.scored, excluded: scored.excluded, strengths: ai.strengths, weaknesses: ai.weaknesses, recommendations: ai.recommendations, history: cleanHistory,
    questions: enoughToScore ? [] : ai.clarifying_questions.length ? ai.clarifying_questions : ["There is not enough evidence to score this session yet. Add details about its structure, effort or the data you have."],
    categories_sent: sent, id: null, saved: false,
  };
  try {
    result.id = await deps.saveAssessment({
      kind: "session", mode: facts.mode, sport: facts.sport, categories: sent, score: result.score, confidence,
      subject: activityId !== null ? { activity_id: activityId, objective: facts.objective } : { manual: { sport: facts.sport, date: facts.date, mode: facts.mode, duration_s: facts.duration_s, distance_m: facts.distance_m, objective: facts.objective } },
      result: result as unknown as Record<string, unknown>,
    });
    result.saved = true;
  } catch { /* the evaluation is still shown; a storage failure never touches activities or the profile */ }
  return result;
}

// ------------------------------------------------------------------ daily coach
async function runDaily(deps: CoachDeps, req: Extract<CoachRequest, { intent: "daily" }>): Promise<DailyResult> {
  const plan = planContext({ intent: "daily", question: "", authorized: req.categories, previous: [] });
  const cats = new Set<Category>(plan.categories);
  const profile = await deps.loadProfile().catch(() => null);
  const tz = profile?.timezone ?? "UTC";
  const needAct = cats.has("activities") || cats.has("load");
  const [daily, activities, races] = await Promise.all([
    cats.has("wellness") ? deps.loadDaily(60) : Promise.resolve([] as DailyRow[]), needAct ? deps.loadActivities(120) : Promise.resolve([] as ActivityRow[]),
    cats.has("races") ? deps.loadRaces().catch(() => [] as RaceLite[]) : Promise.resolve([] as RaceLite[]),
  ]);
  const blocks: Block[] = [];
  const missing: string[] = [];
  if (cats.has("profile") && profile) blocks.push({ category: "profile", title: "Personal baselines", facts: profileFacts(profile, deps.today), priority: 1 });
  let df = null as ReturnType<typeof dailyFacts> | null;
  if (cats.has("wellness")) { df = dailyFacts(daily, deps.today, profile?.sleep_goal_h ?? null); blocks.push({ category: "wellness", title: "Recovery (your own data vs your own baseline)", facts: df.lines, priority: 2 }); missing.push(...df.missing); }
  else missing.push("Daily wellness data was not shared with the Coach.");
  const lf = needAct && activities.length ? loadFacts(activities, deps.today, tz) : null;
  if (cats.has("load") && lf) blocks.push({ category: "load", title: "Training load", facts: loadLines(lf), priority: 3 });
  if (cats.has("activities") && activities.length) blocks.push({ category: "activities", title: "Recent sessions", facts: activities.slice(0, 8).map((a) => activityLine(a, tz)), priority: 4 });
  const rl = raceLines(races, deps.today, null);
  if (cats.has("races") && rl.length) blocks.push({ category: "races", title: "Upcoming races", facts: rl, priority: 5 });
  if (cats.has("load") && !lf) missing.push("No activities with a training load yet.");
  else if (lf && !lf.valid && lf.reason) missing.push(lf.reason);
  if (cats.has("profile") && !profile) missing.push("No profile baselines saved yet (Profile page).");

  const facts = blocks.flatMap((b) => b.facts.map((f) => ({ label: `${b.title.split(" (")[0]}: ${f.label}`, value: f.value })));
  const noData = !(df?.hasData) && !activities.length;
  if (req.categories.length === 0 || noData) {
    return { kind: "daily", status: "needs_data", facts, missing: req.categories.length === 0 ? ["Choose which data the Coach may use (Daily wellness, Recent activities, Training load, Profile baselines)."] : [...new Set([...missing, "There is not enough recorded data to say anything reliable yet."])], summary: null, recovery: null, vs_baseline: [], load_trend: null, suggestions: [], caution: null, confidence: "low", categories_sent: [], id: null, saved: false };
  }
  const ctx = assembleContext(blocks, MAX_CONTEXT_CHARS);
  const sent = [...new Set(blocks.map((b) => b.category as Category))];
  const usageId = await limited(deps, "daily");
  const ai = await metered(deps, usageId, (acc) => runModel(deps, systemPrompt("daily"), dailyPrompt(ctx.text), parseDailyAI, acc));
  // The model can lower the confidence; stale or sparse data caps it regardless.
  const cap: Confidence = !df || !df.hasData || (df.staleDays ?? 99) > 3 ? "low" : (df.staleDays ?? 0) > 1 || missing.length >= 3 ? "medium" : "high";
  const out: DailyResult = {
    kind: "daily", status: "ok", facts, missing: [...new Set([...missing, ...ai.missing_data])], summary: ai.summary, recovery: ai.recovery, vs_baseline: ai.vs_baseline, load_trend: ai.load_trend,
    suggestions: ai.suggestions, caution: ai.caution, confidence: minConfidence(cap, ai.confidence), categories_sent: sent, id: null, saved: false,
  };
  try { out.id = await deps.saveAssessment({ kind: "daily", mode: null, sport: null, subject: { day: deps.today }, result: out as unknown as Record<string, unknown>, score: null, confidence: out.confidence, categories: sent }); out.saved = true; } catch { /* still shown */ }
  return out;
}

// ------------------------------------------------------------------ chat and race preparation
async function runChat(deps: CoachDeps, req: Extract<CoachRequest, { intent: "chat" | "plan" }>): Promise<ChatResult> {
  let conversationId: string | null = null, history: StoredMessage[] = [];
  if (req.conversationId) {
    const c = await deps.loadConversation(req.conversationId);              // scoped to the signed-in user: someone else's id is "not found"
    if (!c) throw new CoachError(404, "Conversation not found.");
    conversationId = c.id; history = await deps.loadMessages(c.id, 10);
  }
  const meta0 = (m: CoachMeta | Record<string, unknown>) => m as unknown as CoachMeta;
  const flag = redFlag(req.message, req.domain);
  if (flag) {                                                               // deterministic: no AI call, no quota
    const reply = SAFETY_REPLY[flag];
    const meta: CoachMeta = { confidence: "high", used_data: [], categories_sent: [], not_sent: req.categories, truncated: [], follow_ups: [], needs_info: [], safety: true };
    let saved = false;
    try { conversationId ??= await deps.createConversation(req.message.slice(0, 60), req.domain); await deps.addMessages(conversationId, [{ role: "user", content: req.message, meta: {} }, { role: "assistant", content: reply, meta: meta0(meta) as unknown as Record<string, unknown> }]); saved = true; } catch { /* still shown */ }
    return { kind: "chat", conversationId, answer: reply, meta, saved };
  }

  const previous = ([...history].reverse().find((m) => m.role === "assistant")?.meta.categories_sent as Category[] | undefined) ?? [];
  const plan = planContext({ intent: req.intent, question: req.message, authorized: req.categories, previous, domain: req.domain });
  const cats = new Set<Category>(plan.categories);
  if (req.domain === "strength") return runGym(deps, req, cats, plan.notSent, history, conversationId);
  const profile = await deps.loadProfile().catch(() => null);
  const tz = profile?.timezone ?? "UTC";
  const needAct = cats.has("activities") || cats.has("load");
  const [daily, activities, races, results, supps] = await Promise.all([
    cats.has("wellness") ? deps.loadDaily(60).catch(() => [] as DailyRow[]) : Promise.resolve([] as DailyRow[]),
    needAct ? deps.loadActivities(120).catch(() => [] as ActivityRow[]) : Promise.resolve([] as ActivityRow[]),
    cats.has("races") ? deps.loadRaces().catch(() => [] as RaceLite[]) : Promise.resolve([] as RaceLite[]),
    cats.has("biomarkers") ? deps.loadBiomarkers().catch(() => [] as ResultRow[]) : Promise.resolve([] as ResultRow[]),
    cats.has("supplements") ? deps.loadSupplements().catch(() => [] as SupplementLite[]) : Promise.resolve([] as SupplementLite[]),
  ]);
  const blocks: Block[] = [];
  const none = (c: Category, title: string, why: string, p: number) => blocks.push({ category: c, title, facts: [{ label: "Status", value: why }], priority: p });
  if (cats.has("profile")) profile ? blocks.push({ category: "profile", title: "Personal baselines", facts: profileFacts(profile, deps.today), priority: 1 }) : none("profile", "Personal baselines", "no profile saved yet", 1);
  if (cats.has("wellness")) blocks.push({ category: "wellness", title: "Recovery (own data vs own baseline)", facts: dailyFacts(daily, deps.today, profile?.sleep_goal_h ?? null).lines, priority: 2 });
  if (cats.has("load")) { activities.length ? blocks.push({ category: "load", title: "Training load", facts: loadLines(loadFacts(activities, deps.today, tz)), priority: 3 }) : none("load", "Training load", "no activities with a load recorded", 3); }
  if (cats.has("activities")) { activities.length ? blocks.push({ category: "activities", title: "Recent sessions", facts: activities.slice(0, 10).map((a) => activityLine(a, tz)), priority: 4 }) : none("activities", "Recent sessions", "no activities recorded", 4); }
  if (cats.has("races")) { const rl = raceLines(races, deps.today, req.raceId); rl.length ? blocks.push({ category: "races", title: "Upcoming races", facts: rl, priority: 5 }) : none("races", "Upcoming races", "no upcoming races saved", 5); }
  if (cats.has("biomarkers")) { const bl = biomarkerLines(results, req.message); bl.length ? blocks.push({ category: "biomarkers", title: "Blood results (laboratory's own ranges)", facts: bl, priority: 6 }) : none("biomarkers", "Blood results", "no matching results stored", 6); }
  if (cats.has("supplements")) { const sl = supplementLines(supps, deps.today); sl.length ? blocks.push({ category: "supplements", title: "Active supplements", facts: sl, priority: 7 }) : none("supplements", "Active supplements", "none recorded", 7); }
  const ctx = assembleContext(blocks, MAX_CONTEXT_CHARS);
  const sent = [...new Set(blocks.map((b) => b.category as Category))].filter((c) => ctx.included.some((t) => blocks.find((b) => b.title === t)?.category === c));

  const usageId = await limited(deps, req.intent);
  const ai = await metered(deps, usageId, (acc) => runModel(deps, systemPrompt(req.intent, req.domain), chatPrompt({
    history: history.map((m) => ({ role: m.role, content: m.content })), message: req.message, contextText: ctx.text, available: sent }), parseChatAI, acc));
  const meta: CoachMeta = { confidence: ai.confidence, used_data: sent, categories_sent: sent, not_sent: plan.notSent, truncated: ctx.truncated, follow_ups: ai.follow_ups, needs_info: ai.needs_info };
  let saved = false;
  try {
    conversationId ??= await deps.createConversation(req.message.slice(0, 60), req.domain);
    await deps.addMessages(conversationId, [{ role: "user", content: req.message, meta: {} }, { role: "assistant", content: ai.answer, meta: meta as unknown as Record<string, unknown> }]);
    saved = true;
  } catch { /* the answer is still shown */ }
  return { kind: "chat", conversationId, answer: ai.answer, meta, saved };
}
// ------------------------------------------------------------------ Ask APEX (gym assistant, domain "strength")
// Same consent, safety screen, limiter, model wrapper and storage as the chat. Only strength data (and profile/wellness when asked
// about and authorised) is used. Proposed workout changes are validated and returned; the server never applies them.
async function runGym(deps: CoachDeps, req: Extract<CoachRequest, { intent: "chat" | "plan" }>, cats: Set<Category>, notSent: Category[], history: StoredMessage[], conversationIdIn: string | null): Promise<ChatResult> {
  let conversationId = conversationIdIn;
  const profile = cats.has("profile") || cats.has("wellness") ? await deps.loadProfile().catch(() => null) : null;
  const tz = profile?.timezone ?? "UTC";
  const snap = cats.has("strength") ? req.strength ?? null : null;          // the workout is only used when "Strength training" is authorised
  let sessions: HSession[] = [];
  if (cats.has("strength") && deps.loadStrengthHistory) {
    const keys = snap ? [...new Set(snap.exercises.map((e) => e.key).filter((k): k is string => Boolean(k) && !String(k).startsWith("custom:")))] : [];
    sessions = await deps.loadStrengthHistory(keys.length ? keys : null, 365).catch(() => [] as HSession[]);
  }
  const sc = cats.has("strength") ? strengthBlocks({ snap, history: sessions, question: req.message, now: new Date().toISOString(), tz }) : null;
  const blocks: Block[] = [...(sc?.blocks ?? [])];
  if (cats.has("profile") && profile) blocks.push({ category: "profile", title: "Personal baselines", facts: profileFacts(profile, deps.today), priority: 5 });
  if (cats.has("wellness")) { const daily = await deps.loadDaily(30).catch(() => [] as DailyRow[]); blocks.push({ category: "wellness", title: "Recovery (own data vs own baseline)", facts: dailyFacts(daily, deps.today, profile?.sleep_goal_h ?? null).lines, priority: 6 }); }
  const ctx = assembleContext(blocks, MAX_CONTEXT_CHARS);
  const sent = [...new Set(blocks.filter((b) => ctx.included.includes(b.title)).map((b) => b.category as Category))];

  const usageId = await limited(deps, "chat");
  const ai = await metered(deps, usageId, (acc) => runModel(deps, systemPrompt("chat", "strength"), gymPrompt({
    history: history.map((m) => ({ role: m.role, content: m.content })), message: req.message, contextText: ctx.text, available: sent,
    inWorkout: Boolean(snap && snap.status === "active"), historical: Boolean(snap && snap.status === "completed"),
  }), (raw) => ({ ...parseChatAI(raw), proposals: snap ? parseProposals((raw as Record<string, unknown> | null)?.actions, snap) : [] }), acc));
  const meta: CoachMeta = { confidence: ai.confidence, used_data: sent, categories_sent: sent, not_sent: notSent, truncated: ctx.truncated, follow_ups: ai.follow_ups, needs_info: ai.needs_info };
  let saved = false;
  try {
    conversationId ??= await deps.createConversation(req.message.slice(0, 60), "strength");
    await deps.addMessages(conversationId, [{ role: "user", content: req.message, meta: {} }, { role: "assistant", content: ai.answer, meta: { ...meta, proposals: ai.proposals.length } as unknown as Record<string, unknown> }]);
    saved = true;
  } catch { /* the answer is still shown */ }
  return { kind: "chat", conversationId, answer: ai.answer, meta, saved, proposals: ai.proposals };
}
