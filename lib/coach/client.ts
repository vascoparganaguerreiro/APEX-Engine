// Browser-side reads and deletes for the Coach UI. Runs as the signed-in user: RLS limits every query to their own rows.
// There is no insert/update here on purpose: conversations, answers and assessments are written only by the server.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Db { from(table: string): any }
export interface ConversationRow { id: string; title: string; domain: string; updated_at: string }
export interface MessageRow { id: string; role: "user" | "assistant"; content: string; meta: Record<string, unknown>; created_at: string }
export interface AssessmentRow { id: string; kind: "session" | "daily"; mode: string | null; sport: string | null; score: number | null; confidence: string; result: Record<string, unknown>; created_at: string }
const fail = (e: { message?: string } | null | undefined): never => { throw new Error(e?.message ?? "Request failed"); };

export async function listConversations(db: Db, domain = "general"): Promise<ConversationRow[]> {
  const { data, error } = await db.from("coach_conversations").select("id,title,domain,updated_at").eq("domain", domain).order("updated_at", { ascending: false }).limit(30);
  if (error) fail(error);
  return (data ?? []) as ConversationRow[];
}
export async function listMessages(db: Db, conversationId: string): Promise<MessageRow[]> {
  const { data, error } = await db.from("coach_chat_messages").select("id,role,content,meta,created_at").eq("conversation_id", conversationId).order("created_at", { ascending: true }).limit(200);
  if (error) fail(error);
  return (data ?? []) as MessageRow[];
}
export async function listAssessments(db: Db, limit = 12): Promise<AssessmentRow[]> {
  const { data, error } = await db.from("coach_assessments").select("id,kind,mode,sport,score,confidence,result,created_at").order("created_at", { ascending: false }).limit(limit);
  if (error) fail(error);
  return (data ?? []) as AssessmentRow[];
}
/** Deletes a conversation (its messages go with it). Another user's conversation matches no row, which is reported as not found. */
export async function deleteConversation(db: Db, id: string): Promise<void> {
  const { data, error } = await db.from("coach_conversations").delete().eq("id", id).select("id");
  if (error) fail(error);
  if (!data || data.length === 0) throw new Error("Conversation not found.");
}
export async function deleteAssessment(db: Db, id: string): Promise<void> {
  const { data, error } = await db.from("coach_assessments").delete().eq("id", id).select("id");
  if (error) fail(error);
  if (!data || data.length === 0) throw new Error("Assessment not found.");
}