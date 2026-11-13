"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { coachRequest } from "@/lib/api";
import { deleteConversation, listConversations, listMessages, type ConversationRow, type MessageRow } from "@/lib/coach/client";
import { CATEGORY_INFO, type Category } from "@/lib/coach/schema";

interface Msg { id: string; role: "user" | "assistant"; content: string; meta?: Record<string, unknown>; failed?: boolean }
import { friendlyMessage } from "@/lib/userError";
const errMsg = (e: unknown) => friendlyMessage(e, "The Coach could not answer", { scope: "coach.chat" });

export default function ChatPanel({ intent, suggestions, authorized, consentUser, raceId = null, placeholder }: { intent: "chat" | "plan"; suggestions: string[]; authorized: Category[]; consentUser: string | null; raceId?: number | null; placeholder?: string }) {
  const [convs, setConvs] = useState<ConversationRow[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(async () => { try { setConvs(await listConversations(getSupabase())); } catch { /* history is optional */ } }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  // The composer is pinned to the bottom on phones. Its height is published as --composer-h so the global quick-actions button floats above it
  // instead of covering the Send button.
  useEffect(() => {
    const el = composer.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const set = () => {
      document.documentElement.style.setProperty("--composer-h", `${el.offsetHeight}px`);
      if (document.activeElement === field.current) end.current?.scrollIntoView({ block: "end" });   // the field grew: the latest message stays visible above it
    };
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => { ro.disconnect(); document.documentElement.style.removeProperty("--composer-h"); };
  }, []);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [msgs, busy]);
  // The message field grows with what is typed (the CSS caps its height, after which it scrolls), and shrinks back after sending.
  useEffect(() => { const el = field.current; if (!el) return; el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; }, [input]);

  async function open(id: string) {
    setActive(id); setError(null);
    try { setMsgs((await listMessages(getSupabase(), id)).map((m: MessageRow) => ({ id: m.id, role: m.role, content: m.content, meta: m.meta }))); } catch (e) { setError(errMsg(e)); }
  }
  function fresh() { setActive(null); setMsgs([]); setError(null); }
  async function remove(id: string) {
    if (!window.confirm("Delete this conversation? This cannot be undone.")) return;
    try { await deleteConversation(getSupabase(), id); if (active === id) fresh(); await refresh(); } catch (e) { setError(errMsg(e)); }
  }

  async function send(text: string, retryId?: string) {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true); setError(null); setInput("");
    const uid = retryId ?? `u${Date.now()}`;
    setMsgs((m) => (retryId ? m.map((x) => (x.id === retryId ? { ...x, failed: false } : x)) : [...m, { id: uid, role: "user", content: message }]));
    try {
      const r = await coachRequest({ intent, message, conversationId: active, domain: "general", raceId }, authorized, consentUser);
      if (r.kind !== "chat") throw new Error("Unexpected answer from the Coach.");
      setMsgs((m) => [...m, { id: `a${Date.now()}`, role: "assistant", content: r.answer, meta: r.meta as unknown as Record<string, unknown> }]);
      if (r.conversationId && r.conversationId !== active) setActive(r.conversationId);
      void refresh();
    } catch (e) {
      setMsgs((m) => m.map((x) => (x.id === uid ? { ...x, failed: true } : x)));
      setError(errMsg(e));
    } finally { setBusy(false); }
  }

  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  return (
    <div className="chatwrap">
      <aside className="convs">
        <button type="button" className="btn ghost" style={{ width: "100%" }} onClick={fresh}>+ New conversation</button>
        {convs.length === 0 && <p className="muted small">No earlier conversations.</p>}
        {convs.map((c) => (
          <div key={c.id} className={c.id === active ? "convrow on" : "convrow"}>
            <button type="button" className="convbtn" onClick={() => void open(c.id)}>{c.title}</button>
            <button type="button" className="chip" aria-label={`Delete conversation ${c.title}`} onClick={() => void remove(c.id)}>Delete</button>
          </div>
        ))}
      </aside>
      <div className="chat">
        <div className="chatlog" aria-live="polite">
          {msgs.length === 0 && (
            <div className="muted small">
              <p style={{ marginTop: 0 }}>Ask in your own words. The Coach only uses the data you have chosen to share and says when something is missing.</p>
              <div className="row sug-inline">{suggestions.map((s) => <button key={s} type="button" className="chip" onClick={() => void send(s)}>{s}</button>)}</div>
            </div>
          )}
          {msgs.map((m) => (
            <div key={m.id} className={`bubble ${m.role}`}>
              {m.role === "assistant" && <small className="tag ai">APEX Coach · AI-generated</small>}
              <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
              {m.failed && <button type="button" className="linkbtn" onClick={() => void send(m.content, m.id)}>Not sent. Retry</button>}
              {m.role === "assistant" && m.meta && (() => {
                const cats = (m.meta.categories_sent as string[] | undefined) ?? [], conf = m.meta.confidence as string | undefined, fu = (m.meta.follow_ups as string[] | undefined) ?? [], ni = (m.meta.needs_info as string[] | undefined) ?? [];
                return (
                  <div className="muted small" style={{ marginTop: 8 }}>
                    {m.meta.safety ? null : <>Confidence: {conf ?? "n/a"}. </>}{cats.length ? `Used: ${cats.map((c) => CATEGORY_INFO[c as Category]?.label ?? c).join(", ")}.` : "No personal data used."}
                    {ni.length > 0 && <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{ni.map((q, i) => <li key={i}>To be more precise, tell me: {q}</li>)}</ul>}
                    {fu.length > 0 && <div className="row" style={{ marginTop: 6 }}>{fu.map((q) => <button key={q} type="button" className="chip" onClick={() => void send(q)}>{q}</button>)}</div>}
                  </div>
                );
              })()}
            </div>
          ))}
          {busy && <div className="bubble assistant"><span className="muted small">The Coach is thinking...</span></div>}
          <div ref={end} />
        </div>
        {error && <div className="notice error" role="alert">{error}{lastUser && !busy && msgs.at(-1)?.role === "user" && !msgs.at(-1)?.failed && <> <button type="button" className="linkbtn" onClick={() => void send(lastUser.content, lastUser.id)}>Retry</button></>}</div>}
        <div className="composer" ref={composer}>
        {msgs.length === 0 && (
          /* phone: the same suggestions as one swipeable row right above the composer, so they never need a scroll (desktop keeps the list above) */
          <div className="sug-strip" role="group" aria-label="Suggested questions">{suggestions.map((s) => <button key={s} type="button" className="chip" onClick={() => void send(s)}>{s}</button>)}</div>
        )}
        {input.length >= 1800 && <p className="chatcount muted small" role="status" aria-live="polite">{input.length} of 2000 characters</p>}
        <form className="chatinput" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
          <textarea ref={field} rows={1} maxLength={2000} value={input} onChange={(e) => setInput(e.target.value)} placeholder={placeholder ?? "Ask APEX Coach..."} aria-label="Message" enterKeyHint="send" autoComplete="off" autoCapitalize="sentences" onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); } }} />
          {/* mouseDown is not allowed to move focus off the field: sending a message keeps the keyboard open for the next one */}
          <button className="btn sendbtn" type="submit" aria-label="Send message" aria-busy={busy || undefined} disabled={busy || !input.trim()} onMouseDown={(e) => e.preventDefault()}>
            <span className="sendtxt">{busy ? "..." : "Send"}</span>
            <svg className="sendico" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" /></svg>
          </button>
        </form>
        <p className="muted small" style={{ margin: "6px 0 0" }}>AI-generated guidance based on the data you share. Not medical advice: for symptoms or abnormal results, see a professional.</p>
        </div>
      </div>
    </div>
  );
}