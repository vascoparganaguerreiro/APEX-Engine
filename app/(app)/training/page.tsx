"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import { friendlyMessage } from "@/lib/userError";
import { OMNI_RUN_EVENT, addFromSearch, type OmniRunDetail } from "@/lib/omni";
import { dayIn, userZone } from "@/lib/today/model";
import { loadProfileLite, loadRaces, type ProfileLite, type Section } from "@/lib/today/load";
import type { Race } from "@/lib/races";
import { createPlanned, deletePlanned, linkPlanned, markCompleted, markSkipped, reopenPlanned, updatePlanned } from "@/lib/calendar/data";
import { loadCompletedActivities, loadCompletedStrength, loadPlannedRange } from "@/lib/calendar/load";
import {
  addDaysIso, buildDays, latestGate, monthGrid, monthLabel, plannedCounts, shiftMonth, suggestMatches, viewRange, weekDays, weekLabel, weekStart,
  type DoneActivity, type DoneStrength, type PlannedInput, type PlannedWorkout,
} from "@/lib/calendar/model";
import { Legend, MonthGrid, WeekGrid } from "@/components/calendar/CalendarGrid";
import DayDrawer, { type DrawerActions } from "@/components/calendar/DayDrawer";
import PlannedForm from "@/components/calendar/PlannedForm";
import EmptyState from "@/components/ui/EmptyState";
import { EMPTY } from "@/lib/emptyStates";

const deviceZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "UTC"; } };
const errMsg = (e: unknown) => friendlyMessage(e, "That could not be completed", { scope: "calendar" });

