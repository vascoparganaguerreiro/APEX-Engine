// One place that turns "something failed" into a message that is safe to show a person, and keeps the technical detail out of the screen.
//
//  - Raw database / network / server text (SQL fragments, table and column names, error codes, stack traces) is NEVER shown.
//  - Environment-variable names, internal file paths, migration numbers and developer wording are never shown either.
//  - "Not set up" is never inferred here. A caller that has CONFIRMED a specific missing table or column (for example isMissingRaceHubColumn)
//    passes { notSetUp: true }; every other failure is a normal error with a category and, where it helps, a retry.
//  - Technical diagnostics go to the log only: code, status and error name in the browser; also a scrubbed message on the server.
//
// Pure: no window, no Supabase, no React.

export type UserErrorKind = "network" | "auth" | "permission" | "not-set-up" | "other";
export interface UserError { kind: UserErrorKind; message: string; retryable: boolean }
export interface FriendlyOptions { notSetUp?: boolean; scope?: string }

export const NOT_SET_UP_MESSAGE = "This feature isn't set up on your account yet. Ask the person who runs APEX.";
export const SERVICE_UNAVAILABLE_MESSAGE = "This service isn't available right now. Please try again later.";
export const AI_UNAVAILABLE_MESSAGE = "The AI assistant isn't available right now. Please try again in a moment.";

/** An error whose message was written for people (already safe). Shown as-is by friendlyError. */
export class SafeError extends Error {
  kind: UserErrorKind; retryable: boolean;
  constructor(kind: UserErrorKind, message: string, retryable = true) { super(message); this.name = "SafeError"; this.kind = kind; this.retryable = retryable; }
}

interface Shape { code: string; message: string; status: number | undefined; name: string; dbShaped: boolean }
function shapeOf(e: unknown): Shape {
  const o = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const name = str(o.name);
  const code = str(o.code);
  return {
    code, name,
    message: typeof e === "string" ? e : str(o.message),
    status: num(o.status) ?? num(o.statusCode),
    // Postgres / PostgREST / Supabase errors carry a code, details or hint: their text is never for people.
    dbShaped: code !== "" || "details" in o || "hint" in o || /^(Postgrest|Storage|Auth)/.test(name),
  };
}

