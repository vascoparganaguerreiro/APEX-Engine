// Server-only Gemini plumbing shared by the AI routes (/api/summarize and /api/biomarkers/extract).
// The API key is passed in by the route; nothing here reads the environment or logs request contents.
import { rankModels } from "@/lib/summary";

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

/** Model names are put into a URL path, so only plain names are accepted. */
export const isModelName = (model: string) => /^[a-z0-9.\-]+$/.test(model);
export const generateUrl = (model: string) => `${GEMINI_API}/models/${model}:generateContent`;
export const geminiHeaders = (key: string) => ({ "Content-Type": "application/json", "x-goog-api-key": key });

/** The model list could not be read. `status` is Gemini's HTTP status, or 502 when it could not be reached. */
export class GeminiListError extends Error {
  status: number;
  constructor(status: number) { super(`model list ${status}`); this.name = "GeminiListError"; this.status = status; }
}

/** Text models this key can use, best first (see rankModels). Throws GeminiListError. */
export async function listRankedModels(key: string): Promise<string[]> {
  let r: Response;
  try { r = await fetch(`${GEMINI_API}/models?pageSize=1000`, { headers: { "x-goog-api-key": key } }); }
  catch { throw new GeminiListError(502); }
  if (!r.ok) throw new GeminiListError(r.status);
  const j = (await r.json().catch(() => null)) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> } | null;
  return rankModels(j?.models ?? []);
}
