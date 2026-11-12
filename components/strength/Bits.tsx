"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { getEngine, useSyncStatus } from "@/lib/strength/runtime";
import { syncLabel } from "@/lib/strength/sync";

const TABS = [
  { href: "/strength", label: "Workout" }, { href: "/strength/routines", label: "Routines" }, { href: "/strength/exercises", label: "Exercises" },
  { href: "/strength/analytics", label: "Progress" }, { href: "/strength/import", label: "Import" }, { href: "/strength/duplicates", label: "Duplicates" }, { href: "/strength/export", label: "Garmin & calendar" },
];
export function StrengthNav() {
  const path = usePathname();
  return (
    <nav className="sh-tabs" aria-label="Strength Hub">
      {TABS.map((t) => <Link key={t.href} href={t.href} className={(t.href === "/strength" ? path === t.href || path.startsWith("/strength/history") : path.startsWith(t.href)) ? "on" : ""}>{t.label}</Link>)}
    </nav>
  );
}

export function SetupNotice({ what = "This page" }: { what?: string }) {
  return (
    <div className="notice">
      <b>Cloud saving isn&apos;t set up for your account yet.</b> {what} isn&apos;t available until it is. Ask the person who runs APEX. Workouts you log are still kept safely
      on this device and will upload automatically once it is set up.
    </div>
  );
}

/** Where the workout is right now: only on this device, waiting to upload, confirmed by the server, or failed (with a Retry). */
export function SyncPill() {
  const { status, storage } = useSyncStatus();
  if (!status) return <span className="syncpill pending">Loading…</span>;
  return (
    <span className="syncwrap">
      <span className={`syncpill ${status.mode}`} role="status" aria-live="polite" title={[status.message, storage === "memory" ? "This browser gives no durable storage: keep the tab open until it is saved." : null].filter(Boolean).join(" ")}>
        {syncLabel(status)}
      </span>
      {status.failed > 0 && <button type="button" className="chip syncretry" onClick={() => { void getEngine().then(({ engine }) => engine.retryFailed()); }}>Retry</button>}
    </span>
  );
}
