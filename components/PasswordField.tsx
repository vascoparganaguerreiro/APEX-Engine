"use client";
import { useId, useState } from "react";
import { passwordInputType, passwordToggleLabel } from "@/lib/authFlow";

/** A password box with its own show/hide button (eye / eye-off). Hidden by default; each field toggles independently; toggling only changes the
 *  input type, so the typed text is never cleared or touched. The button is type="button" (never submits the form). The value lives in the
 *  parent's state exactly as before: nothing is stored or logged here. */
export default function PasswordField({ label, value, onChange, autoComplete, minLength, required = true }: {
  label: string; value: string; onChange: (v: string) => void; autoComplete: "current-password" | "new-password"; minLength?: number; required?: boolean;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const action = passwordToggleLabel(visible);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="pwfield">
        <input id={id} type={passwordInputType(visible)} required={required} minLength={minLength} autoComplete={autoComplete} autoCapitalize="none" autoCorrect="off" spellCheck={false}
          value={value} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="pwtoggle" aria-label={action} aria-pressed={visible} title={action} onClick={() => setVisible((v) => !v)}>
          {visible ? (
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3l18 18" /><path d="M10.6 5.1A10.7 10.7 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3.1 4" /><path d="M6.6 6.6C3.9 8.4 2.5 12 2.5 12s3.5 7 9.5 7c1.5 0 2.9-.4 4.1-1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7S2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
