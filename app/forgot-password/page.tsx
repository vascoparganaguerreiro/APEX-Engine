"use client";
import { useState } from "react";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import { requestPasswordReset } from "@/lib/authFlow";
import { SafeError } from "@/lib/userError";

/** Step 1 of "forgot password": ask for the email address. The answer is the same whether or not the address has an account. */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "ok"; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null); setBusy(true);
    try {
      // The link in the email returns to THIS site (works on localhost, Preview and Production alike); it must be in the Supabase redirect allow-list.
      const r = await requestPasswordReset(getSupabase().auth, email, window.location.origin);
      setMessage({ kind: r.ok ? "ok" : "error", text: r.message });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof SafeError ? err.message : "Could not send the email right now. Please try again." });
    } finally { setBusy(false); }
  }

  return (
    <main className="login">
      <div className="logo">⚡ APEX ENGINE</div>
      <div className="eyebrow" style={{ marginTop: 40 }}>Account</div>
      <h1>Reset your password</h1>
      <p className="muted">Enter the email address you sign in with. We will email you a link to choose a new password.</p>
      <form className="card" onSubmit={submit} noValidate>
        <label>Email
          <input type="email" required autoComplete="email" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <button className="btn" disabled={busy} type="submit">{busy ? "Please wait…" : "Send reset link"}</button>
        {message && <div className={`notice ${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</div>}
      </form>
      <p style={{ marginTop: 18 }}><Link className="linkbtn" href="/login" style={{ display: "inline-flex", alignItems: "center", minHeight: 44 }}>← Back to sign in</Link></p>
    </main>
  );
}
