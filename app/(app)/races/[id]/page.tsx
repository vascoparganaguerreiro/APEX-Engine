"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import { todayIso } from "@/lib/dates";
import { PRIORITY_LABEL, STATUS_LABEL, countdown, deleteRace, formatDate, formatDistance, formatDuration, getRaceCompat, isRaceId, updateRace, type Race, type RaceInput } from "@/lib/races";
import RaceForm from "@/components/races/RaceForm";
import { PriorityPill, raceMeta } from "@/components/races/RaceBits";
import { friendlyError, friendlyMessage } from "@/lib/userError";

const errMsg = (e: unknown) => friendlyMessage(e, "That could not be completed", { scope: "races.detail" });

export default function RaceDetailPage() {
  const { session } = useAuth();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const today = todayIso();
  const [race, setRace] = useState<Race | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [legacy, setLegacy] = useState(false);             // only the original race fields are stored on this account (confirmed missing columns)
  const [retryable, setRetryable] = useState(false);

  const load = useCallback(async () => {
    if (!isRaceId(id)) { setError("This race was not found."); setRetryable(false); setLoaded(true); return; }
    try {
      const r = await getRaceCompat(getSupabase(), Number(id));
      if (!r.race) { setError("This race was not found."); setRetryable(false); } else { setRace(r.race); setLegacy(r.legacy); setError(null); }
    } catch (e) {
      const u = friendlyError(e, "This race could not be loaded", { scope: "races.detail.load" });
      setError(u.message); setRetryable(u.retryable);
    } finally { setLoaded(true); }
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
      {error && (
        <div className="notice error" role="alert">{error}
          {retryable && <> <button className="btn ghost" onClick={() => { setError(null); setLoaded(false); void load(); }}>Try again</button></>}
        </div>
      )}
      {race && c && legacy && !editing && <div className="notice">Location, distance, target time and status aren&apos;t set up on your account yet, so they can&apos;t be shown or saved.</div>}
      {race && c && (editing ? (
        <RaceForm initial={race} today={today} legacy={legacy} onCancel={() => setEditing(false)}
          onSave={async (i: RaceInput) => {
            try { await updateRace(getSupabase(), race.id, i, { legacy }); } catch (e) { if (friendlyError(e).kind === "not-set-up") await load(); throw e; }
            setEditing(false); await load();
          }} />
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
              {!legacy && <><small className="muted" style={{ display: "block", marginTop: 8 }}>Status</small>
              <b>{STATUS_LABEL[race.status]}</b></>}
            </div>
          </div>
          <div className="card" style={{ marginTop: 14 }}>
            <div className="metrics">
              <div><small>Date</small><b>{formatDate(race.race_date)}</b></div>
              <div><small>Event</small><b>{raceMeta(race)}</b></div>
              {!legacy && <div><small>Location</small><b>{race.location ?? "Not set"}</b></div>}
              {!legacy && <div><small>Distance</small><b>{formatDistance(race.distance, race.distance_unit) || "Not set"}</b></div>}
              {!legacy && <div><small>Target finish time</small><b>{formatDuration(race.target_time_s) || "Not set"}</b></div>}
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