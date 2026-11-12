"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import { coachRequest } from "@/lib/api";
import { loadProfile, type Profile } from "@/lib/profile";
import { countdown, nextUpcomingRace, type Race } from "@/lib/races";
import { deleteAssessment, listAssessments, type AssessmentRow } from "@/lib/coach/client";
import type { DailyResult, SessionResult } from "@/lib/coach/engine";
import ConsentPanel, { authorizedOf, useConsent } from "@/components/coach/consent";
import ChatPanel from "@/components/coach/ChatPanel";
import SessionEvaluator from "@/components/coach/SessionEvaluator";
import { DailyCard, SessionCard } from "@/components/coach/AssessmentCards";

import { friendlyMessage } from "@/lib/userError";
const errMsg = (e: unknown) => friendlyMessage(e, "That could not be completed", { scope: "coach" });
type Tab = "session" | "daily" | "ask" | "plan";
const TABS: Array<{ id: Tab; title: string; text: string }> = [
  { id: "session", title: "Evaluate a session", text: "Score an imported or described workout, with a transparent breakdown." },
  { id: "daily", title: "Daily Coach", text: "Recovery and training guidance from your own data and baselines." },
  { id: "ask", title: "Ask APEX", text: "Ask anything about your training, recovery or results." },
  { id: "plan", title: "Plan and races", text: "Prepare for your goal race and the next training block." },
];
const BASELINES = ["resting_hr", "max_hr", "vo2max", "lthr", "ftp_watts", "weight_kg"] as const;

interface Daily { day: string; hrv_ms: number | null; rhr_bpm: number | null; sleep_minutes: number | null; sleep_score: number | null }

