"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import { summarize } from "@/lib/api";
import { todayIso } from "@/lib/dates";
import {
  SPORT_LABEL, addDaysIso, filterActivities, formatDistance, formatDuration, localDay, summarizeActivities,
  weekStart, weekTotals, type Activity,
} from "@/lib/activities";
import ActivityCard from "@/components/ActivityCard";
import WeekCard from "@/components/WeekCard";

const COLS = "id,started_at,sport,title,duration_s,distance_m,avg_hr,load,note,ai_summary,ai_summary_at";
const errMsg = (e: unknown) =>
  e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);

export default function ActivitiesPage() {
  const { session } = useAuth();
  const thisWeek = weekStart(todayIso());
  const [ws, setWs] = useState(thisWeek);
  const [acts, setActs] = useState<Activity[] | null>(null);
  const [weekSummary, setWeekSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | "week" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sport, setSport] = useState("all");
  const [query, setQuery] = useState("");

  const loadActs = useCallback(async () => {
    try {
      const since = addDaysIso(todayIso(), -200);
      const { data, error: err } = await getSupabase().from("activities").select(COLS)
        .gte("started_at", `${since}T00:00:00Z`).order("started_at", { ascending: false }).limit(800);
      if (err) throw err;
      setActs((data ?? []) as Activity[]);
      setError(null);
    } catch (e) { setError(errMsg(e)); }
  }, []);

  useEffect(() => { if (session) loadActs(); }, [session, loadActs]);

  useEffect(() => {
    if (!session) return;
    setWeekSummary(null);
    getSupabase().from("weekly_summaries").select("summary").eq("week_start", ws).maybeSingle()
      .then(({ data }) => setWeekSummary(data?.summary ?? null));
  }, [session, ws]);

  const we = addDaysIso(ws, 6);
  const inWeek = useMemo(
    () => (acts ?? []).filter((a) => { const d = localDay(a.started_at); return d >= ws && d <= we; }),
    [acts, ws, we],
  );
  const totals = useMemo(() => weekTotals(acts ?? [], ws), [acts, ws]);

  // Searching looks across everything loaded (last 200 days); otherwise the list is the selected week.
  const searching = query.trim() !== "";
  const shown = useMemo(
    () => filterActivities(searching ? (acts ?? []) : inWeek, sport, query),
    [acts, inWeek, sport, query, searching],
  );
  const sum = useMemo(() => summarizeActivities(shown, sport), [shown, sport]);
  const sports = useMemo(() => {
    const present = new Set((acts ?? []).map((a) => a.sport));
    return Object.keys(SPORT_LABEL).filter((s) => present.has(s)).concat([...present].filter((s) => !(s in SPORT_LABEL)));
  }, [acts]);

  async function saveNote(id: number, note: string) {
    const { error: err } = await getSupabase().from("activities").update({ note: note || null }).eq("id", id);
    if (err) { setError(err.message); return; }
    setActs((prev) => (prev ?? []).map((a) => (a.id === id ? { ...a, note: note || null } : a)));
  }

  async function summarizeActivity(id: number) {
    setBusy(id); setError(null);
    try {
      const r = await summarize({ kind: "activity", id });
      setActs((prev) => (prev ?? []).map((a) => (a.id === id ? { ...a, ai_summary: r.summary, ai_summary_at: new Date().toISOString() } : a)));
    } catch (e) { setError(errMsg(e)); } finally { setBusy(null); }
  }

  async function summarizeWeek() {
    setBusy("week"); setError(null);
    try { setWeekSummary((await summarize({ kind: "week", weekStart: ws })).summary); }
    catch (e) { setError(errMsg(e)); } finally { setBusy(null); }
  }

  return (
    <>
      <div className="eyebrow">Training</div>
      <h1>Activities</h1>
      {error && <div className="notice error">{error}</div>}
      {acts === null && !error && <p className="muted">Loading…</p>}
      {acts !== null && (
        <>
          <WeekCard start={ws} end={we} totals={totals} summary={weekSummary} busy={busy === "week"}
            canNext={ws < thisWeek} onPrev={() => setWs(addDaysIso(ws, -7))} onNext={() => setWs(addDaysIso(ws, 7))}
            onSummarize={summarizeWeek} />
          <h2>Sessions</h2>
          <div className="filters">
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search title or notes (all loaded sessions)…" aria-label="Search activities" />
            <div className="row" role="group" aria-label="Filter by sport">
              {["all", ...sports].map((s) => (
                <button key={s} type="button" className={sport === s ? "chip on" : "chip"} aria-pressed={sport === s} onClick={() => setSport(s)}>
                  {s === "all" ? "All" : SPORT_LABEL[s] ?? s}
                </button>
              ))}
            </div>
          </div>
          <div className="kpis">
            <div className="kpi"><small>Distance</small><b>{sum.distanceM ? formatDistance(sum.distanceM) : "—"}</b></div>
            <div className="kpi"><small>Time</small><b>{formatDuration(sum.durationS)}</b></div>
            <div className="kpi">
              <small>{sport === "bike" ? "Avg speed" : "Avg pace"} / power</small>
              <b>{sum.pace ?? "—"}</b>
              <em>{sum.pace ? "" : ["run", "bike", "swim"].includes(sport) ? "" : "pick a sport"}</em>
            </div>
            <div className="kpi"><small>TSS</small><b>{sum.load || "—"}</b></div>
          </div>
          <p className="muted small">{sum.sessions} session{sum.sessions === 1 ? "" : "s"}{searching ? " matching your search" : " this week"}. Power is not imported yet.</p>
          {shown.length === 0 && <div className="notice">{searching || sport !== "all" ? "No sessions match these filters." : "No sessions recorded this week."}</div>}
          {shown.map((a) => (
            <ActivityCard key={a.id} a={a} busy={busy === a.id} onSaveNote={saveNote} onSummarize={summarizeActivity} />
          ))}
        </>
      )}
    </>
  );
}
