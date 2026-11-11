import { createHash } from "node:crypto";
import { authUser, errorResponse } from "@/lib/serverAuth";
import { extractText, rankModels } from "@/lib/summary";
import { EXTRACTION_PROMPT, parseExtraction } from "@/lib/health/core";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
class ExtractError extends Error { constructor(public status: number, message: string) { super(message); } }
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

/** POST multipart "file" -> { sha256, duplicate?, extraction }. Nothing is saved here: the user must review and confirm. */
export async function POST(req: Request): Promise<Response> {
  try {
    const { sb } = await authUser(req);
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new ExtractError(503, "Automatic reading is not set up (GEMINI_API_KEY is missing on the server). You can still enter results manually.");

    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof Blob)) throw new ExtractError(400, "Attach a PDF or image of the report.");
    if (file.size === 0 || file.size > MAX_BYTES) throw new ExtractError(413, "The file must be between 1 byte and 10 MB.");
    const bytes = Buffer.from(await file.arrayBuffer());
    const mime = sniff(bytes);
    if (!mime || !TYPES.has(mime)) throw new ExtractError(415, "Only PDF, PNG, JPEG or WebP files are supported.");

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const { data: dup } = await sb.from("blood_panels").select("id,collected_on").eq("report_sha256", sha256).maybeSingle();
    if (dup) return Response.json({ sha256, duplicate: { id: dup.id, collected_on: dup.collected_on } });

    const extraction = parseExtraction(await readReport(key, mime, bytes), new Date().toISOString().slice(0, 10));
    return Response.json({ sha256, mime, extraction });
  } catch (e) {
    if (e instanceof ExtractError) return Response.json({ error: e.message }, { status: e.status });
    return errorResponse(e, "report extraction failed");
  }
}
