"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import PasswordField from "@/components/PasswordField";
import { SafeError } from "@/lib/userError";
import { completePasswordReset, linkErrorMessage, parseRecoveryUrl, recoverySession, LINK_EXPIRED_MESSAGE, MIN_PASSWORD } from "@/lib/authFlow";

type Phase = "checking" | "ready" | "invalid" | "done";

/** Step 2 of "forgot password": the page the email link opens. It needs a recovery session from the link; without one it explains why. */
export default function ResetPasswordPage() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [problem, setProblem] = useState<string>(LINK_EXPIRED_MESSAGE);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const link = parseRecoveryUrl(window.location.hash, window.location.search);
      if (link.kind === "error") { setProblem(linkErrorMessage(link.reason)); setPhase("invalid"); return; }
      if (link.kind === "none") { setProblem("Open the link from the reset email, or request a new one."); setPhase("invalid"); return; }
      try {
        const sb = getSupabase();                                         // creating the client lets supabase-js read the session from the link
        const ok = await recoverySession(sb.auth, link);
        if (!alive) return;
        window.history.replaceState(null, "", window.location.pathname);   // the tokens must not stay in the address bar or the history
        if (ok) setPhase("ready"); else { setProblem(LINK_EXPIRED_MESSAGE); setPhase("invalid"); }
      } catch (e) {
        if (!alive) return;
        setProblem(e instanceof SafeError ? e.message : LINK_EXPIRED_MESSAGE);
        setPhase("invalid");
      }
    })();
    return () => { alive = false; };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      const r = await completePasswordReset(getSupabase().auth, password, confirm);
      if (r.ok) { setPassword(""); setConfirm(""); setPhase("done"); }
      else if (r.expired) { setProblem(r.message); setPhase("invalid"); }
      else setError(r.message);
    } catch { setError("The password could not be changed. Please try again."); }
    finally { setBusy(false); }
  }

  return (
    <main className="login">
      <div className="logo">⚡ APEX ENGINE</div>
      <div className="eyebrow" style={{ marginTop: 40 }}>Account</div>
      <h1>Choose a new password</h1>
      {phase === "checking" && <p className="muted" role="status">Checking your reset link…</p>}
      {phase === "invalid" && (
        <div className="card">
          <div className="notice error" role="alert">{problem}</div>
          <Link className="btn" href="/forgot-password" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: 44, textDecoration: "none" }}>Request a new link</Link>
        </div>
      )}
      {phase === "ready" && (
        <form className="card" onSubmit={submit} noValidate>
          <PasswordField label={`New password (at least ${MIN_PASSWORD} characters)`} value={password} onChange={setPassword} autoComplete="new-password" minLength={MIN_PASSWORD} />
          <PasswordField label="Repeat the new password" value={confirm} onChange={setConfirm} autoComplete="new-password" minLength={MIN_PASSWORD} />
          <button className="btn" disabled={busy} type="submit">{busy ? "Please wait…" : "Save new password"}</button>
          {error && <div className="notice error" role="alert">{error}</div>}
        </form>
      )}
      {phase === "done" && (
        <div className="card">
          <div className="notice ok" role="status">Your password has been changed. Sign in with the new password.</div>
          <Link className="btn" href="/login" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: 44, textDecoration: "none" }}>Go to sign in</Link>
        </div>
      )}
    </main>
  );
}
