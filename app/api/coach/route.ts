import { authUser, errorResponse } from "@/lib/serverAuth";
import { adminClient } from "@/lib/serverConnections";
import { CoachError, runCoach } from "@/lib/coach/engine";
import { validateRequest } from "@/lib/coach/schema";
import { createStore } from "@/lib/coach/store";
import { COACH_BUDGET_MS, GeminiError, generateJson } from "@/lib/coach/gemini";
import { COACH_DAILY_DEFAULT, COACH_HOURLY_DEFAULT, QuotaUnavailable, limitFrom } from "@/lib/coach/quota";
import { ConsentOwnerMismatch, assertConsentOwner } from "@/lib/consentOwner";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BODY = 64 * 1024;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The user's own calendar date, as sent by their device, accepted only if it is within a day of the server's date (every time zone is). */
function localToday(v: unknown): string {
  const server = isoDay(new Date());
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return server;
  const diff = Math.abs(Date.parse(`${v}T00:00:00Z`) - Date.parse(`${server}T00:00:00Z`)) / 86_400_000;
  return Number.isFinite(diff) && diff <= 1 ? v : server;
}

/** POST /api/coach  { intent: "chat" | "plan" | "session" | "daily", ... } + header X-Coach-Consent: yes (when any data category is selected)
 *  + header X-Consent-User: the account the consent was loaded for (must be the verified user; an account check, not consent).
 *  The user id comes only from the verified session. Conversation history is read from the database, never trusted from the browser. */
export async function POST(req: Request): Promise<Response> {
  const startedAt = Date.now();                                    // one time budget for the whole request (Gemini calls finish before the 60 s route limit)
  try {
    const { sb, uid } = await authUser(req);
    assertConsentOwner(req.headers, uid);       // consent loaded for another account (switched in another tab): 403 before any data or AI
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return Response.json({ error: "That request is too large." }, { status: 413 });
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const today = localToday(body?.today);
    const v = validateRequest(body, today);
    if (!v.ok) return Response.json({ error: v.error }, { status: 400 });

    const hour = limitFrom(process.env.COACH_HOURLY_LIMIT, COACH_HOURLY_DEFAULT, 500), day = limitFrom(process.env.COACH_DAILY_LIMIT, COACH_DAILY_DEFAULT, 5000);
    const store = createStore(sb, adminClient(), uid, { hour, day: Math.max(day, hour) });
    const result = await runCoach({
      today, ...store,
      generate: (system, user) => generateJson({ apiKey: process.env.GEMINI_API_KEY, modelOverride: process.env.GEMINI_MODEL, deadline: startedAt + COACH_BUDGET_MS }, { system, user }),
    }, v.req, req.headers.get("x-coach-consent") === "yes");
    return Response.json(result);
  } catch (e) {
    if (e instanceof ConsentOwnerMismatch) return Response.json({ error: e.message }, { status: 403 });
    if (e instanceof CoachError) {
      const retry = typeof e.extra.retryAfterSeconds === "number" ? Math.max(1, Math.ceil(e.extra.retryAfterSeconds)) : null;
      return Response.json({ error: e.message, ...e.extra }, { status: e.status, headers: retry ? { "Retry-After": String(retry) } : undefined });
    }
    if (e instanceof QuotaUnavailable) {
      console.error("coach: rate limiter unavailable");                      // fail closed: no AI call without a working limiter
      return Response.json({ error: "The Coach is temporarily unavailable. Please try again in a moment." }, { status: 503 });
    }
    if (e instanceof GeminiError) {
      // Per-attempt details (model, attempt, elapsed, category, status) were already logged by lib/coach/gemini.ts. Never log prompts, answers or health data.
      console.error("coach: model error", e.kind, JSON.stringify({ attempts: e.attempts.length, elapsedMs: Date.now() - startedAt }));
      const status = e.kind === "timeout" ? 504 : e.kind === "quota" ? 429 : e.kind === "config" ? 503 : 502;
      return Response.json({ error: e.message }, { status });
    }
    return errorResponse(e, "coach request failed");
  }
}