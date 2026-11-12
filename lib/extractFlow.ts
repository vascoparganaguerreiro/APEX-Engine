// The order of operations of the report-extraction endpoint, with its dependencies injected so it can be tested.
// Order: consent -> configuration -> rate limit -> (only then) read the upload -> validate -> duplicate check -> Gemini.
// Rejected or invalid requests never reach Gemini. Imports only node:crypto.
import { createHash } from "node:crypto";

export const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);

export class ExtractError extends Error {
  status: number;
  extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) { super(message); this.status = status; this.extra = extra; }
}

/** The declared type must match the file's real content (magic bytes). */
export function sniff(b: Buffer): string | null {
  if (b.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export interface FlowDeps {
  geminiConfigured: boolean;
  limit: number;
  consume(): Promise<{ allowed: boolean; retryAfterSeconds: number }>;        // durable limiter, already bound to the verified user
  readForm(): Promise<FormData | null>;
  findDuplicate(sha256: string): Promise<{ id: string; collected_on: string } | null>;
  read(mime: string, bytes: Buffer): Promise<unknown>;                        // the only place that calls Gemini
  parse(raw: unknown): unknown;
  retryText(seconds: number): string;
}

export async function runExtraction(deps: FlowDeps, consentHeader: string | null): Promise<Record<string, unknown>> {
  if (consentHeader !== "yes") throw new ExtractError(400, "Confirm that you agree to send this report for automatic reading.");
  if (!deps.geminiConfigured) throw new ExtractError(503, "Automatic reading isn't available right now. You can still enter results manually.");

  const q = await deps.consume();                                              // before any file processing or AI call
  if (!q.allowed) {
    throw new ExtractError(429, `You have reached the limit of ${deps.limit} report readings per hour. Try again in ${deps.retryText(q.retryAfterSeconds)}, or enter the results manually.`,
      { retryAfterSeconds: q.retryAfterSeconds });
  }

  const form = await deps.readForm();
  const file = form?.get("file");
  if (!(file instanceof Blob)) throw new ExtractError(400, "Attach a PDF or image of the report.");
  if (file.size === 0 || file.size > MAX_BYTES) throw new ExtractError(413, "The file must be between 1 byte and 10 MB.");
  const bytes = Buffer.from(await file.arrayBuffer());
  const mime = sniff(bytes);
  if (!mime || !TYPES.has(mime)) throw new ExtractError(415, "Only PDF, PNG, JPEG or WebP files are supported.");

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const duplicate = await deps.findDuplicate(sha256);
  if (duplicate) return { sha256, duplicate };

  return { sha256, mime, extraction: deps.parse(await deps.read(mime, bytes)) };
}