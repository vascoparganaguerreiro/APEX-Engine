"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import { addDays, readiness, trendSeries } from "@/lib/engine";
import { dailyLoads } from "@/lib/activities";
import { buildManualPatch, type MetricRow } from "@/lib/provenance";
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
  const [hrv, setHrv] = useState("");
  const [rhr, setRhr] = useState("");
  const [sleep, setSleep] = useState("");
  const [saving, setSaving] = useState(false);
  const [existing, setExisting] = useState<MetricRow | null>(null);   // saved row for the selected day
  const [formMsg, setFormMsg] = useState<string | null>(null);

  // Selecting a day loads what is really saved for it (empty fields for a new day: no invented values).
  const loadDay = useCallback(async (d: string) => {
    const { data, error: err } = await getSupabase().from("daily_metrics")
      .select("hrv_ms,rhr_bpm,sleep_minutes,sleep_score,hrv_source,rhr_source,sleep_source,sleep_score_source")
      .eq("day", d).maybeSingle();
    if (err) { setError(err.message); return; }
    const row = (data as MetricRow | null) ?? null;
    setExisting(row);
    setHrv(row?.hrv_ms != null ? String(row.hrv_ms) : "");
    setRhr(row?.rhr_bpm != null ? String(row.rhr_bpm) : "");
    setSleep(row?.sleep_minutes != null ? String(Math.round((row.sleep_minutes / 60) * 100) / 100) : "");
  }, []);

  useEffect(() => { if (session) { setFormMsg(null); loadDay(day); } }, [session, day, loadDay]);

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
    setFormMsg(null);
    const res = buildManualPatch(existing, { hrv, rhr, sleepH: sleep });
    if (res.error) { setError(res.error); return; }
    if (Object.keys(res.patch).length === 0) { setError(null); setFormMsg("Nothing to save: no field was filled in or changed."); return; }
    setSaving(true);
    // Only the changed fields are written, so the other measurements (and their sources) stay untouched.
    const { error: err } = await getSupabase().from("daily_metrics").upsert(
      { user_id: session.user.id, day, ...res.patch, ...(existing ? {} : { source: "manual" }) },
      { onConflict: "user_id,day" },
    );
    setSaving(false);
    if (err) { setError(err.message); return; }
    setError(null);
    setFormMsg("Saved.");
    await Promise.all([load(), loadDay(day)]);
  }

  return (
    <>
      <div className="eyebrow">Command Center</div>
      <h1>Today</h1>
      {error && <div className="notice error">{error}</div>}
      {rows === null && !error ? <p className="muted">Loading…</p> : <TodayView result={result} latest={latest} goal={goal} today={today} trend={trend} />}

      <h2>Log a day</h2>
      <p className="muted small">
        {existing
          ? `Editing the saved entry for ${day}. Only the fields you change are updated.`
          : `New entry for ${day}. Fill in only what you measured; empty fields stay empty.`}
      </p>
      {formMsg && <div className={formMsg === "Saved." ? "notice ok" : "notice"}>{formMsg}</div>}
      <form className="card formgrid" onSubmit={save}>
        <label>Date<input type="date" value={day} max={todayIso()} onChange={(e) => setDay(e.target.value)} required /></label>
        <label>Overnight HRV (ms){existing?.hrv_ms != null && <small>{existing.hrv_source === "intervals" ? "synced" : "manual"}</small>}
          <input type="number" step="0.1" min="1" value={hrv} onChange={(e) => setHrv(e.target.value)} /></label>
        <label>Resting HR (bpm){existing?.rhr_bpm != null && <small>{existing.rhr_source === "intervals" ? "synced" : "manual"}</small>}
          <input type="number" step="1" min="20" value={rhr} onChange={(e) => setRhr(e.target.value)} /></label>
        <label>Sleep (hours){existing?.sleep_minutes != null && <small>{existing.sleep_source === "intervals" ? "synced" : "manual"}</small>}
          <input type="number" step="0.25" min="0.25" value={sleep} onChange={(e) => setSleep(e.target.value)} /></label>
        <button className="btn" disabled={saving} type="submit">{saving ? "Saving…" : "Save"}</button>
      </form>
    </>
  );
}