export default function TrainingPage() {
  const { session } = useAuth();
  const [profile, setProfile] = useState<ProfileLite | null>(null);
  const tz = userZone(profile?.timezone, deviceZone());
  const today = dayIn(new Date(), tz);

  const [view, setView] = useState<"week" | "month">("week");
  const [anchor, setAnchor] = useState<string | null>(null);
  const at = anchor ?? today;
  const [planned, setPlanned] = useState<Section<PlannedWorkout[]> | null>(null);
  const [acts, setActs] = useState<Section<DoneActivity[]> | null>(null);
  const [strength, setStrength] = useState<Section<DoneStrength[]> | null>(null);
  const [races, setRaces] = useState<Section<Race[]> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState<{ plan?: PlannedWorkout; date: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (session) void loadProfileLite().then(setProfile).catch(() => setProfile({ display_name: null, timezone: null, sleep_goal_h: null })); }, [session]);
  const range = useMemo(() => viewRange(view, at), [view, at]);

  // Stale-response guard. Responses can arrive out of order when the user navigates quickly or acts while a load is in flight, so a
  // result is applied only if (a) it belongs to the most recent request and (b) the view's range has not changed since. Plans are
  // always loaded for the range shown NOW (rangeRef), never for the range a callback happened to be created with.
  const rangeRef = useRef(range);
  useEffect(() => { rangeRef.current = range; }, [range]);
  // The global Quick actions button opens the same add form: by event when this page is open, or through ?add=1 / ?add=YYYY-MM-DD when
  // arriving from another page (read once, then removed from the address). It only opens the form: nothing is saved without the user.
  useEffect(() => {
    const a = addFromSearch(window.location.search);
    if (a) { setForm({ date: a === "today" ? today : a }); window.history.replaceState(null, "", window.location.pathname); }
    const run = (e: Event) => { if ((e as CustomEvent<OmniRunDetail>).detail?.id === "plan-session") { setError(null); setForm({ date: today }); } };
    window.addEventListener(OMNI_RUN_EVENT, run);
    return () => window.removeEventListener(OMNI_RUN_EVENT, run);
  }, [today]);
  const planGate = useRef(latestGate());
  const loadPlanned = useCallback(() => {
    const r = rangeRef.current, t = planGate.current.ticket();
    return loadPlannedRange(r.from, r.to).then((s) => { if (planGate.current.isLatest(t) && rangeRef.current === r) setPlanned(s); });
  }, []);
  useEffect(() => {
    if (!session || !profile) return;
    let cancelled = false;                                  // set when the range changes or the page unmounts: older results are dropped
    const keep = <T,>(set: (v: T) => void) => (v: T) => { if (!cancelled) set(v); };
    void loadPlanned();
    void loadCompletedActivities(range.from, range.to).then(keep(setActs));
    void loadCompletedStrength(range.from, range.to).then(keep(setStrength));
    void loadRaces().then(keep(setRaces));
    return () => { cancelled = true; };
  }, [session, profile, range, loadPlanned]);

  const plannedList = useMemo(() => (planned?.status === "ok" ? planned.data : []), [planned]);
  const actList = useMemo(() => (acts?.status === "ok" ? acts.data : []), [acts]);
  const strList = useMemo(() => (strength?.status === "ok" ? strength.data : []), [strength]);
  const raceList = useMemo(() => (races?.status === "ok" ? races.data : []), [races]);
  const days = useMemo(() => buildDays({ ...range, tz, planned: plannedList, races: raceList, acts: actList, strength: strList, today }), [range, tz, plannedList, raceList, actList, strList, today]);
  const byDay = useMemo(() => new Map(days.map((d) => [d.day, d])), [days]);
  const suggestions = useMemo(() => suggestMatches({ planned: plannedList, acts: actList, strength: strList, tz }), [plannedList, actList, strList, tz]);
  const shown = view === "week" ? weekDays(at) : days.map((d) => d.day);
  const counts = useMemo(() => plannedCounts(plannedList, shown), [plannedList, shown]);
  const ready = planned?.status === "ok";

  async function guard(fn: () => Promise<unknown>) {
    setError(null);
    try { await fn(); await loadPlanned(); } catch (e) { setError(errMsg(e)); await loadPlanned(); }
  }
  const sb = () => getSupabase();
  const actions: DrawerActions = {
    add: (day) => { setError(null); setForm({ date: day }); },
    edit: (p) => { setError(null); setForm({ plan: p, date: p.planned_date }); },
    remove: (p) => guard(() => deletePlanned(sb(), p.id)),
    done: (p) => guard(() => markCompleted(sb(), p.id)),
    skip: (p) => guard(() => markSkipped(sb(), p.id)),
    reopen: (p) => guard(() => reopenPlanned(sb(), p.id)),
    link: (p, rec, origin) => guard(() => linkPlanned(sb(), p, rec, plannedList, origin)),
  };
  async function save(input: PlannedInput) {
    if (form?.plan) await updatePlanned(sb(), form.plan.id, input); else await createPlanned(sb(), session!.user.id, input);
    setForm(null); setOpen(input.planned_date); await loadPlanned();
  }

  const step = (n: number) => setAnchor(view === "week" ? addDaysIso(weekStart(at), 7 * n) : shiftMonth(at, n));
  const openDay = open ? byDay.get(open) ?? { day: open, planned: [], completed: [], races: [] } : null;

  return (
    <div>
      <div className="eyebrow">Training</div>
      <h1>Calendar</h1>
      <p className="muted small">Plan sessions and see what you actually did. Planned entries are your intentions; recorded sessions come from your activities and strength log. Nothing is planned or changed for you.</p>

      <div className="cal-bar">
        <div className="cal-nav">
          <button className="chip" onClick={() => step(-1)} aria-label="Previous">‹</button>
          <button className="chip" onClick={() => setAnchor(null)}>Today</button>
          <button className="chip" onClick={() => step(1)} aria-label="Next">›</button>
          <b className="cal-title">{view === "week" ? weekLabel(at) : monthLabel(at)}</b>
        </div>
        <div className="cal-nav">
          <button className={`chip${view === "week" ? " on" : ""}`} onClick={() => setView("week")}>Week</button>
          <button className={`chip${view === "month" ? " on" : ""}`} onClick={() => setView("month")}>Month</button>
          {ready && <button className="btn" onClick={() => setForm({ date: open ?? today })}>+ Add</button>}
        </div>
      </div>

      {planned?.status === "unavailable" && <div className="notice" role="status">{planned.reason} Races and recorded sessions are still shown; planning needs the calendar set-up.</div>}
      {(acts?.status === "unavailable" || strength?.status === "unavailable") && <div className="notice" role="status">Some recorded sessions could not be loaded right now.</div>}
      {ready && <p className="muted small" aria-label="Planned counts">This {view}: {counts.planned} planned, {counts.completed} completed, {counts.skipped} skipped sessions{counts.plannedMinutes ? ` · ${counts.plannedMinutes} planned minutes` : ""}. Counts only: planned sessions are never added to your training load.</p>}

      {ready && !form && plannedList.length === 0 && <EmptyState compact copy={EMPTY.training} onAction={() => { setError(null); setForm({ date: open ?? today }); }} />}

      {form && ready && <PlannedForm key={form.plan?.id ?? `new-${form.date}`} initial={form.plan} date={form.date} onSave={save} onCancel={() => setForm(null)} />}

      {!planned || !acts ? <p className="muted">Loading…</p> : view === "week"
        ? <WeekGrid days={weekDays(at).map((d) => byDay.get(d)!).filter(Boolean)} today={today} selected={open} onOpen={setOpen} />
        : <MonthGrid grid={monthGrid(at)} byDay={byDay} today={today} selected={open} onOpen={setOpen} />}
      <Legend />
      <p className="muted small">Race dates come from <Link href="/races" className="td-link" style={{ display: "inline" }}>Races</Link>. Times are shown in {tz}.</p>

      {openDay && !form && (
        <DayDrawer day={openDay} today={today} all={plannedList} suggestions={suggestions} tablesReady={ready} actions={actions} error={error} onClose={() => { setOpen(null); setError(null); }} />
      )}
    </div>
  );
}
