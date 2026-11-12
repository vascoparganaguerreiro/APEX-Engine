"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import { todayIso } from "@/lib/dates";
import {
  EXPERIENCE, GOALS, SOURCE_LABEL, SPORT_CHOICES, SPORT_LABELS, ageFromBirth, buildProfilePatch, draftFromProfile, loadIntegrations, loadMeasured, loadProfile,
  parseHeightCm, parsePace, parseWeightKg, saveProfile, type Integrations, type Measured, type Profile, type ProfileDraft, type Source, type SourceField, type Units,
} from "@/lib/profile";
import GarminDeviceCard from "@/components/strength/GarminDeviceCard";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e));
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");
const deviceTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "UTC"; } };
const zones = (): string[] => { try { return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? []; } catch { return []; } };

export default function ProfilePage() {
  const { session } = useAuth();
  const today = todayIso();
  const [state, setState] = useState<{ profile: Profile; exists: boolean; migrated: boolean } | null>(null);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [measured, setMeasured] = useState<{ resting_hr: Measured | null; vo2max: Measured | null }>({ resting_hr: null, vo2max: null });
  const [integrations, setIntegrations] = useState<Integrations | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const sb = getSupabase();
      const [p, m, i] = await Promise.all([loadProfile(sb, session.user.id, deviceTz()), loadMeasured(sb), loadIntegrations(sb)]);
      setState(p); setDraft(draftFromProfile(p.profile)); setMeasured(m); setIntegrations(i); setError(null);
    } catch (e) { setError(errMsg(e)); }
  }, [session]);
  useEffect(() => { load(); }, [load]);

  const result = useMemo(() => (state && draft ? buildProfilePatch(state.profile, draft, new Date().toISOString(), today, state.migrated) : null), [state, draft, today]);
  const dirty = !!result && (result.error !== undefined || Object.keys(result.patch).length > 0);

  const edit = (p: Partial<ProfileDraft>) => { setOk(null); setDraft((d) => (d ? { ...d, ...p } : d)); };
  const text = (k: keyof ProfileDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => edit({ [k]: e.target.value } as Partial<ProfileDraft>);
  /** Typing over a value that was taken from Garmin or Intervals makes it a manual value again. */
  const valueField = (k: keyof ProfileDraft, f: SourceField) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const cur = draft?.sources[f];
    edit({ [k]: e.target.value, sources: { ...draft!.sources, ...(cur === undefined || cur === "garmin" || cur === "intervals" ? { [f]: "manual" as Source } : {}) } } as Partial<ProfileDraft>);
  };

  function changeUnits(e: React.ChangeEvent<HTMLSelectElement>) {
    if (!draft || !state) return;
    const to = e.target.value as Units;
    const h = parseHeightCm(draft), w = parseWeightKg(draft), pace = parsePace(draft.threshold_pace, draft.units);
    const tmp: Profile = { ...state.profile, height_cm: typeof h === "number" ? h : null, weight_kg: typeof w === "number" ? w : null, threshold_pace_s_per_km: typeof pace === "number" ? Math.round(pace) : null };
    const re = draftFromProfile(tmp, to);
    edit({ units: to, height_cm: re.height_cm, height_ft: re.height_ft, height_in: re.height_in, weight: re.weight, threshold_pace: re.threshold_pace });
  }

  function applyMeasured(f: "resting_hr" | "vo2max", m: Measured) {
    if (!draft || m.source === "unknown") return;
    const key = f === "resting_hr" ? "resting_hr" : "vo2max";
    if (draft[key].trim() !== "" && Number(draft[key]) !== m.value && !window.confirm(`Replace your current ${m.label} baseline (${draft[key]}) with ${m.value}?`)) return;
    edit({ [key]: String(m.value), sources: { ...draft.sources, [f]: m.source } } as Partial<ProfileDraft>);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!state || !draft || !session || !result) return;
    if (result.error) { setError(result.error); setOk(null); return; }
    if (Object.keys(result.patch).length === 0) { setError(null); setOk("Nothing to save: no field was changed."); return; }
    setSaving(true); setError(null); setOk(null);
    try { await saveProfile(getSupabase(), session.user.id, result.patch, state.exists); await load(); setOk("Profile saved."); }
    catch (x) { setError(errMsg(x)); } finally { setSaving(false); }
  }

  if (!state || !draft) {
    return <><div className="eyebrow">Account</div><h1>Profile</h1>{error ? <div className="notice error">{error}</div> : <p className="muted">Loading...</p>}</>;
  }
  const p = state.profile, imperial = draft.units === "imperial", locked = !state.migrated;
  const age = ageFromBirth(draft.birth_date.trim() || null, today);

  const sourceSel = (f: SourceField) => {
    const cur = draft.sources[f];
    if (state.profile[f] === null && !draftHasValue(draft, f)) return null;
    if (cur === "garmin" || cur === "intervals") return <small className="srcbadge">From {SOURCE_LABEL[cur]}</small>;
    return (
      <select className="srcsel" aria-label="Source of this value" value={cur ?? ""} disabled={locked} onChange={(e) => edit({ sources: { ...draft.sources, [f]: (e.target.value || undefined) as Source | undefined } })}>
        {!cur && <option value="">Source not recorded</option>}<option value="manual">Manual</option><option value="lab">Lab test</option>
      </select>
    );
  };
  const suggest = (f: "resting_hr" | "vo2max", m: Measured | null) => !m ? null : (
    <small className="muted">Latest daily {m.label}: <b>{m.value}</b> on {m.day} ({m.source === "unknown" ? "source unknown" : SOURCE_LABEL[m.source]}){" "}
      {m.source !== "unknown" && <button type="button" className="linkbtn" onClick={() => applyMeasured(f, m)} disabled={locked}>Use as baseline</button>}</small>
  );
  return (
    <>
      <div className="eyebrow">Account</div>
      <h1>Profile</h1>
      <p className="muted small">Your private baselines. Daily measurements such as HRV, daily resting heart rate and sleep stay in your daily data and are never copied here automatically. Everything on this page is optional.</p>
      {error && <div className="notice error">{error}</div>}
      {ok && <div className="notice ok">{ok}</div>}
      {locked && <div className="notice">The extra profile fields need a database update (migration 11) that has not been applied yet. Name, units, time zone, body measurements, max heart rate, FTP and sleep goal still work.</div>}

      <form onSubmit={save}>
        <section className="card psec">
          <h2>Personal information</h2>
          <div className="formgrid">
            <label>Display name<input value={draft.display_name} maxLength={60} onChange={text("display_name")} placeholder="optional" /></label>
            <label>Date of birth{age !== null && <small>{age} years old</small>}<input type="date" value={draft.birth_date} max={today} onChange={text("birth_date")} disabled={locked} /></label>
            {imperial ? (
              <label>Height (ft / in)<span className="row"><input inputMode="numeric" value={draft.height_ft} onChange={text("height_ft")} placeholder="ft" style={{ width: "50%" }} /><input inputMode="decimal" value={draft.height_in} onChange={text("height_in")} placeholder="in" style={{ width: "50%" }} /></span>{sourceSel("height_cm")}</label>
            ) : (
              <label>Height (cm)<input inputMode="decimal" value={draft.height_cm} onChange={valueField("height_cm", "height_cm")} placeholder="optional" />{sourceSel("height_cm")}</label>
            )}
            <label>Body weight ({imperial ? "lb" : "kg"})<input inputMode="decimal" value={draft.weight} onChange={valueField("weight", "weight_kg")} placeholder="optional" />{sourceSel("weight_kg")}</label>
            <label>Body fat (%)<input inputMode="decimal" value={draft.body_fat} onChange={valueField("body_fat", "body_fat_pct")} placeholder="optional" disabled={locked} />{sourceSel("body_fat_pct")}</label>
          </div>
          <div style={{ marginTop: 6 }}>
            <small className="muted">Preferred sports</small>
            <div className="row" role="group" aria-label="Preferred sports" style={{ marginTop: 6 }}>
              {SPORT_CHOICES.map((sp) => {
                const on = draft.preferred_sports.includes(sp);
                return <button key={sp} type="button" disabled={locked} className={on ? "chip on" : "chip"} aria-pressed={on}
                  onClick={() => edit({ preferred_sports: on ? draft.preferred_sports.filter((x) => x !== sp) : SPORT_CHOICES.filter((x) => x === sp || draft.preferred_sports.includes(x)) })}>{SPORT_LABELS[sp]}</button>;
              })}
            </div>
          </div>
          <div className="formgrid" style={{ marginTop: 14 }}>
            <label>Primary training goal<select value={draft.primary_goal} onChange={text("primary_goal")} disabled={locked}><option value="">Not set</option>{GOALS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}</select></label>
            <label>Goal notes<input value={draft.goal_notes} maxLength={500} onChange={text("goal_notes")} placeholder="optional" disabled={locked} /></label>
          </div>
        </section>

        <section className="card psec">
          <h2>Physiological profile</h2>
          <p className="muted small" style={{ marginTop: 0 }}>These are baselines you set or confirm. Each value shows where it came from. Nothing is estimated for you, and imported values are only used when you choose &quot;Use as baseline&quot;.</p>
          <div className="formgrid">
            <label>Resting heart rate baseline (bpm)<input inputMode="numeric" value={draft.resting_hr} onChange={valueField("resting_hr", "resting_hr")} placeholder="optional" disabled={locked} />{sourceSel("resting_hr")}{suggest("resting_hr", measured.resting_hr)}</label>
            <label>Maximum heart rate (bpm)<input inputMode="numeric" value={draft.max_hr} onChange={valueField("max_hr", "max_hr")} placeholder="optional" />{sourceSel("max_hr")}</label>
            <label>VO2 max (ml/kg/min)<input inputMode="decimal" value={draft.vo2max} onChange={valueField("vo2max", "vo2max")} placeholder="optional" disabled={locked} />{sourceSel("vo2max")}{suggest("vo2max", measured.vo2max)}</label>
            <label>Lactate threshold heart rate (bpm)<input inputMode="numeric" value={draft.lthr} onChange={valueField("lthr", "lthr")} placeholder="optional" disabled={locked} />{sourceSel("lthr")}</label>
            <label>Threshold pace (min per {imperial ? "mile" : "km"})<input value={draft.threshold_pace} onChange={valueField("threshold_pace", "threshold_pace_s_per_km")} placeholder="m:ss, optional" disabled={locked} />{sourceSel("threshold_pace_s_per_km")}</label>
            <label>FTP / threshold power (W)<input inputMode="numeric" value={draft.ftp_watts} onChange={valueField("ftp_watts", "ftp_watts")} placeholder="optional" />{sourceSel("ftp_watts")}</label>
            <label>Training experience<select value={draft.experience_level} onChange={text("experience_level")} disabled={locked}><option value="">Not set</option>{EXPERIENCE.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select></label>
          </div>
        </section>

        <section className="card psec">
          <h2>Training preferences</h2>
          <div className="formgrid">
            <label>Units<select value={draft.units} onChange={changeUnits}><option value="metric">Metric (km, kg, cm)</option><option value="imperial">Imperial (mi, lb, ft/in)</option></select></label>
            <label>Time zone<input list="tzlist" value={draft.timezone} onChange={text("timezone")} /><datalist id="tzlist">{zones().map((z) => <option key={z} value={z} />)}</datalist>
              {draft.timezone !== deviceTz() && <button type="button" className="linkbtn" onClick={() => edit({ timezone: deviceTz() })}>Use this device&apos;s time zone ({deviceTz()})</button>}</label>
            <label>Sleep goal (hours)<input inputMode="decimal" value={draft.sleep_goal_h} onChange={text("sleep_goal_h")} /></label>
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>Notifications are not available yet, so there is nothing to configure. Units apply to this page; races and other modules keep the units you enter there.</p>
        </section>

        <div className="row savebar">
          <button className="btn" type="submit" disabled={saving || !dirty}>{saving ? "Saving..." : "Save changes"}</button>
          <span className="muted small">{dirty ? "You have unsaved changes." : "All changes saved."}</span>
          {dirty && <button className="btn ghost" type="button" onClick={() => { setDraft(draftFromProfile(state.profile)); setError(null); setOk(null); }}>Discard</button>}
        </div>
      </form>

      <section className="card psec">
        <h2>Integrations</h2>
        {!integrations ? <p className="muted small">Loading...</p> : (
          <div className="intlist">
            <div className="doserow"><b>Intervals.icu</b>
              <span className={integrations.intervals.connected ? "badge" : "badge off"}>{integrations.intervals.connected ? "Connected" : "Not connected"}</span>
              <span className="muted small">{integrations.intervals.connected ? `Athlete ${integrations.intervals.athlete_id ?? ""} · last sync ${fmtDate(integrations.intervals.last_sync_at)}` : "Connect it to import activities and wellness."}</span>
              <Link className="chip" href="/import" style={{ marginLeft: "auto" }}>{integrations.intervals.connected ? "Manage" : "Connect"}</Link></div>
            <div className="doserow"><b>Garmin history</b>
              <span className={integrations.garmin ? "badge" : "badge off"}>{integrations.garmin ? "Data found" : "No data"}</span>
              <span className="muted small">{integrations.garmin ? `Latest day ${integrations.garmin.latest}` : "No Garmin-labelled daily data in your account."}</span></div>
            <div className="doserow"><b>Laboratory reports</b>
              <span className={integrations.labs ? "badge" : "badge off"}>{integrations.labs ? `${integrations.labs.count} blood test${integrations.labs.count === 1 ? "" : "s"}` : "None yet"}</span>
              <span className="muted small">{integrations.labs ? `Latest ${integrations.labs.latest}` : "Add blood tests under Biomarkers."}</span>
              <Link className="chip" href="/biomarkers" style={{ marginLeft: "auto" }}>Open</Link></div>
            <div className="doserow"><b>Manual entry</b><span className="badge">Always available</span><span className="muted small">Log days on Today, races, supplements and blood tests.</span></div>
          </div>
        )}
        <p className="muted small" style={{ marginBottom: 0 }}>Connection details are shown without any credentials. Keys are stored encrypted on the server and never sent to this page.{" "}
          <Link href="/integrations" style={{ color: "var(--green)" }}>Open the Connectivity Centre</Link> for WHOOP, Garmin, COROS, Polar, Suunto, Oura, Apple Health, Samsung Health and Strava.</p>
      </section>

      {session && <GarminDeviceCard uid={session.user.id} intervals={integrations ? integrations.intervals : null} />}

      <section className="card psec">
        <h2>Account</h2>
        <div className="metrics">
          <div><small>Email</small><b style={{ fontSize: 15, wordBreak: "break-all" }}>{session?.user.email ?? "n/a"}</b></div>
          <div><small>Member since</small><b>{session?.user.created_at ? new Date(session.user.created_at).toLocaleDateString() : "n/a"}</b></div>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>Your profile is private: only you can read or change it.</p>
      </section>
    </>
  );
}

function draftHasValue(d: ProfileDraft, f: SourceField): boolean {
  const m: Record<SourceField, string> = {
    weight_kg: d.weight, height_cm: d.units === "metric" ? d.height_cm : `${d.height_ft}${d.height_in}`, body_fat_pct: d.body_fat, resting_hr: d.resting_hr,
    max_hr: d.max_hr, vo2max: d.vo2max, lthr: d.lthr, threshold_pace_s_per_km: d.threshold_pace, ftp_watts: d.ftp_watts,
  };
  return m[f].trim() !== "";
}