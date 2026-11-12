"use client";
import { useEffect, useState } from "react";
import { CATEGORIES, CATEGORY_INFO, type Category } from "@/lib/coach/schema";

export interface Consent { accepted: boolean; categories: Category[] }
const KEY = "apex.coach.consent.v1";
const NONE: Consent = { accepted: false, categories: [] };

/** Consent lives in this browser only and is re-sent (and re-checked by the server) with every request. */
export function useConsent(): [Consent, (c: Consent) => void, boolean] {
  const [c, setC] = useState<Consent>(NONE);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Consent | null;
      if (raw && typeof raw.accepted === "boolean" && Array.isArray(raw.categories)) setC({ accepted: raw.accepted, categories: raw.categories.filter((x): x is Category => (CATEGORIES as readonly string[]).includes(x)) });
    } catch { /* ignore */ }
    setReady(true);
  }, []);
  const save = (next: Consent) => { setC(next); try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ } };
  return [c, save, ready];
}
/** What may actually be sent: nothing unless the user has accepted. */
export const authorizedOf = (c: Consent): Category[] => (c.accepted ? c.categories : []);

export default function ConsentPanel({ consent, onChange }: { consent: Consent; onChange: (c: Consent) => void }) {
  const [open, setOpen] = useState(false);
  const on = authorizedOf(consent);
  const toggle = (cat: Category) => onChange({ ...consent, categories: consent.categories.includes(cat) ? consent.categories.filter((x) => x !== cat) : CATEGORIES.filter((x) => x === cat || consent.categories.includes(x)) });
  return (
    <section className="card consent">
      <div className="act-head">
        <b>What the Coach can see</b>
        <span className={on.length ? "badge" : "badge off"}>{on.length ? `${on.length} categor${on.length === 1 ? "y" : "ies"} shared` : "No personal data shared"}</span>
        <button type="button" className="linkbtn" style={{ marginLeft: "auto" }} onClick={() => setOpen(!open)}>{open ? "Hide" : "Choose"}</button>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        {on.length ? `Sent to the AI when relevant to your question: ${on.map((c) => CATEGORY_INFO[c].label).join(", ")}.` : "Without sharing, the Coach gives general guidance and cannot see your data."} Your name, email, date of birth and credentials are never sent.
      </p>
      {open && (
        <div style={{ marginTop: 12 }}>
          {CATEGORIES.map((c) => (
            <label key={c} className="check consentrow">
              <input type="checkbox" checked={consent.categories.includes(c)} onChange={() => toggle(c)} style={{ width: "auto" }} />
              <span><b>{CATEGORY_INFO[c].label}</b><br /><span className="muted small">{CATEGORY_INFO[c].sends}</span></span>
            </label>
          ))}
          <label className="check consentrow">
            <input type="checkbox" checked={consent.accepted} onChange={(e) => onChange({ ...consent, accepted: e.target.checked })} style={{ width: "auto" }} />
            <span>I understand that the categories I switched on are sent to Google&apos;s Gemini AI service to answer my requests, and that this is health-related information. Only what a question needs is sent, and I can change this at any time.</span>
          </label>
          {consent.categories.length > 0 && !consent.accepted && <div className="notice">Tick the box above to allow sharing. Until then nothing is sent.</div>}
        </div>
      )}
    </section>
  );
}