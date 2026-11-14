// Pure logic for original lab report files in the private "lab-reports" bucket. No imports (unit-testable).
// Objects are stored as "<user id>/<sha256 of the bytes>.<ext>", so the same file always has the same name.

export const REPORT_EXT: Readonly<Record<string, string>> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
export const REPORT_MAX_BYTES = 10 * 1024 * 1024;

const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;

/** "<uid>/<sha256>.<ext>" for a supported type, or null if any part is malformed. */
export function reportPath(uid: string, sha256: string, mime: string): string | null {
  const ext = Object.prototype.hasOwnProperty.call(REPORT_EXT, mime) ? REPORT_EXT[mime] : undefined;
  if (!ext || !UID.test(uid) || !SHA.test(sha256)) return null;
  return `${uid}/${sha256}.${ext}`;
}

/** Accept exactly "<uid>/<64 lowercase hex>.<pdf|png|jpg|webp>" for the given (verified) user; anything else is null. */
export function parseReportPath(path: unknown, uid: string): { sha256: string; ext: string } | null {
  if (typeof path !== "string" || path.length > 120 || !UID.test(uid)) return null;
  const m = /^([0-9a-f-]{36})\/([0-9a-f]{64})\.(pdf|png|jpg|webp)$/.exec(path);
  if (!m || m[1] !== uid) return null;
  return { sha256: m[2], ext: m[3] };
}

/** How an upload with upsert disabled ended: "already exists" means the object was there before (keep its owner's copy). */
export function uploadOutcome(error: { message?: string; statusCode?: string | number } | null | undefined): "created" | "existed" | "failed" {
  if (!error) return "created";
  if (String(error.statusCode ?? "") === "409" || /already exists|duplicate/i.test(error.message ?? "")) return "existed";
  return "failed";
}

/** A storage error that means "no such object (for this user)". With row-level security, another user's object looks the same. */
export function isMissingObject(error: { message?: string; status?: number; statusCode?: string | number; code?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.status === 404 || String(error.statusCode ?? "") === "404" || error.code === "NoSuchKey" || error.code === "not_found" || /not.?found/i.test(error.message ?? "");
}

/**
 * Which uploads may be deleted. Only objects this page created itself (never ones that already existed),
 * minus those still wanted (`keep`, e.g. the file currently selected) and those a saved blood test references.
 * Pass `referenced: null` when that lookup failed: then nothing is deleted (an orphan is better than a lost report).
 */
export function removableUploads(created: Iterable<string>, keep: ReadonlyArray<string | null | undefined>, referenced: ReadonlyArray<string | null> | null): string[] {
  if (referenced === null) return [];
  const hold = new Set<string>([...keep, ...referenced].filter((x): x is string => typeof x === "string"));
  return [...new Set(created)].filter((p) => !hold.has(p));
}
