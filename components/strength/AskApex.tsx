"use client";
import { useEffect, useRef, useState } from "react";
import { coachRequest } from "@/lib/api";
import { useAuth } from "@/lib/useAuth";
import { validUid, type ConsentStorage } from "@/lib/coach/consentStore";
import { EMPTY_ASK_STATE, askConsentView, loadAskConsent, saveAskConsent, type AskConsent, type AskConsentState } from "@/lib/strength/askConsentStore";
import { applyProposal, fitSnapshot, type Proposal, type WorkoutSnapshot } from "@/lib/strength/actions";
import { speechSupport, voiceProposal } from "@/lib/strength/voice";
import { newId } from "@/lib/strength/runtime";
import type { Exercise } from "@/lib/strength/types";
import type { Workout } from "@/lib/strength/workout";

type PState = "open" | "applied" | "dismissed";
interface Msg { role: "user" | "assistant" | "system"; text: string; proposals?: Array<Proposal & { state: PState }> }
const withState = (m: Msg, pi: number, state: PState): Msg => ({ ...m, proposals: m.proposals!.map((y, j) => (j === pi ? { ...y, state } : y)) });
interface Rec { lang: string; continuous: boolean; interimResults: boolean; start(): void; stop(): void; abort(): void; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null }
const storage = (): ConsentStorage | null => { try { return window.localStorage; } catch { return null; } };

