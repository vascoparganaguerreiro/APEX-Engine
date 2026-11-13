"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/useAuth";
import { addDays, trendSeries } from "@/lib/engine";
import { dailyLoads } from "@/lib/activities";
import { nextRace, type Race } from "@/lib/races";
import {
  biomarkerSummary, dayIn, enduranceSummary, fiveDays, greeting, hourIn, longDate, overview, strengthSummary, supplementSummary, userZone, wellnessSummary,
  type ActLite, type DailyRow, type PanelLite, type ResultLite, type StrengthLite,
} from "@/lib/today/model";
import {
  loadActiveWorkout, loadActivities, loadBiomarkers, loadDaily, loadIntervalsConnected, loadLatestDaily, loadPrimaryGoal, loadProfileLite, loadRaces, loadStrength, loadSupplements,
  loadWhoopRecovery, type ProfileLite, type Section,
} from "@/lib/today/load";
import type { Intake, Schedule, Supplement } from "@/lib/health/core";
import type { AssessmentRow } from "@/lib/coach/client";
import { BiomarkersCard, EnduranceCard, RaceCard, StrengthCard, SupplementsCard, WellnessCard } from "@/components/today/Modules";
import FiveDay from "@/components/today/FiveDay";
import KeyMetrics from "@/components/today/KeyMetrics";
import NextActionCard from "@/components/today/NextActionCard";
import { LENS_LABEL, LENS_SECTIONS, nextAction, type SectionKey } from "@/lib/today/lens";
import { resolveExperience } from "@/lib/experience";
import { useExperience } from "@/lib/useExperience";
import { formatDisplayName } from "@/lib/today/format";
import { setupModel, type LoadState } from "@/lib/today/setup";
import { loadPlannedRange } from "@/lib/calendar/load";
import { OMNI_RUN_EVENT, quickFromSearch, type OmniRunDetail } from "@/lib/omni";
import type { PlannedWorkout } from "@/lib/calendar/model";
import CoachInsight from "@/components/today/CoachInsight";
import QuickLog, { type QuickTab } from "@/components/today/QuickLog";
import TrendChart from "@/components/TrendChart";
import SectionHeader from "@/components/ui/SectionHeader";

const deviceZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "UTC"; } };
const LOADING = { status: "unavailable", reason: "Loading…" } as const;
type Sups = { sups: Supplement[]; schedules: Schedule[]; intakes: Intake[] };

