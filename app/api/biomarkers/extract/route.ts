import { authUser, errorResponse } from "@/lib/serverAuth";
import { adminClient } from "@/lib/serverConnections";
import { extractText, rankModels } from "@/lib/summary";
import { EXTRACTION_PROMPT, parseExtraction } from "@/lib/health/core";
import { ExtractError, runExtraction } from "@/lib/extractFlow";
import { QuotaUnavailableError, consumeExtractionQuota, limitFromEnv, retryText } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 60;

let cachedModels: string[] | null = null;

async function models(key: string): Promise<string[]> {
  if (process.env.GEMINI_MODEL) return [process.env.GEMINI_MODEL];
  if (cachedModels) return cachedModels;
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { headers: { "x-goog-api-key": key } });
  if (!r.ok) throw new ExtractError(502, "The AI service is not reachable.");
  const j = (await r.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
  cachedModels = rankModels(j.models ?? []).slice(0, 3);
  return cachedModels;
}

async function readReport(key: string, mime: string, data: Buffer): Promise<unknown> {
  let last = 502;
  for (const model of await models(key)) {
    if (!/^[a-z0-9.\-]+$/.test(model)) continue;
    let r: Response;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        signal: AbortSignal.timeout(50_000),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: EXTRACTION_PROMPT }, { inline_data: { mime_type: mime, data: data.toString("base64") } }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 },
        }),
      });
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new ExtractError(504, "Reading the report took too long. Try a smaller or clearer file, or enter the results manually.");
      throw new ExtractError(502, "The AI service is not reachable.");
    }
    if (!r.ok) { last = r.status; if ([403, 404, 429].includes(r.status)) continue; break; }
    const text = extractText(await r.json());
    if (!text) throw new ExtractError(502, "The AI could not read this file.");
    try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")); }
    catch { throw new ExtractError(502, "The AI returned an unreadable answer."); }
  }
  throw new ExtractError(last === 429 ? 429 : 502, last === 429 ? "The AI quota is used up for now. Enter the results manually or try later." : "The AI service did not answer.");
}

/** POST multipart "file" + header X-Report-Consent: yes -> { sha256, duplicate?, extraction }.
 *  Nothing is saved here: the user must review and confirm. At most EXTRACT_HOURLY_LIMIT (default 10) per user per rolling hour,
 *  enforced durably in Postgres before the upload is processed or Gemini is called. */
export async function POST(req: Request): Promise<Response> {
  try {
    const { sb, uid } = await authUser(req);                       // identity comes only from the verified token
    const key = process.env.GEMINI_API_KEY;
    const limit = limitFromEnv(process.env.EXTRACT_HOURLY_LIMIT);
    const body = await runExtraction({
      geminiConfigured: Boolean(key),
      limit,
      consume: () => consumeExtractionQuota(adminClient(), uid, limit),
      readForm: () => req.formData().catch(() => null),
      findDuplicate: async (sha) => {
        const { data } = await sb.from("blood_panels").select("id,collected_on").eq("report_sha256", sha).maybeSingle();
        return data ? { id: data.id as string, collected_on: data.collected_on as string } : null;
      },
      read: (mime, bytes) => readReport(key as string, mime, bytes),
      parse: (raw) => parseExtraction(raw, new Date().toISOString().slice(0, 10)),
      retryText,
    }, req.headers.get("x-report-consent"));
    return Response.json(body);
  } catch (e) {
    if (e instanceof ExtractError) {
      const retry = typeof e.extra.retryAfterSeconds === "number" ? Math.max(1, Math.ceil(e.extra.retryAfterSeconds)) : null;
      return Response.json({ error: e.message, ...e.extra }, { status: e.status, headers: retry ? { "Retry-After": String(retry) } : undefined });
    }
    if (e instanceof QuotaUnavailableError) {
      console.error("report extraction: rate limiter unavailable");   // fail closed: no Gemini call without a working limiter
      return Response.json({ error: "Report reading is temporarily unavailable. You can enter the results manually." }, { status: 503 });
    }
    return errorResponse(e, "report extraction failed");
  }
}
