"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";

export default function LoginPage() {
  const router = useRouter();
  const { session, loading, error: setupError } = useAuth();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "ok"; text: string } | null>(null);

  useEffect(() => {
    if (!loading && session) router.replace("/today");
  }, [loading, session, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    if (mode === "up" && password.length < 8) {
      setMessage({ kind: "error", text: "Password must have at least 8 characters." });
      return;
    }
    setBusy(true);
    try {
      const sb = getSupabase();
      if (mode === "in") {
        const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
        if (error) setMessage({ kind: "error", text: "Sign-in failed. Check your email and password." });
      } else {
        const { data, error } = await sb.auth.signUp({ email: email.trim(), password });
        if (error) {
          setMessage({ kind: "error", text: "Could not create the account. In this private beta only invited emails can register." });
        } else if (!data.session) {
          setMessage({ kind: "ok", text: "Account created. Check your email to confirm it, then sign in." });
        }
      }
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <div className="logo">⚡ APEX ENGINE</div>
      <div className="eyebrow" style={{ marginTop: 40 }}>Private beta</div>
      <h1>Your data, finally turned into decisions.</h1>
      <p className="muted">Access is by invitation only. Use the email address you were invited with.</p>
      {setupError && <div className="notice error">{setupError}</div>}
      <div className="tabs">
        <button className={mode === "in" ? "tab on" : "tab"} onClick={() => setMode("in")} type="button">Sign in</button>
        <button className={mode === "up" ? "tab on" : "tab"} onClick={() => setMode("up")} type="button">Create account</button>
      </div>
      <form className="card" onSubmit={submit}>
        <label>{mode === "in" ? "Email" : "Invited email"}
          <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>{mode === "in" ? "Password" : "Choose a password (min. 8 characters)"}
          <input type="password" required autoComplete={mode === "in" ? "current-password" : "new-password"}
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="btn" disabled={busy || !!setupError} type="submit">
          {busy ? "Please wait…" : mode === "in" ? "Sign in" : "Create account"}
        </button>
        {message && <div className={`notice ${message.kind}`}>{message.text}</div>}
      </form>
    </main>
  );
}
