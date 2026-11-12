"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import { todayIso } from "@/lib/dates";
import {
  SPORTS, SPORT_LABEL, countdown, createRace, deleteRace, filterRaces, formatDate, goalRace, listRacesCompat, monthGroups, nextRace, splitRaces, updateRace,
  type Race, type RaceInput, type Sport,
} from "@/lib/races";
import EmptyState from "@/components/ui/EmptyState";
import { EMPTY } from "@/lib/emptyStates";
import RaceForm from "@/components/races/RaceForm";
import { PriorityPill, RaceSummary, raceMeta } from "@/components/races/RaceBits";
import { friendlyError, friendlyMessage } from "@/lib/userError";

const errMsg = (e: unknown) => friendlyMessage(e, "That could not be completed", { scope: "races" });

export default function RacesPage() {
  const { session } = useAuth();
  const today = todayIso();
  const [races, setRaces] = useState<Race[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; retryable: boolean } | null>(null);   // the list could not be read: nothing else is offered
  const [legacy, setLegacy] = useState(false);       // the account stores only the original race fields (confirmed missing columns, never a guess)
  const [q, setQ] = useState("");
  const [sport, setSport] = useState<Sport | "all">("all");
  const [view, setView] = useState<"list" | "timeline">("list");
  const [editing, setEditing] = useState<Race | "new" | null>(null);
  const [defaultUnit, setDefaultUnit] = useState<"km" | "mi">("km");

  const load = useCallback(async () => {
    try {
      const r = await listRacesCompat(getSupabase());
      setRaces(r.races); setLegacy(r.legacy); setError(null); setLoadError(null);
    } catch (e) {
      const u = friendlyError(e, "Your races could not be loaded", { scope: "races.load" });
      setLoadError({ message: u.message, retryable: u.retryable });
    }
  }, []);
  useEffect(() => { if (session) load(); }, [session, load]);
  // The profile's unit preference only sets the default distance unit of a NEW race; failures just keep "km".
  useEffect(() => {
    if (!session) return;
    getSupabase().from("profiles").select("units").maybeSingle().then(({ data }) => setDefaultUnit(data?.units === "imperial" ? "mi" : "km"), () => setDefaultUnit("km"));
  }, [session]);

  const all = races ?? [];
  const next = useMemo(() => nextRace(all, today), [all, today]);
  const goal = useMemo(() => goalRace(all, today), [all, today]);
  const filtered = useMemo(() => filterRaces(all, q, sport), [all, q, sport]);
  const { upcoming, past } = useMemo(() => splitRaces(filtered, today), [filtered, today]);

  async function save(input: RaceInput, existing: Race | null) {
    const sb = getSupabase();
    try {
      if (existing) await updateRace(sb, existing.id, input, { legacy }); else await createRace(sb, session!.user.id, input, { legacy });
    } catch (e) {
      if (friendlyError(e).kind === "not-set-up") await load();      // the account turned out to store fewer fields than assumed: re-read it
      throw e;
    }
    setEditing(null); await load();
  }
  async function remove(r: Race) {
    if (!window.confirm(`Delete "${r.name}" (${formatDate(r.race_date)})? This cannot be undone.`)) return;
    try { await deleteRace(getSupabase(), r.id); await load(); } catch (e) { setError(errMsg(e)); }
  }

  function card(r: Race, dim = false) {
    if (editing !== null && editing !== "new" && editing.id === r.id) {
      return <RaceForm key={`edit-${r.id}`} initial={r} today={today} legacy={legacy} onSave={(i) => save(i, r)} onCancel={() => setEditing(null)} />;
    }
    return (
      <article key={r.id} className={`card racecard prio-border-${r.priority}${dim ? " dim" : ""}`}>
        <RaceSummary r={r} today={today} />
        <div className="row">
          <Link className="btn ghost" href={`/races/${r.id}`}>Details</Link>
          <button className="btn ghost" onClick={() => setEditing(r)}>Edit</button>
          <button className="btn ghost" onClick={() => remove(r)}>Delete</button>
        </div>
      </article>
    );
  }

  const nextCd = next ? countdown(next.race_date, today) : null;
  const goalCd = goal ? countdown(goal.race_date, today) : null;

  return (
    <>
      <div className="eyebrow">Season</div>
      <h1>Races</h1>
      {loadError && (
        <div className="notice error" role="alert">{loadError.message}
          {loadError.retryable && <> <button className="btn ghost" onClick={() => { setLoadError(null); void load(); }}>Try again</button></>}
        </div>
      )}
      {error && <div className="notice error">{error}</div>}
      {races === null && !error && !loadError && <p className="muted">Loading...</p>}
      {races !== null && legacy && (
        <div className="notice">Your races are shown with their basic details. Location, distance, target time and status aren&apos;t set up on your account yet, so they can&apos;t be shown or saved. You can still add and edit the name, date, sport, format, priority, goal and notes.</div>
      )}

      {races !== null && (
        <>
          {editing === "new"
            ? <RaceForm key="new" today={today} defaultUnit={defaultUnit} legacy={legacy} onSave={(i) => save(i, null)} onCancel={() => setEditing(null)} />
            : all.length > 0 && <button className="btn" onClick={() => setEditing("new")}>+ Add race</button>}

          {all.length === 0 && !editing && <EmptyState copy={EMPTY.races} headingLevel={2} onAction={() => setEditing("new")} />}

          {all.length > 0 && (
            <div className="racehero">
              <div className="card herocard">
                <small className="muted">Next race</small>
                {next && nextCd ? (
                  <>
                    <div className="herodays">{nextCd.days === 0 ? "Today" : nextCd.days}<small>{nextCd.days > 0 ? (nextCd.days === 1 ? " day" : " days") : ""}</small></div>
                    <div><PriorityPill p={next.priority} /> <b>{next.name}</b></div>
                    <div className="muted small">{formatDate(next.race_date)}{next.location ? ` · ${next.location}` : ""}</div>
                  </>
                ) : <p className="muted small">No upcoming race. Add one to start a countdown.</p>}
              </div>
              <div className="card herocard goal">
                <small className="muted">Main goal race (A)</small>
                {goal && goalCd ? (
                  <>
                    <div className="herodays">{goalCd.days === 0 ? "Today" : goalCd.days}<small>{goalCd.days > 0 ? (goalCd.days === 1 ? " day" : " days") : ""}</small></div>
                    <div><b>{goal.name}</b></div>
                    <div className="muted small">{raceMeta(goal)}{goal.goal ? ` · ${goal.goal}` : ""}</div>
                  </>
                ) : <p className="muted small">No upcoming A race. Mark a race as priority A to make it your main goal.</p>}
              </div>
            </div>
          )}

          {all.length > 0 && (
            <>
              <div className="card formgrid" style={{ margin: "14px 0" }}>
                <label>Search<input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="name or location" /></label>
                <label>Sport
                  <select value={sport} onChange={(e) => setSport(e.target.value as Sport | "all")}>
                    <option value="all">All sports</option>{SPORTS.map((s) => <option key={s} value={s}>{SPORT_LABEL[s]}</option>)}
                  </select>
                </label>
                <div className="row" role="group" aria-label="View">
                  <button className={view === "list" ? "chip on" : "chip"} aria-pressed={view === "list"} onClick={() => setView("list")}>List</button>
                  <button className={view === "timeline" ? "chip on" : "chip"} aria-pressed={view === "timeline"} onClick={() => setView("timeline")}>Timeline</button>
                </div>
              </div>

              {filtered.length === 0 && <div className="notice">No races match these filters.</div>}

              {view === "list" ? (
                <>
                  {upcoming.length > 0 && <><h2>Upcoming ({upcoming.length})</h2>{upcoming.map((r) => card(r))}</>}
                  {past.length > 0 && <><h2>Completed and past ({past.length})</h2>{past.map((r) => card(r, true))}</>}
                </>
              ) : (
                monthGroups(filtered).map(([month, list]) => (
                  <section key={month}>
                    <h2 style={{ fontSize: 18 }}>{month}</h2>
                    <div className="card">
                      {list.map((r) => {
                        const c = countdown(r.race_date, today);
                        return (
                          <Link key={r.id} href={`/races/${r.id}`} className={`doserow${c.past || !["planned", "registered"].includes(r.status) ? " off" : ""}`} style={{ textDecoration: "none", color: "inherit" }}>
                            <span className="muted small tl-date">{r.race_date}</span><PriorityPill p={r.priority} />
                            <span><b>{r.name}</b> <span className="muted small">{raceMeta(r)}</span></span>
                            <span className="small" style={{ marginLeft: "auto" }}>{c.label}</span>
                          </Link>
                        );
                      })}
                    </div>
                  </section>
                ))
              )}
            </>
          )}
        </>
      )}
    </>
  );
}