"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import { todayIso } from "@/lib/dates";
import { PRIORITY_LABEL, STATUS_LABEL, countdown, deleteRace, formatDate, formatDistance, formatDuration, getRace, isRaceId, updateRace, type Race, type RaceInput } from "@/lib/races";
import RaceForm from "@/components/races/RaceForm";
import { PriorityPill, raceMeta } from "@/components/races/RaceBits";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function RaceDetailPage() {
  const { session } = useAuth();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const today = todayIso();
  const [race, setRace] = useState<Race | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!isRaceId(id)) { setError("This race was not found."); setLoaded(true); return; }
    try {
      const r = await getRace(getSupabase(), Number(id));
      if (!r) setError("This race was not found."); else { setRace(r); setError(null); }
    } catch (e) { setError(errMsg(e)); } finally { setLoaded(true); }
  }, [id]);
  useEffect(() => { if (session) load(); }, [session, load]);

  async function remove() {
    if (!race || !window.confirm(`Delete "${race.name}" (${formatDate(race.race_date)})? This cannot be undone.`)) return;
    try { await deleteRace(getSupabase(), race.id); router.push("/races"); } catch (e) { setError(errMsg(e)); }
  }

  const c = race ? countdown(race.race_date, today) : null;
  return (
    <>
      <div className="eyebrow"><Link href="/races" style={{ color: "inherit" }}>&larr; Races</Link></div>
      {!loaded && !error && <p className="muted">Loading...</p>}
      {error && <div className="notice error">{error}</div>}
      {race && c && (editing ? (
        <RaceForm initial={race} today={today} onCancel={() => setEditing(false)}
          onSave={async (i: RaceInput) => { await updateRace(getSupabase(), race.id, i); setEditing(false); await load(); }} />
      ) : (
        <>
          <h1>{race.name}</h1>
          <div className="racehero">
            <div className="card herocard">
              <small className="muted">{c.past ? "Race date" : "Countdown"}</small>
              <div className="herodays">{c.label}</div>
              <div className="muted small">{c.detail || formatDate(race.race_date)}</div>
            </div>
            <div className="card herocard">
              <small className="muted">Priority</small>
              <div style={{ marginTop: 6 }}><PriorityPill p={race.priority} /> <b>{PRIORITY_LABEL[race.priority]}</b></div>
              <small className="muted" style={{ display: "block", marginTop: 8 }}>Status</small>
              <b>{STATUS_LABEL[race.status]}</b>
            </div>
          </div>
          <div className="card" style={{ marginTop: 14 }}>
            <div className="metrics">
              <div><small>Date</small><b>{formatDate(race.race_date)}</b></div>
              <div><small>Event</small><b>{raceMeta(race)}</b></div>
              <div><small>Location</small><b>{race.location ?? "Not set"}</b></div>
              <div><small>Distance</small><b>{formatDistance(race.distance, race.distance_unit) || "Not set"}</b></div>
              <div><small>Target finish time</small><b>{formatDuration(race.target_time_s) || "Not set"}</b></div>
            </div>
            <p className="small"><b>Personal goal:</b> {race.goal ?? <span className="muted">Not set</span>}</p>
            <p className="small" style={{ whiteSpace: "pre-wrap" }}><b>Notes:</b> {race.notes ?? <span className="muted">None</span>}</p>
            <p className="muted small" style={{ marginBottom: 0 }}>APEX shows only what you entered. It does not predict results.</p>
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn" onClick={() => setEditing(true)}>Edit</button>
            <button className="btn ghost" onClick={remove}>Delete</button>
          </div>
        </>
      ))}
    </>
  );
}