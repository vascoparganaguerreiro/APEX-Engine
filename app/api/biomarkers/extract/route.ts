import { createHash } from "node:crypto";
import { authUser, errorResponse } from "@/lib/serverAuth";
import { extractText, rankModels } from "@/lib/summary";
import { EXTRACTION_PROMPT, parseExtraction } from "@/lib/health/core";
import { REPORT_MAX_BYTES, isMissingObject, parseReportPath, refundsReading, type ReadingOutcome } from "@/lib/health/report";
import { AiLimitError, AiUsageError, consumeAiUsage, releaseAiUsage } from "@/lib/serverAiUsage";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BYTES = REPORT_MAX_BYTES;
const TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
/** `outcome` is set for failures of the paid AI reading; it decides whether the daily allowance unit is given back. */
class ExtractError extends Error { constructor(public status: number, message: string, public outcome?: ReadingOutcome) { super(message); } }
const COUNTED = " This attempt counts toward your daily limit.";
let cachedModels: string[] | null = null;

/** The declared type must match the file's real content (magic bytes). */
function sniff(b: Buffer): string | null {
  if (b.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

async function models(key: string): Promise<string[]> {
  if (process.env.GEMINI_MODEL) return [process.env.GEMINI_MODEL];
  if (cachedModels) return cachedModels;
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { headers: { "x-goog-api-key": key } });
  if (!r.ok) throw new ExtractError(502, "The AI service is not reachable.", "no_answer");
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
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new ExtractError(504, "Reading the report took too long. Try a smaller or clearer file, or enter the results manually." + COUNTED, "timeout");
      throw new ExtractError(502, "The AI service is not reachable.", "no_answer");
    }
    if (!r.ok) { last = r.status; if ([403, 404, 429].includes(r.status)) continue; break; }
    const text = extractText(await r.json().catch(() => null));
    if (!text) throw new ExtractError(502, "The AI could not read this file. Enter the results manually." + COUNTED, "answered");
    try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")); }
    catch { throw new ExtractError(502, "The AI returned an unreadable answer. Enter the results manually." + COUNTED, "answered"); }
  }
  throw new ExtractError(last === 429 ? 429 : 502, last === 429 ? "The AI quota is used up for now. Enter the results manually or try later." : "The AI service did not answer.", "no_answer");
}

/**
 * POST JSON { path: "<uid>/<sha256>.<ext>" } -> { sha256, duplicate? } or { sha256, mime, extraction }.
 * The browser uploads the report to the private "lab-reports" bucket first (Vercel limits function request bodies
 * to ~4.5 MB, below our 10 MB file limit); the file is read back here with the caller's own Supabase client, so the
 * storage policies (own folder only) apply. Nothing is saved here: the user must review and confirm.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const { sb, uid } = await authUser(req);
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new ExtractError(503, "Automatic reading is not set up (GEMINI_API_KEY is missing on the server). You can still enter results manually.");

    const body = (await req.json().catch(() => null)) as { path?: unknown } | null;
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.path !== "string") throw new ExtractError(400, "Upload the report first, then send its storage path.");
    const path = body.path;
    const named = parseReportPath(path, uid);
    if (!named) throw new ExtractError(400, "The report path is not valid.");

    const { data: blob, error: dlError } = await sb.storage.from("lab-reports").download(path);
    if (dlError || !blob) {
      if (!dlError || isMissingObject(dlError as { message?: string; status?: number; statusCode?: string; code?: string })) throw new ExtractError(404, "The uploaded report was not found. Choose the file again.");
      throw new ExtractError(502, "The uploaded report could not be read from storage. Try again.");
    }
    if (blob.size === 0 || blob.size > MAX_BYTES) throw new ExtractError(413, "The file must be between 1 byte and 10 MB.");
    const bytes = Buffer.from(await blob.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new ExtractError(413, "The file must be between 1 byte and 10 MB.");
    const mime = sniff(bytes);
    if (!mime || !TYPES.has(mime)) throw new ExtractError(415, "Only PDF, PNG, JPEG or WebP files are supported.");

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== named.sha256) throw new ExtractError(400, "The uploaded file does not match its name. Choose the file again.");
    const { data: dup } = await sb.from("blood_panels").select("id,collected_on").eq("report_sha256", sha256).maybeSingle();
    if (dup) return Response.json({ sha256, duplicate: { id: dup.id, collected_on: dup.collected_on } });

    // Everything above is free and rejects bad requests; only from here on is the (paid) AI service called.
    // One "report_extract" unit per reading. It is given back only when the AI service did no work (see
    // refundsReading): a timeout or an empty/unparseable answer was still paid for and depends on the file,
    // so refunding it would let the same file be sent again and again at no cost to the user.
    const handle = await consumeAiUsage(uid, "report_extract");
    let raw: unknown;
    try { raw = await readReport(key, mime, bytes); }
    catch (e) {
      if (refundsReading(e instanceof ExtractError ? e.outcome : undefined)) await releaseAiUsage(handle);   // best effort, never throws
      throw e;
    }
    // An answer with no usable values (all skipped, or none found) is a completed, paid reading: not refunded.
    const extraction = parseExtraction(raw, new Date().toISOString().slice(0, 10));
    return Response.json({ sha256, mime, extraction });
  } catch (e) {
    if (e instanceof ExtractError) return Response.json({ error: e.message }, { status: e.status });
    if (e instanceof AiLimitError) return Response.json({ error: `${e.message} You can still enter the results manually and save the blood test with this report attached.` }, { status: e.status });
    if (e instanceof AiUsageError) return Response.json({ error: e.message }, { status: e.status });
    return errorResponse(e, "report extraction failed");
  }
}