/** Does this text look like something a developer wrote (SQL, a code, a key or env name, a path, a migration, a stack trace)? */
export function looksTechnical(text: string): boolean {
  if (!text) return false;
  return [
    /\bmigrations?\b/i, /\.sql\b/i, /\.(?:ts|tsx|js|mjs|cjs|json|md|env)\b/i, /\bdocs\//i, /[A-Za-z]:\\|\\\\|(?:^|\s)\/(?:app|lib|docs|components|node_modules|var|usr|home)\//,
    /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/,                                         // ENV_VARIABLE_NAMES
    /\b(?:select|insert|update|delete|alter|create|drop)\b[^.\n]{0,60}\b(?:from|into|set|table|column|constraint)\b/i,
    /\brelation\b|does not exist|schema cache|violates|constraint|duplicate key|syntax error|\bsqlstate\b|\bpostgres|\bpostgrest|\bpgrst\d|\bpg_|row-level security|\brls\b/i,
    /\bcolumn\b|\btable\b.*\bpublic\b|\bpublic\.[a-z_]+/i,
    /\b(?:42|23|57|53|08|22|25|28|40)[0-9]{3}\b/,                                // Postgres error codes
    /\bjwt\b|\bbearer\b|api[_ -]?key|service[_ -]?role|\bsecret\b|\btoken\b|\bapikey\b|\bsupabase\b|\bvercel\b|process\.env|\.env\b/i,
    /\b(?:TypeError|ReferenceError|SyntaxError|RangeError)\b|cannot read propert|undefined is not|is not a function|\n\s+at\s|\bat\s+\S+\s+\(.*:\d+:\d+\)/i,
    /<\/?[a-z][^>]*>|\{\s*"|stack/i,                                              // HTML / JSON dumps
  ].some((re) => re.test(text));
}

const NETWORK_TEXT = /fetch failed|failed to fetch|networkerror|network request failed|load failed|network error|ECONN|ENOTFOUND|ETIMEDOUT|socket hang up/i;
const AUTH_TEXT = /\bjwt\b|not authenticated|auth session missing|session (?:has )?(?:expired|not found)|refresh_token|invalid refresh token|invalid claim/i;
const PERMISSION_TEXT = /permission denied|row-level security/i;

/** The category only. Never inspects anything for "migration" and never returns not-set-up. */
export function classifyKind(e: unknown): Exclude<UserErrorKind, "not-set-up"> {
  const s = shapeOf(e);
  const t = `${s.code} ${s.message}`;
  if (s.status === 0 || NETWORK_TEXT.test(t) || s.name === "TimeoutError" || s.name === "AbortError" || (s.name === "TypeError" && s.message === "")) return "network";
  if (s.status === 401 || /^PGRST30[0-3]$/.test(s.code) || AUTH_TEXT.test(t)) return "auth";
  if (s.status === 403 || s.code === "42501" || PERMISSION_TEXT.test(t)) return "permission";
  return "other";
}

/** `what` is the start of the sentence the person reads, for example "Your races could not be loaded" (no final full stop). */
export function friendlyError(e: unknown, what = "Something went wrong", opts: FriendlyOptions = {}): UserError {
  if (opts.scope) logTechnical(opts.scope, e);
  if (e instanceof SafeError) return { kind: e.kind, message: e.message, retryable: e.retryable };
  if (opts.notSetUp) return { kind: "not-set-up", message: NOT_SET_UP_MESSAGE, retryable: false };
  const kind = classifyKind(e);
  if (kind === "network") return { kind, message: `${what}: the connection failed. Check your internet connection and try again.`, retryable: true };
  if (kind === "auth") return { kind, message: `${what}: your session has expired. Sign in again, then try again.`, retryable: false };
  if (kind === "permission") return { kind, message: `${what}: this account is not allowed to do that. Nothing was changed.`, retryable: false };
  const s = shapeOf(e);
  if (s.status === 429) return { kind: "other", message: `${what}: too many requests right now. Wait a moment and try again.`, retryable: true };
  // A plain message written by the app itself (for example "Choose a date") may pass; database-shaped errors and anything technical never do.
  if (e instanceof Error && !s.dbShaped && s.message.length > 0 && s.message.length <= 240 && !looksTechnical(s.message)) return { kind: "other", message: s.message, retryable: true };
  return { kind: "other", message: `${what}. Please try again in a moment.`, retryable: true };
}
export const friendlyMessage = (e: unknown, what?: string, opts?: FriendlyOptions): string => friendlyError(e, what, opts).message;

/** Text that was stored earlier (for example a sync's last error) and is now shown: kept when it is plain, replaced when it looks technical. */
export function safeText(text: string | null | undefined, fallback: string): string {
  const t = (text ?? "").trim();
  return t && t.length <= 240 && !looksTechnical(t) ? t : fallback;
}

/** A failed call to one of our own API routes. The route's message is shown only when it is plain, human text (checked again here, so a
 *  careless server message can never leak something technical); otherwise the generic, categorised message is used. */
export function apiError(status: number, body: unknown, what = "That request could not be completed"): SafeError {
  const raw = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error.trim() : "";
  if (raw && raw.length <= 240 && status !== 401 && !looksTechnical(raw)) return new SafeError(status === 403 ? "permission" : "other", raw, status !== 403);
  const u = friendlyError(Object.assign(new Error(raw), { status }), what, { scope: `api.${status}` });
  return new SafeError(u.kind, u.message, u.retryable);
}

/** Long token-like strings (keys, JWTs) and anything after "Bearer" are removed; the rest is cut short. */
export function scrubForLog(text: string): string {
  return text.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]").replace(/[A-Za-z0-9_\-.]{24,}/g, "[redacted]").replace(/\s+/g, " ").slice(0, 300);
}
/** Technical diagnostics. In the browser only the error name, code and status are written (nothing a person could mistake for advice, nothing
 *  sensitive). On the server a scrubbed message is added too, because server logs are not shown to users. Never throws. */
export function logTechnical(scope: string, e: unknown): void {
  try {
    const s = shapeOf(e);
    const entry: Record<string, unknown> = { scope: scope.slice(0, 60) };
    if (s.name) entry.name = s.name.slice(0, 40);
    if (/^[A-Za-z0-9_]{1,12}$/.test(s.code)) entry.code = s.code;
    if (s.status !== undefined) entry.status = s.status;
    if (typeof window === "undefined" && s.message) entry.message = scrubForLog(s.message);
    console.error("[apex]", entry);
  } catch { /* logging must never break the page */ }
}
