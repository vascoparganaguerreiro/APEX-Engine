import { authUser } from "@/lib/serverAuth";
import { adminClient } from "@/lib/serverConnections";
import { loadLinksOrNone, type Db as StrengthDb } from "@/lib/strength/data";
import { loadExcludedActivityIds } from "@/lib/strength/dedup";
import { SUMMARY_SYSTEM } from "@/lib/summary";
import { COACH_BUDGET_MS, GeminiError, generateText } from "@/lib/coach/gemini";
import { COACH_DAILY_DEFAULT, COACH_HOURLY_DEFAULT, QuotaUnavailable, consumeCoachQuota, limitFrom } from "@/lib/coach/quota";
import { SummaryError, runSummary, summaryConsent, type Row, type SummaryDeps } from "@/lib/summaryService";
import { nextUpcomingRaceStrict, type Db as RaceDb } from "@/lib/races";
import { ConsentOwnerMismatch, assertConsentOwner } from "@/lib/consentOwner";

export const runtime = "nodejs";
export const maxDuration = 60;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const COLS = "id,started_at,sport,title,duration_s,distance_m,avg_hr,load,note";

// Gemini: the shared caller (lib/coach/gemini.ts) with the same time budget, per-model timeout, model fallback and safe diagnostics as the
// Coach. One quota unit per request (taken in runSummary before this is called).
const askGemini = (startedAt: number) => async (prompt: string): Promise<{ text: string; model: string }> => {
  const r = await generateText({ apiKey: process.env.GEMINI_API_KEY, modelOverride: process.env.GEMINI_MODEL, deadline: startedAt + COACH_BUDGET_MS }, { system: SUMMARY_SYSTEM, user: prompt });
  return { text: r.text, model: r.model };
};

// ------------------------------------------------------------------ handler
/** POST { kind: "activity", id } | { kind: "week", weekStart }, plus the Coach consent: body.categories + header X-Coach-Consent: yes,
 *  and X-Consent-User: the account that consent was loaded for (must be the verified user; an account check, not consent).
 *  Identity comes only from the verified token. Data the user did not consent to is never read or sent (lib/summaryService.ts). */
