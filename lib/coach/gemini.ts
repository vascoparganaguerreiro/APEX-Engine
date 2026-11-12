// One server-side Gemini caller for every AI feature (Coach, Ask APEX, activity and weekly summaries). Pure apart from the injected fetch.
//
// TIME: the route limit is 60 s (maxDuration). Every request gets ONE budget (COACH_BUDGET_MS, from the start of the request, shared by all
// the calls the request makes), and model discovery counts against it. Each model call has its own, shorter timeout, so a slow model leaves
// time to try the next one. Nothing here waits longer than the budget.
//   budget 48 s = discovery (<= 8 s, first call only) + a model call (<= 20 s) + a fallback model call (<= 20 s), leaving ~12 s of the
//   60 s route limit for loading context before and saving after.
// MODELS: the existing discovery and ranking decide the order (nothing is hard-coded). A model that times out, errors (5xx), is unavailable or
//   rejects the request is skipped in favour of the NEXT model; the same model is only tried again when it is the only one available.
//   Permanent errors (rejected credentials) and quota errors stop at once.
// LOGGING: one safe line per failed attempt: model id, attempt number, elapsed time, category, HTTP status, error name/code. Never keys,
//   URLs, prompts, personal data or answers.
import { extractText, rankModels } from "../summary.ts";

export type GeminiErrorKind = "timeout" | "unavailable" | "quota" | "empty" | "config";
export type AttemptCategory = "ok" | "timeout" | "network" | "http_error" | "quota" | "model_unavailable" | "bad_request" | "credentials" | "empty" | "discovery";
export interface AttemptLog { model: string; attempt: number; elapsedMs: number; category: AttemptCategory; status?: number; errorName?: string; errorCode?: string }
export class GeminiError extends Error {
  kind: GeminiErrorKind;
  attempts: AttemptLog[];
  constructor(kind: GeminiErrorKind, message: string, attempts: AttemptLog[] = []) { super(message); this.kind = kind; this.attempts = attempts; }
}

/** Total time one request may spend talking to Gemini, measured from the start of the request (route limit: 60 s). */
export const COACH_BUDGET_MS = 48_000;
export const PER_MODEL_TIMEOUT_MS = 20_000;
export const DISCOVERY_TIMEOUT_MS = 8_000;
/** An attempt with less time than this left is not started. */
export const MIN_ATTEMPT_MS = 4_000;
/** Deadline (epoch ms) for a request that starts now. Routes create it once at the top and pass it to every Gemini call they make. */
export const deadlineFromNow = (now: () => number = Date.now, ms: number = COACH_BUDGET_MS) => now() + ms;

export interface GeminiConfig {
  apiKey: string | undefined; fetch?: typeof fetch; modelOverride?: string;
  timeoutMs?: number;                         // per model call (default PER_MODEL_TIMEOUT_MS)
  maxAttempts?: number;                       // total calls for the request (default 4)
  deadline?: number;                          // epoch ms by which the whole request must be finished (default: now + COACH_BUDGET_MS)
  now?: () => number;                         // clock (tests)
  log?: (a: AttemptLog) => void;              // safe diagnostics (default: console)
}
export interface GeminiResult { text: string; usage: { promptTokens: number; outputTokens: number }; model: string; attempts: number }

let cachedModels: string[] | null = null;
let lastGood: string | null = null;
export const resetModelCache = () => { cachedModels = null; lastGood = null; };

const safeName = (s: unknown, re: RegExp) => (typeof s === "string" && re.test(s) ? s : undefined);
const defaultLog = (a: AttemptLog) => { (a.category === "ok" ? console.warn : console.error)("coach: gemini attempt", JSON.stringify(a)); };
/** Name and code of a failed fetch, sanitised (they never contain URLs, keys or content). */
function errInfo(e: unknown): { errorName?: string; errorCode?: string } {
  const err = e as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  return { errorName: safeName(err?.name, /^[A-Za-z]{1,40}$/), errorCode: safeName(err?.cause?.code ?? err?.code, /^[A-Z0-9_]{3,40}$/) };
}
const isTimeout = (e: unknown) => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

