"use client";
import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";

const NAV = [
  { href: "/today", label: "Today" },
  { href: "/activities", label: "Activities" },
  { href: "/strength", label: "Strength" },
  { href: "/integrations", label: "Connections" },
  { href: "/training", label: "Training", soon: true },
  { href: "/coach", label: "Coach" },
  { href: "/supplements", label: "Supplements" },
  { href: "/biomarkers", label: "Biomarkers" },
  { href: "/timeline", label: "Timeline" },
  { href: "/races", label: "Races" },
  { href: "/profile", label: "Profile" },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { session, loading, error } = useAuth();
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    if (!loading && !session && !error) router.replace("/login");
  }, [loading, session, error, router]);

  // On a phone the menu is a swipeable row: keep the current section in view (no vertical page jump).
  useEffect(() => { document.querySelector(".side nav .navitem.on")?.scrollIntoView({ inline: "center", block: "nearest" }); }, [path, session]);

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
              <Link key={n.href} href={n.href} className={path === n.href || path.startsWith(n.href + "/") ? "navitem on" : "navitem"}>{n.label}</Link>
            ),
          )}
        </nav>
        {/* scope "local": signs out THIS device only. The default ("global") would also sign out your phone and every other device. */}
        <button className="btn ghost" onClick={() => getSupabase().auth.signOut({ scope: "local" })}>Sign out</button>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
