"use client";
import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";

const NAV = [
  { href: "/today", label: "Today" },
  { href: "/activities", label: "Activities" },
  { href: "/import", label: "Import" },
  { href: "/training", label: "Training", soon: true },
  { href: "/coach", label: "Coach", soon: true },
  { href: "/supplements", label: "Supplements", soon: true },
  { href: "/biomarkers", label: "Biomarkers", soon: true },
  { href: "/races", label: "Races", soon: true },
  { href: "/profile", label: "Profile", soon: true },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { session, loading, error } = useAuth();
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    if (!loading && !session && !error) router.replace("/login");
  }, [loading, session, error, router]);

  if (error) return <div className="center"><div className="notice error">{error}</div></div>;
  if (loading || !session) return <div className="center muted">Loading…</div>;

  return (
    <div className="shell">
      <aside className="side">
        <div className="logo">⚡ APEX ENGINE</div>
        <div className="muted small email">{session.user.email}</div>
        <nav>
          {NAV.map((n) =>
            n.soon ? (
              <span key={n.href} className="navitem soon">{n.label} <em>soon</em></span>
            ) : (
              <Link key={n.href} href={n.href} className={path === n.href ? "navitem on" : "navitem"}>{n.label}</Link>
            ),
          )}
        </nav>
        <button className="btn ghost" onClick={() => getSupabase().auth.signOut()}>Sign out</button>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
