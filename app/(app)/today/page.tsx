"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import { addDays, readiness, trendSeries } from "@/lib/engine";
import { dailyLoads } from "@/lib/activities";
import { todayIso } from "@/lib/dates";
import type { DailyRow } from "@/lib/types";
import TodayView from "@/components/TodayView";

const errMsg = (e: unknown) =>
  e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export default function TodayPage() {
  const { session } = useAuth();
  const [rows, setRows] = useState<DailyRow[] | null>(null);
  const [loads, setLoads] = useState<Record<string, number>>({});
  const [goal, setGoal] = useState(8);
  const [error, setError] = useState<string | null>(null);

  const [day, setDay] = useState(todayIso());
  const [hrv, setHrv] = useState("60");
  const [rhr, setRhr] = useState("52");
  const [sleep, setSleep] = useState("7.5");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const sb = getSupabase();
      const since = addDays(todayIso(), -45);
      const loadSince = addDays(todayIso(), -210);   // CTL needs months of history to be meaningful
      const [prof, daily, acts] = await Promise.all([
        sb.from("profiles").select("sleep_goal_h").maybeSingle(),
        sb.from("daily_metrics").select("day,hrv_ms,rhr_bpm,sleep_minutes,sleep_score").gte("day", since).order("day"),
        sb.from("activities").select("started_at,load").gte("started_at", `${loadSince}T00:00:00Z`).limit(5000),
      ]);
      if (daily.error) throw daily.error;
      if (acts.error) throw acts.error;
      setRows((daily.data ?? []) as DailyRow[]);
      setLoads(dailyLoads((acts.data ?? []) as Array<{ started_at: string; load: number | null }>));
      if (prof.data?.sleep_goal_h) setGoal(Number(prof.data.sleep_goal_h));
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => { if (session) load(); }, [session, load]);

  const latest = rows && rows.length ? rows[rows.length - 1] : null;
  const prior = rows && latest ? rows.filter((r) => r.day !== latest.day).slice(-14) : [];
  const result = latest
    ? readiness({
        hrv: num(latest.hrv_ms), rhr: num(latest.rhr_bpm),
        sleepH: latest.sleep_minutes ? Number(latest.sleep_minutes) / 60 : null,
        hrvPrior: prior.map((r) => num(r.hrv_ms)), rhrPrior: prior.map((r) => num(r.rhr_bpm)),
        sleepGoalH: goal,
      })
    : null;

  const today = todayIso();
  const trend = useMemo(() => {
    const hrvByDay: Record<string, number | null> = {};
    for (const r of rows ?? []) hrvByDay[r.day] = num(r.hrv_ms);
    return trendSeries(loads, hrvByDay, addDays(today, -29), today);
  }, [rows, loads, today]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!session) return;
    const h = Number(hrv), r = Number(rhr), s = Number(sleep);
    if (![h, r, s].every(Number.isFinite) || h <= 0 || r <= 0 || s <= 0) {
      setError("Please enter valid numbers.");
      return;
    }
    setSaving(true);
    const { error: err } = await getSupabase().from("daily_metrics").upsert(
      { user_id: session.user.id, day, hrv_ms: h, rhr_bpm: Math.round(r), sleep_minutes: Math.round(s * 60), source: "manual" },
      { onConflict: "user_id,day" },
    );
    setSaving(false);
    if (err) setError(err.message); else await load();
  }

  return (
    <>
      <div className="eyebrow">Command Center</div>
      <h1>Today</h1>
      {error && <div className="notice error">{error}</div>}
      {rows === null && !error ? <p className="muted">Loading…</p> : <TodayView result={result} latest={latest} goal={goal} today={today} trend={trend} />}

      <h2>Log a day</h2>
      <form className="card formgrid" onSubmit={save}>
        <label>Date<input type="date" value={day} max={todayIso()} onChange={(e) => setDay(e.target.value)} required /></label>
        <label>Overnight HRV (ms)<input type="number" step="1" min="1" value={hrv} onChange={(e) => setHrv(e.target.value)} required /></label>
        <label>Resting HR (bpm)<input type="number" step="1" min="1" value={rhr} onChange={(e) => setRhr(e.target.value)} required /></label>
        <label>Sleep (hours)<input type="number" step="0.25" min="0.25" value={sleep} onChange={(e) => setSleep(e.target.value)} required /></label>
        <button className="btn" disabled={saving} type="submit">{saving ? "Saving…" : "Save"}</button>
      </form>
    </>
  );
}
