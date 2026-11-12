"use client";
// Compact Daily Coach card. It shows the latest SAVED analysis (free to read). A new analysis is one AI call through the existing
// /api/coach route with the user's own consent choices, and only when the user presses the button.
import { useState } from "react";
import Link from "next/link";
import { coachRequest } from "@/lib/api";
import { authorizedOf, useConsent } from "@/components/coach/consent";
import { insightView, relDay, shortDate } from "@/lib/today/model";
import type { AssessmentRow } from "@/lib/coach/client";
import type { Section } from "@/lib/today/load";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function CoachInsight({ s, today, tz, onSaved }: { s: Section<AssessmentRow | null>; today: string; tz: string; onSaved: () => void }) {
  const [consent, , ready, consentUser] = useConsent();
  const authorized = authorizedOf(consent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<AssessmentRow | null>(null);

  const row = fresh ?? (s.status === "ok" ? s.data : null);
  const v = insightView(row, today, tz);
  const canRun = ready && authorized.length > 0 && s.status === "ok";

  async function analyse() {
    setBusy(true); setError(null);
    try {
      const r = await coachRequest({ intent: "daily" }, authorized, consentUser);
      if (r.kind !== "daily") throw new Error("Unexpected answer from the Coach.");
      setFresh({ id: r.id ?? "local", kind: "daily", mode: null, sport: null, score: null, confidence: r.confidence, result: r as unknown as Record<string, unknown>, created_at: new Date().toISOString() });
      if (r.saved) onSaved();
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <section className="td-coach" aria-label="APEX Coach">
      <div className="td-section-head"><h2>APEX Coach</h2><span className="td-meta">suggestions from your own data, not medical advice</span></div>
      <div className="td-card td-coachcard">
        {error && <div className="notice error" role="alert">{error}</div>}
        {s.status === "unavailable" ? <p className="td-empty">{s.reason}</p>
          : v && v.forToday ? (
            v.status === "ok" ? (
              <>
                <div className="act-head" style={{ marginBottom: 6 }}><small className="tag ai">Today&apos;s insight</small><span className={`pill conf-${v.confidence}`}>Confidence: {v.confidence}</span></div>
                {v.headline && <p className="td-insight">{v.headline}</p>}
                {v.suggestion && <p className="small" style={{ margin: "6px 0" }}><b>Suggestion (you decide):</b> {v.suggestion}</p>}
                {v.caution && <p className="small td-caution">{v.caution}</p>}
                <p className="td-meta" style={{ margin: "8px 0 0" }}>Based on {v.basedOn.length ? v.basedOn.join(", ") : "no shared data"} ({v.facts} measured fact{v.facts === 1 ? "" : "s"}).{v.missing.length ? ` Missing or limited: ${v.missing.join("; ")}` : ""}</p>
              </>
            ) : <p className="td-empty">Today&apos;s analysis found too little recorded data to say anything reliable.{v.missing.length ? ` ${v.missing.join(" ")}` : ""}</p>
          ) : !ready ? <p className="td-meta">Loading…</p>
          : authorized.length === 0 ? (
            <p className="td-empty">The Coach only reads the data you choose to share. Choose what it may use in <Link href="/coach">Coach</Link>, then come back for a daily insight.</p>
          ) : (
            <>
              <p className="td-empty" style={{ marginTop: 0 }}>{v ? `Last analysis ${relDay(v.day, today)} (${shortDate(v.day)}). ` : "No daily analysis yet. "}Get one insight for today from the data you share ({authorized.length} categor{authorized.length === 1 ? "y" : "ies"}).</p>
              <button type="button" className="btn" disabled={busy || !canRun} onClick={() => void analyse()}>{busy ? "Analysing…" : "Get today's insight"}</button>
            </>
          )}
        <Link className="td-link" href="/coach">Open Coach <span aria-hidden>→</span></Link>
      </div>
    </section>
  );
}
