// One server-side Gemini caller for every Coach feature (and the future gym assistant). Pure apart from the injected fetch.
// Timeouts, safe retries (nothing is written before an answer is accepted), error kinds and token usage.
import { extractText, rankModels } from "../summary.ts";

export type GeminiErrorKind = "timeout" | "unavailable" | "quota" | "empty" | "config";
export class GeminiError extends Error {
  kind: GeminiErrorKind;
  constructor(kind: GeminiErrorKind, message: string) { super(message); this.kind = kind; }
}
export interface GeminiConfig { apiKey: string | undefined; fetch?: typeof fetch; timeoutMs?: number; maxAttempts?: number; modelOverride?: string }
export interface GeminiResult { text: string; usage: { promptTokens: number; outputTokens: number }; model: string; attempts: number }

let cachedModels: string[] | null = null;
export const resetModelCache = () => { cachedModels = null; };

async function models(cfg: GeminiConfig, f: typeof fetch): Promise<string[]> {
  if (cfg.modelOverride) return [cfg.modelOverride];
  if (cachedModels) return cachedModels;
  const r = await f("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { headers: { "x-goog-api-key": cfg.apiKey as string }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new GeminiError("unavailable", "The AI service is not reachable.");
  const j = (await r.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
  cachedModels = rankModels(j.models ?? []).slice(0, 3);
  if (!cachedModels.length) throw new GeminiError("unavailable", "No AI model is available.");
  return cachedModels;
}

export async function generateJson(cfg: GeminiConfig, req: { system: string; user: string; maxOutputTokens?: number; temperature?: number }): Promise<GeminiResult> {
  if (!cfg.apiKey) throw new GeminiError("config", "The Coach is not set up: GEMINI_API_KEY is missing on the server.");
  const f = cfg.fetch ?? fetch, timeout = cfg.timeoutMs ?? 25_000, max = cfg.maxAttempts ?? 2;
  let attempts = 0, last: GeminiError = new GeminiError("unavailable", "The AI service did not answer.");
  for (const model of await models(cfg, f)) {
    if (!/^[a-z0-9.\-]+$/.test(model)) continue;
    while (attempts < max) {
      attempts += 1;
      let res: Response;
      try {
        res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.apiKey }, signal: AbortSignal.timeout(timeout),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: req.system }] }, contents: [{ role: "user", parts: [{ text: req.user }] }],
            generationConfig: { responseMimeType: "application/json", temperature: req.temperature ?? 0.3, maxOutputTokens: req.maxOutputTokens ?? 2048 },
          }),
        });
      } catch (e) {
        last = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? new GeminiError("timeout", "The Coach took too long to answer.") : new GeminiError("unavailable", "The AI service is not reachable.");
        continue;                                                           // network error or timeout: one more attempt if allowed
      }
      if (res.status === 429) throw new GeminiError("quota", "The AI quota is used up for now. Please try again later.");
      if (res.status === 403 || res.status === 404) { last = new GeminiError("unavailable", "The AI model is not available."); break; }   // try the next model
      if (!res.ok) { last = new GeminiError("unavailable", "The AI service had an error."); continue; }
      const json = await res.json().catch(() => null);
      const text = extractText(json);
      if (!text) { last = new GeminiError("empty", "The Coach returned an empty answer."); continue; }
      const u = (json as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } } | null)?.usageMetadata;
      return { text, usage: { promptTokens: Number(u?.promptTokenCount ?? 0), outputTokens: Number(u?.candidatesTokenCount ?? 0) }, model, attempts };
    }
    if (attempts >= max) break;
  }
  throw last;
}