export async function POST(req: Request) {
  const startedAt = Date.now();                                    // one time budget for the whole request, inside the 60 s route limit
  try {
    const { sb, uid } = await authUser(req);
    assertConsentOwner(req.headers, uid);       // consent loaded for another account (switched in another tab): 403 before any data or AI
    const body = (await req.json().catch(() => null)) as { kind?: string; id?: number; weekStart?: string; categories?: unknown } | null;
    const consent = summaryConsent(body?.categories, req.headers.get("x-coach-consent"));
    let r: Parameters<typeof runSummary>[1];
    if (body?.kind === "activity" && Number.isInteger(body.id)) r = { kind: "activity", id: body.id as number };
    else if (body?.kind === "week" && typeof body.weekStart === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.weekStart)) r = { kind: "week", weekStart: body.weekStart };
    else throw new HttpError(400, "Bad request.");

    const admin = adminClient();
    const hour = limitFrom(process.env.COACH_HOURLY_LIMIT, COACH_HOURLY_DEFAULT, 500), day = limitFrom(process.env.COACH_DAILY_LIMIT, COACH_DAILY_DEFAULT, 5000);
    const deps: SummaryDeps = {
      async timezone() { const { data } = await sb.from("profiles").select("timezone").eq("id", uid).maybeSingle(); return data?.timezone ?? "UTC"; },
      async getActivity(id) { const { data } = await sb.from("activities").select(COLS).eq("id", id).maybeSingle(); return (data as Row | null) ?? null; },
      async activities(from, to) {
        const [rows, links] = await Promise.all([
          sb.from("activities").select(COLS).gte("started_at", `${from}T00:00:00Z`).lte("started_at", `${to}T23:59:59Z`).order("started_at"),
          loadLinksOrNone(sb as unknown as StrengthDb),
        ]);
        const dup = loadExcludedActivityIds(links);                   // a merged copy of the same session is counted once
        return ((rows.data ?? []) as Row[]).filter((x) => !dup.has(Number(x.id)));
      },
      async dailyOn(d) {
        const m = await sb.from("daily_metrics").select("hrv_ms,rhr_bpm,sleep_minutes,sleep_score").eq("day", d).maybeSingle();
        return m.data ? { hrv: m.data.hrv_ms, rhr: m.data.rhr_bpm, sleepH: m.data.sleep_minutes ? m.data.sleep_minutes / 60 : null, sleepScore: m.data.sleep_score } : null;
      },
      async dailyAvg(from, to) {
        const { data } = await sb.from("daily_metrics").select("hrv_ms,rhr_bpm,sleep_minutes").gte("day", from).lte("day", to);
        const d = data ?? [], mean = (xs: Array<number | null>) => { const v = xs.filter((x): x is number => x !== null && x !== undefined).map(Number); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
        return { hrv: mean(d.map((x) => x.hrv_ms)), rhr: mean(d.map((x) => x.rhr_bpm)), sleepH: mean(d.map((x) => (x.sleep_minutes ? x.sleep_minutes / 60 : null))) };
      },
      // Same upcoming-race rule as the Races page and Today (planned/registered only), with the pre-migration-10 fallback.
      async nextRace(today) { const x = await nextUpcomingRaceStrict(sb as unknown as RaceDb, today); return x ? { name: x.name, race_date: x.race_date } : null; },
      // Durable Coach limiter (12_coach.sql): per-user advisory lock, server clock, counted before the model call.
      consume: (kind) => consumeCoachQuota(admin, uid, kind, hour, Math.max(day, hour)),
      async recordOutcome(usageId, outcome, model) { if (usageId) await admin.from("coach_usage").update({ outcome, model }).eq("id", usageId).eq("user_id", uid); },
      ask: askGemini(startedAt),
      async saveActivitySummary(id, text) {
        const { error } = await sb.from("activities").update({ ai_summary: text, ai_summary_at: new Date().toISOString() }).eq("id", id);
        if (error) throw new HttpError(500, "Could not save the summary.");
      },
      async saveWeekSummary(ws, text) {
        const { error } = await sb.from("weekly_summaries").upsert({ user_id: uid, week_start: ws, summary: text, created_at: new Date().toISOString() }, { onConflict: "user_id,week_start" });
        if (error) throw new HttpError(500, "Could not save the summary.");
      },
      now: () => new Date(),
    };
    return Response.json(await runSummary(deps, r, consent));
  } catch (e) {
    if (e instanceof ConsentOwnerMismatch) return Response.json({ error: e.message }, { status: 403 });
    if (e instanceof SummaryError) {
      const retry = typeof e.extra.retryAfterSeconds === "number" ? String(e.extra.retryAfterSeconds) : null;
      return Response.json({ error: e.message, ...e.extra }, { status: e.status, headers: retry ? { "Retry-After": retry } : undefined });
    }
    if (e instanceof QuotaUnavailable) {
      console.error("summaries: rate limiter unavailable");          // fail closed: no AI call without a working limiter
      return Response.json({ error: "AI summaries are temporarily unavailable (the usage limiter is not set up yet)." }, { status: 503 });
    }
    if (e instanceof GeminiError) {
      console.error("summaries: model error", e.kind, JSON.stringify({ attempts: e.attempts.length, elapsedMs: Date.now() - startedAt }));   // per-attempt details were logged by the caller; never prompts or answers
      const status = e.kind === "timeout" ? 504 : e.kind === "quota" ? 429 : e.kind === "config" ? 503 : 502;
      return Response.json({ error: e.message }, { status });
    }
    if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
    const s = (e as { status?: unknown })?.status;
    if (typeof s === "number" && s === 401) return Response.json({ error: "Please sign in again." }, { status: 401 });
    console.error("summaries failed", e instanceof Error ? e.name : "unknown");
    return Response.json({ error: "Something went wrong." }, { status: 500 });
  }
}
