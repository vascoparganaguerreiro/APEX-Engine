"use client";
import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import { DESKTOP_NAV, isActive } from "@/lib/nav";
import BottomNav from "@/components/nav/BottomNav";

const signOut = () => getSupabase().auth.signOut({ scope: "local" });

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
          {DESKTOP_NAV.map((n) => (
            <Link key={n.href} href={n.href} className={isActive(path, n.href) ? "navitem on" : "navitem"}>{n.label}</Link>
          ))}
        </nav>
        {/* scope "local": signs out THIS device only. The default ("global") would also sign out your phone and every other device. */}
        <button className="btn ghost" onClick={signOut}>Sign out</button>
      </aside>
      <main className="main">{children}</main>
      <BottomNav email={session.user.email} onSignOut={signOut} />
    </div>
  );
}