async function discover(cfg: GeminiConfig, f: typeof fetch, timeoutMs: number): Promise<string[]> {
  if (cfg.modelOverride) return [cfg.modelOverride];
  if (cachedModels) return cachedModels;
  const r = await f("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { headers: { "x-goog-api-key": cfg.apiKey as string }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw Object.assign(new Error("model list failed"), { status: r.status });
  const j = (await r.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
  cachedModels = rankModels(j.models ?? []).slice(0, 3);
  if (!cachedModels.length) { cachedModels = null; throw new Error("no models"); }
  return cachedModels;
}

type Mode = { json: boolean };
async function call(cfg: GeminiConfig, req: { system: string; user: string; maxOutputTokens?: number; temperature?: number }, mode: Mode): Promise<GeminiResult> {
  if (!cfg.apiKey) throw new GeminiError("config", "The AI assistant isn't available right now. Please try again later.");
  const f = cfg.fetch ?? fetch, now = cfg.now ?? Date.now, log = cfg.log ?? defaultLog;
  const t0 = now(), deadline = cfg.deadline ?? t0 + COACH_BUDGET_MS, perModel = cfg.timeoutMs ?? PER_MODEL_TIMEOUT_MS, cap = cfg.maxAttempts ?? 4;
  const remaining = () => deadline - now();
  const trail: AttemptLog[] = [];
  const note = (a: Omit<AttemptLog, "elapsedMs">, since: number) => { const x: AttemptLog = { ...a, elapsedMs: Math.max(0, Math.round(now() - since)) }; trail.push(x); try { log(x); } catch { /* logging must never break a request */ } return x; };
  const tooSlow = () => new GeminiError("timeout", "The Coach took too long to answer. Please try again in a moment.", trail);
  if (remaining() < MIN_ATTEMPT_MS) throw tooSlow();

  let models: string[];
  const d0 = now();
  try { models = await discover(cfg, f, Math.max(1, Math.min(DISCOVERY_TIMEOUT_MS, remaining() - MIN_ATTEMPT_MS))); }
  catch (e) {
    const status = (e as { status?: unknown })?.status;
    note({ model: "discovery", attempt: 0, category: "discovery", status: typeof status === "number" ? status : undefined, ...errInfo(e) }, d0);
    throw isTimeout(e) ? tooSlow() : new GeminiError("unavailable", "The AI service is not reachable.", trail);
  }
  if (lastGood && models.includes(lastGood)) models = [lastGood, ...models.filter((m) => m !== lastGood)];   // the model that answered last time goes first
  const eligible = models.filter((m) => /^[a-z0-9.\-]+$/.test(m));
  const perModelTries = eligible.length <= 1 ? 2 : 1;                      // never hammer one model while another is available

  let attempts = 0, last: GeminiError | null = null;
  outer: for (const model of eligible) {
    for (let k = 0; k < perModelTries; k++) {
      if (attempts >= cap) break outer;
      if (remaining() < MIN_ATTEMPT_MS) { last = last ?? tooSlow(); break outer; }
      attempts += 1;
      const started = now(), timeout = Math.max(1, Math.min(perModel, remaining() - 500));
      let res: Response;
      try {
        res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.apiKey }, signal: AbortSignal.timeout(timeout),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: req.system }] }, contents: [{ role: "user", parts: [{ text: req.user }] }],
            ...(mode.json ? { generationConfig: { responseMimeType: "application/json", temperature: req.temperature ?? 0.3, maxOutputTokens: req.maxOutputTokens ?? 2048 } } : {}),
          }),
        });
      } catch (e) {
        const to = isTimeout(e);
        note({ model, attempt: attempts, category: to ? "timeout" : "network", ...errInfo(e) }, started);
        last = to ? tooSlow() : new GeminiError("unavailable", "The AI service is not reachable.", trail);
        continue;                                                            // same model again only if it is the only one; otherwise the loop moves on
      }
      if (res.status === 429) { note({ model, attempt: attempts, category: "quota", status: 429 }, started); throw new GeminiError("quota", "The AI quota is used up for now. Please try again later.", trail); }
      if (!res.ok) {
        // The body is read ONLY to tell a rejected key from an unusable model; it is never logged or returned.
        const body = res.status === 400 || res.status === 403 ? await res.text().catch(() => "") : "";
        if (res.status === 401 || ((res.status === 400 || res.status === 403) && /API_KEY_INVALID|API key not valid|API key expired/i.test(body))) {
          note({ model, attempt: attempts, category: "credentials", status: res.status }, started);
          throw new GeminiError("config", "The AI credentials were rejected by the AI service. Check GEMINI_API_KEY on the server.", trail);   // permanent: no other model will help
        }
        if (res.status === 403 || res.status === 404) { note({ model, attempt: attempts, category: "model_unavailable", status: res.status }, started); last = new GeminiError("unavailable", "The AI model is not available.", trail); break; }
        if (res.status === 400) { note({ model, attempt: attempts, category: "bad_request", status: 400 }, started); last = new GeminiError("unavailable", "The AI model could not handle this request.", trail); break; }   // not retryable on this model
        note({ model, attempt: attempts, category: "http_error", status: res.status }, started);
        last = new GeminiError("unavailable", "The AI service had an error.", trail);
        continue;
      }
      let json: unknown = null, bodyErr: unknown = null;
      try { json = await res.json(); } catch (e) { bodyErr = e; }
      if (bodyErr && isTimeout(bodyErr)) { note({ model, attempt: attempts, category: "timeout", status: res.status, ...errInfo(bodyErr) }, started); last = tooSlow(); continue; }
      const text = extractText(json);
      if (!text) { note({ model, attempt: attempts, category: "empty", status: res.status }, started); last = new GeminiError("empty", "The Coach returned an empty answer.", trail); continue; }
      if (attempts > 1) note({ model, attempt: attempts, category: "ok", status: res.status }, started);   // recovered after a failure: worth one line
      lastGood = model;
      const u = (json as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } } | null)?.usageMetadata;
      return { text, usage: { promptTokens: Number(u?.promptTokenCount ?? 0), outputTokens: Number(u?.candidatesTokenCount ?? 0) }, model, attempts };
    }
  }
  throw last ?? new GeminiError("unavailable", "The AI service did not answer.", trail);
}

/** Structured (JSON) answer: Coach, Ask APEX. */
export function generateJson(cfg: GeminiConfig, req: { system: string; user: string; maxOutputTokens?: number; temperature?: number }): Promise<GeminiResult> { return call(cfg, req, { json: true }); }
/** Plain-text answer: activity and weekly summaries. Same budget, fallback and diagnostics. */
export function generateText(cfg: GeminiConfig, req: { system: string; user: string }): Promise<GeminiResult> { return call(cfg, req, { json: false }); }
