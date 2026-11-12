"use client";
import { useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { MIN_PASSWORD, changePassword } from "@/lib/authFlow";
import PasswordField from "@/components/PasswordField";

/** Profile → Account → Change password. Uses the same rules and messages as the reset page (lib/authFlow.ts) and asks for the current password. */
export default function ChangePasswordCard({ email }: { email: string | null | undefined }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null); setBusy(true);
    try {
      const r = await changePassword(getSupabase().auth, email, current, next, confirm);
      setMsg({ kind: r.ok ? "ok" : "error", text: r.message });
      if (r.ok) { setCurrent(""); setNext(""); setConfirm(""); setOpen(false); }
    } catch { setMsg({ kind: "error", text: "The password could not be changed. Please try again." }); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ marginTop: 14 }}>
      {msg && !open && <div className={`notice ${msg.kind}`} role={msg.kind === "error" ? "alert" : "status"}>{msg.text}</div>}
      {!open ? (
        <button type="button" className="btn ghost" onClick={() => { setOpen(true); setMsg(null); }}>Change password</button>
      ) : (
        <form onSubmit={submit} noValidate>
          <h3 style={{ margin: "0 0 10px", fontSize: 16 }}>Change password</h3>
          <PasswordField label="Current password" value={current} onChange={setCurrent} autoComplete="current-password" />
          <PasswordField label={`New password (at least ${MIN_PASSWORD} characters)`} value={next} onChange={setNext} autoComplete="new-password" minLength={MIN_PASSWORD} />
          <PasswordField label="Repeat the new password" value={confirm} onChange={setConfirm} autoComplete="new-password" minLength={MIN_PASSWORD} />
          {msg && <div className={`notice ${msg.kind}`} role={msg.kind === "error" ? "alert" : "status"}>{msg.text}</div>}
          <div className="row">
            <button className="btn" type="submit" disabled={busy}>{busy ? "Please wait…" : "Save new password"}</button>
            <button className="btn ghost" type="button" disabled={busy} onClick={() => { setOpen(false); setCurrent(""); setNext(""); setConfirm(""); setMsg(null); }}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