/** Ask APEX: the gym assistant. Uses the same /api/coach backend, consent, limits and storage as the Coach (domain "strength"). */
export default function AskApex({ open, onClose, w, snapshot, save, custom }: {
  open: boolean; onClose: () => void; w: Workout; snapshot: () => WorkoutSnapshot; save: (next: Workout) => void; custom: readonly Exercise[];
}) {
  const { session, loading } = useAuth();
  const uid = loading ? null : validUid(session?.user?.id);
  const [state, setState] = useState<AskConsentState>(EMPTY_ASK_STATE);
  useEffect(() => { setState(loadAskConsent(storage(), uid)); }, [uid]);   // sign-out / account switch: the previous account's consent is dropped
  const { consent, ready: consentReady, owner: consentOwner } = askConsentView(state, uid);   // owner = the account this consent was loaded for
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [conv, setConv] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [support, setSupport] = useState({ recognition: false, synthesis: false });
  const rec = useRef<Rec | null>(null);
  useEffect(() => {
    setSupport(speechSupport(window));
  }, []);
  useEffect(() => () => { rec.current?.abort(); try { window.speechSynthesis?.cancel(); } catch { /* optional */ } }, []);
  const setC = (c: AskConsent) => { const s = saveAskConsent(storage(), state, uid, c); if (s) setState(s); };
  const speak = (t: string) => { if (!consent.speak || !support.synthesis) return; try { window.speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(t); u.rate = 1.05; window.speechSynthesis.speak(u); } catch { /* optional */ } };

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setText("");
    // A plain spoken/typed set report is handled on the device: no AI call, works offline.
    const local = voiceProposal(q, snapshot());
    if (local && /\b(add|log|did|done|completed|just|fiz|regista|adiciona)\b/i.test(q)) {
      setMsgs((m) => [...m, { role: "user", text: q }, { role: "assistant", text: "I understood this set. Confirm to add it:", proposals: [{ ...local, state: "open" }] }]);
      speak(`Add ${local.summary}? Tap confirm.`);
      return;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) { setMsgs((m) => [...m, { role: "user", text: q }, { role: "system", text: "Ask APEX needs an internet connection. Logging your sets keeps working offline." }]); return; }
    if (!consentReady) { setMsgs((m) => [...m, { role: "user", text: q }, { role: "system", text: "Your sharing settings are still loading. Try again in a moment." }]); return; }   // no AI request until this account's consent is loaded
    setMsgs((m) => [...m, { role: "user", text: q }]);
    setBusy(true);
    try {
      const cats = [...(consent.strength ? ["strength"] : []), ...(consent.profile ? ["profile"] : [])];
      const r = await coachRequest({ intent: "chat", domain: "strength", message: q, conversationId: conv, strength: consent.strength ? fitSnapshot(snapshot()) : null }, cats, consentOwner);
      if (r.kind !== "chat") throw new Error("Unexpected answer.");
      setConv(r.conversationId);
      setMsgs((m) => [...m, { role: "assistant", text: r.answer, proposals: (r.proposals ?? []).map((p) => ({ ...p, state: "open" as const })) }]);
      speak(r.answer);
    } catch (e) {
      setMsgs((m) => [...m, { role: "system", text: e instanceof Error ? e.message : String(e) }]);
    } finally { setBusy(false); }
  }

  function confirm(mi: number, pi: number) {
    const p = msgs[mi].proposals![pi];
    if (p.extraConfirm && !window.confirm(`${p.reason ?? "This changes recorded data."}\n\n${p.summary}\n\nApply this change?`)) return;
    try {
      save(applyProposal(w, p.action, { newId, custom }));
      setMsgs((m) => m.map((x, i) => (i !== mi ? x : withState(x, pi, "applied"))).concat({ role: "system", text: `Applied to your workout: ${p.summary}.` }));
    } catch (e) {
      setMsgs((m) => [...m, { role: "system", text: `Not applied: ${e instanceof Error ? e.message : String(e)}` }]);
    }
  }
  const dismiss = (mi: number, pi: number) => setMsgs((m) => m.map((x, i) => (i !== mi ? x : withState(x, pi, "dismissed"))));

  function talk() {
    if (listening) { rec.current?.stop(); return; }
    const Ctor = (window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => Rec }).webkitSpeechRecognition;
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = navigator.language || "en-US"; r.continuous = false; r.interimResults = true;     // push-to-talk: one utterance, then it stops
    let finalText = "";
    r.onresult = (e) => { let t = ""; for (let i = 0; i < e.results.length; i++) { t += e.results[i][0].transcript; if (e.results[i].isFinal) finalText = t; } setText(t); };
    r.onerror = (e) => { setListening(false); setMsgs((m) => [...m, { role: "system", text: e.error === "not-allowed" || e.error === "service-not-allowed" ? "Microphone access was blocked. Allow it in the browser's site settings, or type instead." : `Voice input stopped (${e.error}). You can type instead.` }]); };
    r.onend = () => { setListening(false); rec.current = null; if (finalText.trim()) void ask(finalText); };
    rec.current = r; setListening(true);
    try { r.start(); } catch { setListening(false); }
  }

  if (!open) return null;
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Ask APEX" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}><h3>Ask APEX</h3><button className="iconbtn" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="factbox small">
          <label className="check"><input type="checkbox" disabled={!consentReady} checked={consent.strength} onChange={(e) => setC({ ...consent, strength: e.target.checked })} /> Share this workout and my strength history with the AI (Google Gemini)</label>
          <label className="check"><input type="checkbox" disabled={!consentReady} checked={consent.profile} onChange={(e) => setC({ ...consent, profile: e.target.checked })} /> Also share my profile baselines (age, experience, goal; never name or email)</label>
          {support.synthesis && <label className="check"><input type="checkbox" disabled={!consentReady} checked={consent.speak} onChange={(e) => setC({ ...consent, speak: e.target.checked })} /> Read answers aloud (earbuds)</label>}
          <span className="muted">Without sharing, APEX gives general guidance only. Suggested changes are never applied until you confirm.</span>
        </div>
        <div className="chatlog" aria-live="polite" style={{ maxHeight: "40vh" }}>
          {msgs.length === 0 && <p className="muted small">Try: “How do I set up for this?”, “I don’t have this machine, what can I do instead?”, “Should I add weight?”, or say “8 reps at 80 kilos, add that set”.</p>}
          {msgs.map((m, mi) => (
            <div key={mi} className={m.role === "user" ? "bubble user" : "bubble assistant"} style={m.role === "system" ? { borderColor: "#5a4520" } : undefined}>
              <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
              {m.proposals?.map((p, pi) => (
                <div key={pi} className={p.extraConfirm ? "proposal warn" : "proposal"}>
                  <b>Proposed change</b><div>{p.summary}</div>{p.reason && <div className="small" style={{ color: "var(--amber)" }}>{p.reason}</div>}
                  {p.state === "open" ? <div className="row" style={{ marginTop: 6 }}><button className="btn tiny" onClick={() => confirm(mi, pi)}>Confirm</button><button className="btn ghost tiny" onClick={() => dismiss(mi, pi)}>Dismiss</button></div>
                    : <div className="muted small">{p.state === "applied" ? "Applied ✓" : "Dismissed"}</div>}
                </div>
              ))}
            </div>
          ))}
          {busy && <div className="bubble assistant muted">Thinking…</div>}
        </div>
        <div className="chatinput">
          {support.recognition && <button className={listening ? "iconbtn mic live" : "iconbtn mic"} aria-pressed={listening} aria-label={listening ? "Stop listening" : "Push to talk"} onClick={talk}>🎙</button>}
          <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={listening ? "Listening…" : "Ask about this exercise or your workout"} maxLength={2000}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(text); } }} />
          <button className="btn" disabled={busy || !text.trim()} onClick={() => void ask(text)}>Send</button>
        </div>
        {listening && <p className="small" style={{ color: "var(--red)" }} role="status">● Microphone on: speak now. It stops by itself after one sentence.</p>}
        <p className="muted small" style={{ marginBottom: 0 }}>
          {support.recognition ? "Voice uses your browser's speech recognition (Chrome sends audio to Google, Safari to Apple, to turn it into text). APEX never records or stores audio." : "Voice input is not supported in this browser; type instead."}
        </p>
      </div>
    </div>
  );
}
