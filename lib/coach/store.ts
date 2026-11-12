// Data access for the Coach. READS use the signed-in user's own client (RLS applies); WRITES use the privileged server client, with the
// verified user id forced into every row and every ownership check, because users get no insert/update rights on Coach tables
// (so they cannot forge assistant answers or assessment scores). Missing optional tables or columns (pending migrations) never fail the Coach.
import { loadProfile } from "../profile.ts";
import { sanitizeText, type Domain } from "./schema.ts";
import { consumeCoachQuota, type RpcDb } from "./quota.ts";
import type { ActivityRow, DailyRow, RaceLite, ResultRow, SupplementLite } from "./context.ts";
import type { CoachDeps, StoredMessage, UsageRecord } from "./engine.ts";
import { loadHistory, loadLinksOrNone, type Db as StrengthDb } from "../strength/data.ts";
import { loadExcludedActivityIds } from "../strength/dedup.ts";
import { catalogExercise } from "../strength/library.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Db { from(table: string): any }
const ACT = "id,started_at,sport,title,duration_s,distance_m,avg_hr,avg_power_w,load,rpe,note";
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const asActivity = (r: Record<string, unknown>): ActivityRow => ({
  id: Number(r.id), started_at: String(r.started_at), sport: String(r.sport), title: (r.title as string | null) ?? null, duration_s: num(r.duration_s), distance_m: num(r.distance_m),
  avg_hr: num(r.avg_hr), avg_power_w: num(r.avg_power_w), load: num(r.load), rpe: num(r.rpe), note: (r.note as string | null) ?? null,
});

