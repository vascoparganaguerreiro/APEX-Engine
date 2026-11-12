"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SYNC_TEXT, useSyncStatus } from "@/lib/strength/runtime";

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
      <b>Strength Hub database not set up yet.</b> {what} needs migration <code>13_strength.sql</code>, which has not been applied. Workouts you log are still kept safely
      on this device and will upload automatically once the migration is applied.
    </div>
  );
}

export function SyncPill() {
  const { status, storage } = useSyncStatus();
  if (!status) return <span className="syncpill pending">Loading…</span>;
  const extra = status.failed ? ` · ${status.failed} failed` : status.pending ? ` · ${status.pending}` : "";
  return (
    <span className={`syncpill ${status.mode}`} role="status" aria-live="polite" title={[status.message, storage === "memory" ? "This browser gives no durable storage: keep the tab open until it is saved." : null].filter(Boolean).join(" ")}>
      {SYNC_TEXT[status.mode]}{extra}
    </span>
  );
}