export default function TodayPage() {
  const { session } = useAuth();
  const [profile, setProfile] = useState<ProfileLite | null>(null);
  const [now, setNow] = useState(() => new Date());
  const tz = userZone(profile?.timezone, deviceZone());
  const today = dayIn(now, tz);

  const [daily, setDaily] = useState<Section<DailyRow[]> | null>(null);
  const [acts, setActs] = useState<Section<ActLite[]> | null>(null);
  const [strength, setStrength] = useState<Section<StrengthLite[]> | null>(null);
  const [bio, setBio] = useState<Section<{ panel: PanelLite | null; results: ResultLite[] }> | null>(null);
  const [sups, setSups] = useState<Section<Sups> | null>(null);
  const [races, setRaces] = useState<Section<Race[]> | null>(null);
  const [planned, setPlanned] = useState<Section<PlannedWorkout[]> | null>(null);
  const [coach, setCoach] = useState<Section<AssessmentRow | null> | null>(null);
  const [active, setActive] = useState<{ title: string; startedAt: string } | null>(null);
  const [whoop, setWhoop] = useState<{ value: number; day: string | null } | null>(null);
  const [intervals, setIntervals] = useState(false);
  const [intervalsKnown, setIntervalsKnown] = useState(false);   // false until the connection check has answered (then no "connect a source" hint is shown)
  const [quick, setQuick] = useState<{ open: boolean; tab: QuickTab }>({ open: false, tab: "wellness" });
  const [trendRange, setTrendRange] = useState<14 | 30>(14);
  const [primaryGoal, setPrimaryGoal] = useState<string | null | undefined>(undefined);   // undefined = still loading

  // Every module loads on its own: one failing (or a migration not applied yet) never blocks the others.
  const loadAll = useCallback(async (day: string) => {
    void loadDaily(day).then(setDaily);
    void loadActivities(day).then(setActs);
    void loadStrength(day).then(setStrength);
    void loadBiomarkers().then(setBio);
    void loadSupplements(day).then(setSups);
    void loadRaces().then(setRaces);
    void loadPlannedRange(day, addDays(day, 4)).then(setPlanned);   // migration 15; "unavailable" simply leaves the strip as it was
    void loadLatestDaily().then(setCoach);
    void loadActiveWorkout().then(setActive);
    void loadWhoopRecovery().then(setWhoop);
    void loadIntervalsConnected().then((v) => { setIntervals(v); setIntervalsKnown(true); });
  }, []);
  useEffect(() => { if (session) void loadPrimaryGoal().then(setPrimaryGoal); }, [session]);
  useEffect(() => { if (session) void loadProfileLite().then(setProfile).catch(() => setProfile({ display_name: null, timezone: null, sleep_goal_h: null })); }, [session]);
  useEffect(() => { if (session && profile) void loadAll(today); }, [session, profile, today, loadAll]);
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 60_000); return () => window.clearInterval(t); }, []);   // greeting and "today" roll over at midnight

  const goal = profile?.sleep_goal_h ?? null;          // the user's own goal, or none (sleep is then left out of the estimate)
  const w = useMemo(() => (daily?.status === "ok" ? wellnessSummary(daily.data, today, goal) : null), [daily, today, goal]);
  const loads = useMemo(() => (acts?.status === "ok" ? dailyLoads(acts.data, tz) : {}), [acts, tz]);
  const trend = useMemo(() => {
    const hrv: Record<string, number | null> = {};
    if (daily?.status === "ok") for (const r of daily.data) hrv[r.day] = r.hrv_ms;
    return trendSeries(loads, hrv, addDays(today, -29), today);
  }, [loads, daily, today]);
  const e = useMemo(() => (acts?.status === "ok" ? enduranceSummary(acts.data, trend, today, tz) : null), [acts, trend, today, tz]);
  const st = useMemo(() => (strength?.status === "ok" ? strengthSummary(strength.data, today, tz) : null), [strength, today, tz]);
  const b = useMemo(() => (bio?.status === "ok" ? biomarkerSummary(bio.data.panel, bio.data.results, today) : null), [bio, today]);
  const sup = useMemo(() => (sups?.status === "ok" ? supplementSummary(sups.data.sups, sups.data.schedules, sups.data.intakes, today) : null), [sups, today]);
  const race = races?.status === "ok" ? nextRace(races.data, today) : null;
  const days = useMemo(() => fiveDays({
    today, tz, races: races?.status === "ok" ? races.data : [], acts: acts?.status === "ok" ? acts.data : [], strength: strength?.status === "ok" ? strength.data : [],
    activeWorkout: active, sups: sups?.status === "ok" ? sups.data.sups : [], schedules: sups?.status === "ok" ? sups.data.schedules : [], supToday: sup,
    planned: planned?.status === "ok" ? planned.data.map((p) => ({ ...p, linked: p.completed_activity_id !== null || p.completed_strength_session_id !== null })) : [],
  }), [today, tz, races, acts, strength, active, sups, sup, planned]);

  const name = formatDisplayName(profile?.display_name);   // a clean first name, or none: the stored value is never shown raw
  const { choice: chosenExperience } = useExperience();
  const { lens, basis } = resolveExperience(chosenExperience, primaryGoal);
  const allLines = w ? overview({ w, e, st, sup, race, today }) : [];
  const openQuick = (tab: QuickTab) => setQuick({ open: true, tab });
  const wellnessProblem = daily?.status === "unavailable" ? daily.reason : null;
  const action = nextAction({ w, loading: daily === null, activeWorkout: active, sup, problem: wellnessProblem });
  // The overview's first line is always about wellness. When the Next step card is already asking for it, that line is not repeated.
  const lines = w?.state === "missing" && action.kind === "log-wellness" ? allLines.slice(1) : allLines;
  const load = (x: Section<unknown> | null): LoadState => (x === null ? "loading" : x.status === "ok" ? "ok" : "unavailable");
  const hasStrength = !!st?.last || !!active, hasSupplements = !!sup && sup.active > 0;
  // A detail card whose data loaded fine but is empty is not drawn (it would only repeat an empty message): the setup area lists it, quietly.
  // A card that could not load, or has not loaded yet, is always drawn, so errors and loading are never hidden.
  const hidden: Record<SectionKey, boolean> = {
    wellness: false,
    endurance: acts?.status === "ok" && (!e || !e.last),
    strength: strength?.status === "ok" && !hasStrength,
    race: races?.status === "ok" && !race,
    biomarkers: bio?.status === "ok" && !b,
    supplements: sups?.status === "ok" && !hasSupplements,
  };
  const setup = setupModel({
    wellness: load(daily), wellnessMissing: w?.state === "missing", hasSleepReading: !!w?.sleep, sleepGoalH: goal,
    activities: load(acts), hasActivity: acts?.status === "ok" && acts.data.length > 0, strength: load(strength), hasStrength, intervalsConnected: intervals || !intervalsKnown,
    race: load(races), hasRace: !!race, biomarkers: load(bio), hasBiomarkers: !!b, supplements: load(sups), hasSupplements,
  });
  const cards: Record<SectionKey, React.ReactNode> = {
    wellness: <WellnessCard s={daily ?? LOADING} w={w} today={today} goal={goal} onLog={() => openQuick("wellness")} quiet={action.kind === "log-wellness" || action.kind === "data-unavailable"} guidanceAbove={action.kind === "readiness-guidance"} key="wellness" />,
    endurance: <EnduranceCard s={acts ?? LOADING} e={e} today={today} key="endurance" />,
    strength: <StrengthCard s={strength ?? LOADING} st={st} today={today} active={active} key="strength" />,
    race: <RaceCard s={races ?? LOADING} race={race} today={today} key="race" />,
    supplements: <SupplementsCard s={sups ?? LOADING} sup={sup} onLog={() => openQuick("supplements")} key="supplements" />,
    biomarkers: <BiomarkersCard s={bio ?? LOADING} b={b} today={today} key="biomarkers" />,
  };
  // The global Quick actions button (components/omni) opens this same Quick log drawer: by event when Today is already open, or through
  // ?quick=wellness|supplements when arriving from another page (read once, then removed from the address).
  useEffect(() => {
    const q = quickFromSearch(window.location.search);
    if (q) { setQuick({ open: true, tab: q }); window.history.replaceState(null, "", window.location.pathname); }
    const run = (e: Event) => {
      const id = (e as CustomEvent<OmniRunDetail>).detail?.id;
      if (id === "log-wellness") setQuick({ open: true, tab: "wellness" }); else if (id === "log-supplements") setQuick({ open: true, tab: "supplements" });
    };
    window.addEventListener(OMNI_RUN_EVENT, run);
    return () => window.removeEventListener(OMNI_RUN_EVENT, run);
  }, []);
  const view = trend.slice(-trendRange);
  const hasLoad = trend.some((p) => p.load > 0);

  return (
    <>
      <header className="td-hero">
        <div>
          <div className="eyebrow">{longDate(today)}{profile?.timezone && profile.timezone !== deviceZone() ? ` · ${tz}` : ""}</div>
          <h1 className="td-hello">{greeting(hourIn(now, tz))}{name ? `, ${name}` : ""}.</h1>
          {lines.length > 0 ? <ul className="td-overview">{lines.map((l) => <li key={l}>{l}</li>)}</ul> : <p className="td-meta">{daily ? "" : "Loading your day…"}</p>}
          <p className="td-meta td-lens">
            {primaryGoal === undefined ? "" : basis === "chosen" ? <>{LENS_LABEL[lens]} experience, chosen in <Link href="/profile#profile-experience">Profile</Link>. Every module is still below.</> : basis === "goal" ? <>{LENS_LABEL[lens]} view, based on your goal in <Link href="/profile">Profile</Link>.</> : <>{LENS_LABEL[lens]} view (default). <Link href="/profile#profile-experience">Choose an experience in Profile</Link> to arrange Today for you.</>}
          </p>
        </div>
      </header>

      <NextActionCard a={action} onAction={(k) => openQuick(k === "log-supplements" ? "supplements" : "wellness")} />
      <KeyMetrics lens={lens} nextKind={action.kind} setup={setup} loading={daily === null} input={{ w, wellnessProblem, e, st, whoop, sleepGoalH: goal, today }} />
      <SectionHeader title="Today in detail" />

      <div className="td-bento">
        {LENS_SECTIONS[lens].filter((k) => !hidden[k]).map((k) => cards[k])}
      </div>

      <FiveDay days={days} />
      <CoachInsight s={coach ?? LOADING} today={today} tz={tz} onSaved={() => void loadLatestDaily().then(setCoach)} />

      <details className="td-trends">
        <summary>Trends: HRV and training load</summary>
        <div className="row" role="group" aria-label="Trend range" style={{ margin: "12px 0" }}>
          {([14, 30] as const).map((r) => <button key={r} type="button" className={trendRange === r ? "chip on" : "chip"} aria-pressed={trendRange === r} onClick={() => setTrendRange(r)}>{r} days</button>)}
        </div>
        <div className="charts">
          <TrendChart title="HRV (ms) · gaps are days without a measurement" days={view.map((p) => p.day)} lines={[{ label: "HRV", color: "var(--green)", values: view.map((p) => p.hrv) }]} />
          {hasLoad ? (
            <TrendChart title="Fitness, fatigue and form (model)" days={view.map((p) => p.day)} zero lines={[
              { label: "CTL fitness", color: "var(--blue)", values: view.map((p) => p.ctl) },
              { label: "ATL fatigue", color: "var(--amber)", values: view.map((p) => p.atl) },
              { label: "TSB form", color: "var(--green)", values: view.map((p) => p.tsb), dashed: true },
            ]} />
          ) : <div className="card chart"><b>Fitness, fatigue and form</b><p className="td-meta">Needs activities with a training load.</p></div>}
        </div>
      </details>

      {session && (
        <QuickLog open={quick.open} tab={quick.tab} onTab={(t) => setQuick({ open: true, tab: t })} onClose={() => setQuick((q) => ({ ...q, open: false }))}
          today={today} uid={session.user.id} sup={sup} intervalsConnected={intervals} activeWorkout={!!active}
          onChanged={() => { void loadDaily(today).then(setDaily); void loadSupplements(today).then(setSups); void loadActivities(today).then(setActs); }} />
      )}
    </>
  );
}