export function createStore(userDb: Db, adminDb: Db, uid: string, limits: { hour: number; day: number }) {
  const ownsConversation = async (id: string): Promise<boolean> => {
    const { data } = await adminDb.from("coach_conversations").select("id").eq("id", id).eq("user_id", uid).maybeSingle();
    return Boolean(data);
  };
  const store: Omit<CoachDeps, "today" | "generate"> = {
    consume: (kind) => consumeCoachQuota(adminDb as unknown as RpcDb, uid, kind, limits.hour, limits.day),
    async recordUsage(usageId: string | null, u: UsageRecord) {
      if (!usageId) return;
      await adminDb.from("coach_usage").update({ tokens_in: u.tokensIn, tokens_out: u.tokensOut, model: u.model, outcome: u.outcome }).eq("id", usageId).eq("user_id", uid);
    },
    async loadProfile() { const p = await loadProfile(userDb, uid); return p.exists ? p.profile : null; },
    async loadActivities(days) {
      const { data, error } = await userDb.from("activities").select(ACT).gte("started_at", isoDaysAgo(days)).order("started_at", { ascending: false }).limit(400);
      if (error) throw new Error("Could not read activities.");
      // An activity the user merged as a duplicate of another activity is not counted twice (no-op before migration 13).
      const dup = loadExcludedActivityIds(await loadLinksOrNone(userDb as unknown as StrengthDb));
      return ((data ?? []) as Record<string, unknown>[]).map(asActivity).filter((a) => !dup.has(a.id));
    },
    async getActivity(id) {
      const { data, error } = await userDb.from("activities").select(ACT).eq("id", id).maybeSingle();       // RLS: another user's activity is simply not visible
      if (error) throw new Error("Could not read the activity.");
      return data ? asActivity(data as Record<string, unknown>) : null;
    },
    async loadDaily(days) {
      const { data, error } = await userDb.from("daily_metrics").select("day,hrv_ms,rhr_bpm,sleep_minutes,sleep_score").gte("day", isoDaysAgo(days).slice(0, 10)).order("day", { ascending: false }).limit(150);
      if (error) throw new Error("Could not read wellness data.");
      return ((data ?? []) as Record<string, unknown>[]).map((r): DailyRow => ({ day: String(r.day), hrv_ms: num(r.hrv_ms), rhr_bpm: num(r.rhr_bpm), sleep_minutes: num(r.sleep_minutes), sleep_score: num(r.sleep_score) }));
    },
    async loadRaces() {
      let r = await userDb.from("races").select("id,name,race_date,sport,distance,distance_unit,target_time_s,priority,goal,status").order("race_date", { ascending: true }).limit(60);
      if (r.error) r = await userDb.from("races").select("id,name,race_date,race_type,priority,goal").order("race_date", { ascending: true }).limit(60);   // Race Hub migration pending
      if (r.error) return [];
      return ((r.data ?? []) as Record<string, unknown>[]).map((x): RaceLite => ({
        id: Number(x.id), name: String(x.name), race_date: String(x.race_date), sport: String(x.sport ?? x.race_type ?? "other"), distance: num(x.distance), distance_unit: (x.distance_unit as string | null) ?? null,
        target_time_s: num(x.target_time_s), priority: String(x.priority ?? "B"), goal: (x.goal as string | null) ?? null, status: String(x.status ?? "planned"),
      }));
    },
    async loadBiomarkers() {
      const { data, error } = await userDb.from("biomarker_results").select("original_name,marker_key,value,unit,ref_low,ref_high,flag,blood_panels(collected_on,lab_name)").order("id", { ascending: true }).limit(600);
      if (error) return [];
      return ((data ?? []) as Array<Record<string, unknown>>).filter((r) => r.blood_panels).map((r): ResultRow => {
        const p = r.blood_panels as { collected_on: string; lab_name: string | null };
        return { original_name: String(r.original_name), marker_key: (r.marker_key as string | null) ?? null, value: Number(r.value), unit: String(r.unit), ref_low: num(r.ref_low), ref_high: num(r.ref_high), flag: (r.flag as string | null) ?? null, collected_on: p.collected_on, lab_name: p.lab_name };
      });
    },
    async loadSupplements() {
      const s = await userDb.from("supplements").select("id,name,start_date,end_date,status").eq("status", "active").limit(40);
      if (s.error) return [];
      const c = await userDb.from("supplement_schedules").select("supplement_id,slot,dose,dose_unit,valid_to").is("valid_to", null);
      const sched = new Map<string, string[]>();
      for (const x of (c.data ?? []) as Array<Record<string, unknown>>) sched.set(String(x.supplement_id), [...(sched.get(String(x.supplement_id)) ?? []), `${x.slot} ${x.dose} ${x.dose_unit}`]);
      return ((s.data ?? []) as Array<Record<string, unknown>>).map((x): SupplementLite => ({ name: String(x.name), start_date: String(x.start_date), end_date: (x.end_date as string | null) ?? null, status: String(x.status), schedule: (sched.get(String(x.id)) ?? []).join(", ") }));
    },
    async loadConversation(id) {
      const { data, error } = await userDb.from("coach_conversations").select("id,domain").eq("id", id).eq("user_id", uid).maybeSingle();
      if (error) throw new Error("Could not read the conversation.");
      return data ? { id: String(data.id), domain: (data.domain === "strength" ? "strength" : "general") as Domain } : null;
    },
    async loadMessages(conversationId, limit) {
      const { data, error } = await userDb.from("coach_chat_messages").select("role,content,meta").eq("conversation_id", conversationId).eq("user_id", uid).order("created_at", { ascending: false }).limit(limit);
      if (error) throw new Error("Could not read the conversation.");
      return ((data ?? []) as Array<Record<string, unknown>>).reverse().map((m): StoredMessage => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content), meta: (m.meta ?? {}) as Record<string, unknown> }));
    },
    async createConversation(title, domain) {
      const { data, error } = await adminDb.from("coach_conversations").insert({ user_id: uid, title: sanitizeText(title, 80) || "New conversation", domain }).select("id").single();
      if (error || !data) throw new Error("Could not create the conversation.");
      return String(data.id);
    },
    async addMessages(conversationId, msgs) {
      if (!(await ownsConversation(conversationId))) throw new Error("Conversation not found.");
      const { error } = await adminDb.from("coach_chat_messages").insert(msgs.map((m) => ({ conversation_id: conversationId, user_id: uid, role: m.role, content: m.content.slice(0, 8000), meta: m.meta })));
      if (error) throw new Error("Could not save the messages.");
      await adminDb.from("coach_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId).eq("user_id", uid);
    },
    async loadStrengthHistory(keys, days) {
      // Read as the user (RLS). Before migration 13 the tables do not exist: the assistant then simply has no history.
      try { return await loadHistory(userDb as unknown as StrengthDb, { keys, sinceIso: isoDaysAgo(days), resolve: catalogExercise }); } catch { return []; }
    },
    async saveAssessment(a) {
      const { data, error } = await adminDb.from("coach_assessments").insert({ user_id: uid, kind: a.kind, mode: a.mode, sport: a.sport, subject: a.subject, result: a.result, score: a.score, confidence: a.confidence, categories_sent: a.categories }).select("id").single();
      if (error || !data) throw new Error("Could not save the assessment.");
      return String(data.id);
    },
  };
  return store;
}