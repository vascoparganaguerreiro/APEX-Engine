"use client";
import { useEffect, useState } from "react";
import { CATEGORY_INFO, type Category } from "@/lib/coach/schema";
import { useAuth } from "@/lib/useAuth";
import {
  COACH_CATEGORIES, EMPTY_CONSENT_STATE, authorizedOf, consentView, loadConsentState, saveConsentState, validUid,
  type Consent, type ConsentState, type ConsentStorage,
} from "@/lib/coach/consentStore";

export { authorizedOf, type Consent };
const storage = (): ConsentStorage | null => { try { return window.localStorage; } catch { return null; } };

/** Consent of the SIGNED-IN account only (lib/coach/consentStore.ts), kept in this browser and re-sent (and re-checked by the server)
 *  with every request. `ready` is false while auth or that account's consent is loading, when signed out, and for one render after an
 *  account switch; until then the consent is "nothing shared" and changes are ignored. The 4th value is the account the consent was
 *  loaded for (null until ready); every AI request sends it so the server can reject a token from another account (lib/consentOwner.ts). */
export function useConsent(): [Consent, (c: Consent) => void, boolean, string | null] {
  const { session, loading } = useAuth();
  const uid = loading ? null : validUid(session?.user?.id);
  const [state, setState] = useState<ConsentState>(EMPTY_CONSENT_STATE);
  useEffect(() => { setState(loadConsentState(storage(), uid)); }, [uid]);   // sign-out / switch: the previous account's state is dropped
  const { consent, ready } = consentView(state, uid);
  const save = (next: Consent) => { const s = saveConsentState(storage(), state, uid, next); if (s) setState(s); };
  return [consent, save, ready, ready ? uid : null];
}

export default function ConsentPanel({ consent, onChange }: { consent: Consent; onChange: (c: Consent) => void }) {
  const [open, setOpen] = useState(false);
  const on = authorizedOf(consent);
  const toggle = (cat: Category) => onChange({ ...consent, categories: consent.categories.includes(cat) ? consent.categories.filter((x) => x !== cat) : COACH_CATEGORIES.filter((x) => x === cat || consent.categories.includes(x)) });
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
          {COACH_CATEGORIES.map((c) => (
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