export default function CoachPage() {
  const { session } = useAuth();
  const [consent, setConsent, consentReady, consentUser] = useConsent();   // the signed-in account's own consent; nothing is sent until it is loaded
  const authorized = authorizedOf(consent);
  const [tab, setTab] = useState<Tab>("ask");
  const [profile, setProfile] = useState<{ p: Profile; exists: boolean; migrated: boolean } | null>(null);
  const [daily, setDaily] = useState<Daily | null | undefined>(undefined);
  const [lastAct, setLastAct] = useState<{ started_at: string; sport: string } | null | undefined>(undefined);
  const [race, setRace] = useState<Race | null | undefined>(undefined);
  const [assessments, setAssessments] = useState<AssessmentRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [dailyResult, setDailyResult] = useState<DailyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshAssessments = useCallback(async () => { try { setAssessments(await listAssessments(getSupabase())); } catch { /* optional until migration 12 is applied */ } }, []);
  useEffect(() => {
    if (!session) return;
    const sb = getSupabase();
    loadProfile(sb, session.user.id).then((r) => setProfile({ p: r.profile, exists: r.exists, migrated: r.migrated }), () => setProfile(null));
    sb.from("daily_metrics").select("day,hrv_ms,rhr_bpm,sleep_minutes,sleep_score").order("day", { ascending: false }).limit(1).then(({ data }) => setDaily((data?.[0] as Daily | undefined) ?? null), () => setDaily(null));
    sb.from("activities").select("started_at,sport").order("started_at", { ascending: false }).limit(1).then(({ data }) => setLastAct((data?.[0] as { started_at: string; sport: string } | undefined) ?? null), () => setLastAct(null));
    nextUpcomingRace(sb, new Date().toLocaleDateString("sv-SE")).then(setRace, () => setRace(null));
    void refreshAssessments();
  }, [session, refreshAssessments]);

  const today = new Date().toLocaleDateString("sv-SE");
  const hour = new Date().getHours();
  const name = profile?.p.display_name?.trim();
  const hello = `${hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}${name ? `, ${name}` : ""}`;
  const baselineCount = profile ? BASELINES.filter((k) => profile.p[k] !== null).length : 0;
  const cd = race ? countdown(race.race_date, today) : null;

  async function analyzeDaily() {
    if (!consentReady) return;
    setBusy(true); setError(null);
    try { const r = await coachRequest({ intent: "daily" }, authorized, consentUser); if (r.kind !== "daily") throw new Error("Unexpected answer from the Coach."); setDailyResult(r); if (r.saved) void refreshAssessments(); }
    catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  }
  async function removeAssessment(id: string) {
    if (!window.confirm("Delete this assessment? This cannot be undone.")) return;
    try { await deleteAssessment(getSupabase(), id); setOpen(null); await refreshAssessments(); } catch (e) { setError(errMsg(e)); }
  }

  const missing: string[] = [];
  if (daily === null) missing.push("No wellness data yet (log a day on Today or sync Intervals.icu).");
  else if (daily && daily.day < today) missing.push(`No wellness entry for today (latest: ${daily.day}).`);
  if (lastAct === null) missing.push("No activities imported yet.");
  if (race === null) missing.push("No upcoming race saved.");
  if (profile && !profile.exists) missing.push("No profile saved yet.");
  else if (profile && baselineCount === 0) missing.push("No physiological baselines saved in your profile.");
  if (profile && !profile.migrated) missing.push("Some profile fields are not available yet (not set up on your account).");

  return (
    <>
      <div className="eyebrow">Performance</div>
      <h1>APEX Coach</h1>
      <p className="muted" style={{ marginTop: -6 }}>{hello}. Evidence-conscious guidance from your own data. It suggests, you decide.</p>
      {error && <div className="notice error" role="alert">{error}</div>}

      {consentReady ? <ConsentPanel consent={consent} onChange={setConsent} /> : <section className="card consent"><p className="muted small" style={{ margin: 0 }}>Loading your sharing settings…</p></section>}

      <section className="card" style={{ marginTop: 14 }}>
        <div className="act-head"><b>Your context today</b><span className="muted small">measured data only</span></div>
        <div className="metrics">
          <div><small>Latest wellness</small><b>{daily === undefined ? "..." : daily ? `${daily.day}` : "None"}</b>
            {daily && <small className="muted">{[daily.hrv_ms ? `HRV ${Math.round(Number(daily.hrv_ms))}` : null, daily.rhr_bpm ? `RHR ${daily.rhr_bpm}` : null, daily.sleep_minutes ? `sleep ${(daily.sleep_minutes / 60).toFixed(1)} h` : null].filter(Boolean).join(" · ") || "no values"}</small>}</div>
          <div><small>Last activity</small><b>{lastAct === undefined ? "..." : lastAct ? new Date(lastAct.started_at).toLocaleDateString() : "None"}</b>{lastAct && <small className="muted">{lastAct.sport}</small>}</div>
          <div><small>Next race</small><b>{race === undefined ? "..." : race && cd ? cd.label : "None"}</b>{race && <small className="muted">{race.name}{race.priority === "A" ? " (goal)" : ""}</small>}</div>
          <div><small>Profile baselines</small><b>{profile === null ? "n/a" : `${baselineCount} of ${BASELINES.length}`}</b><small className="muted"><Link href="/profile" style={{ color: "var(--green)" }}>Edit profile</Link></small></div>
        </div>
        {missing.length > 0 && <div style={{ marginTop: 10 }}><small className="tag measured">Missing</small><ul className="small muted" style={{ margin: "4px 0 0", paddingLeft: 18 }}>{missing.map((m) => <li key={m}>{m}</li>)}</ul></div>}
      </section>

      <div className="captiles">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={tab === t.id ? "captile on" : "captile"} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
            <b>{t.title}</b><span className="muted small">{t.text}</span>
          </button>
        ))}
      </div>

      {!consentReady && <p className="muted small">Loading your sharing settings…</p>}
      {consentReady && tab === "session" && <SessionEvaluator authorized={authorized} consentUser={consentUser}onSaved={refreshAssessments} />}
      {consentReady && tab === "daily" && (
        <div>
          <div className="card"><p style={{ marginTop: 0 }}>The Daily Coach reads your recent HRV, resting heart rate, sleep, training load and consistency, compares them with <b>your own</b> baseline and tells you what is missing. It never gives a single readiness score.</p>
            <div className="row"><button className="btn" onClick={() => void analyzeDaily()} disabled={busy}>{busy ? "Analysing..." : "Analyse today"}</button></div></div>
          {dailyResult && <div style={{ marginTop: 14 }}><DailyCard r={dailyResult} /></div>}
        </div>
      )}
      {consentReady && tab === "ask" && <ChatPanel intent="chat" authorized={authorized} consentUser={consentUser}
        suggestions={["Am I training too much?", "Why has my HRV changed this week?", "How is my endurance improving?", "Should I do intervals tomorrow?", "Explain my latest blood panel", "What should I focus on this month?"]} />}
      {consentReady && tab === "plan" && (
        <div>
          <div className="card" style={{ marginBottom: 14 }}>
            {race && cd ? <><small className="muted">{race.priority === "A" ? "Goal race" : "Next race"}</small><div><b>{race.name}</b> <span className="muted small">· {race.race_date} · {cd.label}</span></div></>
              : <p style={{ margin: 0 }} className="muted">No upcoming race saved. <Link href="/races" style={{ color: "var(--green)" }}>Add one in Races</Link> so the Coach can plan around it.</p>}
            <p className="muted small" style={{ marginBottom: 0 }}>The Coach will not write a detailed plan until you tell it your available days and hours, and it never changes your schedule by itself.</p>
          </div>
          <ChatPanel intent="plan" authorized={authorized} consentUser={consentUser}raceId={race?.id ?? null} placeholder="Ask about your race preparation..."
            suggestions={[race ? `How should I prepare for ${race.name}?` : "How should I prepare for a race?", "What are my biggest weaknesses?", "How is my current training aligned with the race?", "What should my next training block focus on?"]} />
        </div>
      )}

      <h2>Recent assessments</h2>
      {assessments.length === 0 ? <div className="notice">Nothing yet. Evaluate a session or run the Daily Coach and it will appear here.</div> : (
        <div>
          {assessments.map((a) => (
            <div key={a.id} className="card" style={{ marginBottom: 10 }}>
              <div className="act-head">
                <span className="badge">{a.kind === "session" ? (a.mode === "planned" ? "Planned session" : "Session") : "Daily"}</span>
                <b>{a.kind === "session" ? `${a.sport ?? ""}${a.score !== null ? ` · ${a.score}/100` : " · no score"}` : "Recovery analysis"}</b>
                <span className="muted small">{new Date(a.created_at).toLocaleDateString()}</span>
                <span className="row" style={{ marginLeft: "auto" }}>
                  <button type="button" className="chip" onClick={() => setOpen(open === a.id ? null : a.id)}>{open === a.id ? "Hide" : "Open"}</button>
                  <button type="button" className="chip" onClick={() => void removeAssessment(a.id)}>Delete</button>
                </span>
              </div>
              {open === a.id && <div style={{ marginTop: 10 }}>{a.kind === "session" ? <SessionCard r={a.result as unknown as SessionResult} /> : <DailyCard r={a.result as unknown as DailyResult} />}</div>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}