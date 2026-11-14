"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import { extractReport, removeUnusedLabReports, uploadLabReport } from "@/lib/api";
import { todayIso } from "@/lib/dates";
import { errMsg, loadPanels } from "@/lib/health/load";
import { isUuid, normalizeMarker, rangeStatus, resultKey, reviewBlocked, seriesKey, validatePanelDate, validateResult, type Panel, type Result } from "@/lib/health/core";
import { REPORT_EXT as EXT, REPORT_MAX_BYTES as MAX_BYTES, reportPath } from "@/lib/health/report";
import ResultForm, { type ResultDraft } from "@/components/health/ResultForm";

const STATUS_TEXT = { below: "Below lab range", within: "Within lab range", above: "Above lab range", unknown: "No range printed" } as const;
const STATUS_CLASS = { below: "st-low", within: "st-ok", above: "st-high", unknown: "st-na" } as const;
interface Pending { draft: ResultDraft; include: boolean; source: "manual" | "document" }
interface Picked { f: File; sha: string; path: string }

async function sha256Hex(file: File): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const dbError = (e: unknown) => ((e as { code?: string })?.code === "23505" ? "That marker with that unit is already in this blood test (or this report was already imported)." : errMsg(e));
const toRow = (d: ResultDraft) => ({ original_name: d.original_name, marker_key: normalizeMarker(d.original_name)?.key ?? null, value: d.value, unit: d.unit, ref_low: d.ref_low, ref_high: d.ref_high, flag: d.flag });

export default function PanelPage() {
  const { session } = useAuth();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const isNew = id === "new";
  const [meta, setMeta] = useState({ date: todayIso(), lab: "", notes: "" });
  const [panel, setPanel] = useState<Panel | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [editRow, setEditRow] = useState<string | number | null>(null);
  const [file, setFile] = useState<Picked | null>(null);
  const [consent, setConsent] = useState(false);
  const [checked, setChecked] = useState(false);
  const [reading, setReading] = useState(false);
  const [info, setInfo] = useState<{ skipped: string[]; fromDoc: boolean } | null>(null);
  const [dup, setDup] = useState<{ id: string; collected_on: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sameDay, setSameDay] = useState<string[]>([]);      // existing tests on the chosen date (soft duplicate warning)
  const validId = isNew || isUuid(id);

  // Uploaded report objects. The browser uploads straight to private storage ("<uid>/<sha256>.<ext>") before reading,
  // so the same object is reused when saving. Only objects this page created itself are ever cleaned up; one that
  // already existed may belong to a saved blood test, and one a saved test references is never removed.
  const created = useRef(new Set<string>());     // objects this page stored itself
  const stored = useRef(new Set<string>());      // objects known to be in storage (created here or already there)
  const current = useRef<string | null>(null);   // path of the file currently selected (null: none / page left)
  const cleaning = useRef<Promise<void>>(Promise.resolve());

  /** Remove objects this page created that are no longer wanted. Keeps the selected file unless it is `drop`.
   *  Runs one at a time, and uploads wait for it, so a removal never races a re-upload of the same file. */
  const cleanup = useCallback((drop?: string) => {
    const run = async () => {
      const keep = current.current === drop ? [] : [current.current];
      const removed = await removeUnusedLabReports(created.current, keep).catch(() => [] as string[]);
      for (const p of removed) { created.current.delete(p); stored.current.delete(p); }
    };
    cleaning.current = cleaning.current.then(run, run);
    return cleaning.current;
  }, []);
  async function ensureUploaded(p: Picked) {
    await cleaning.current;
    if (stored.current.has(p.path)) return;
    if ((await uploadLabReport(p.path, p.f)) === "created") created.current.add(p.path);
    stored.current.add(p.path);
  }
  // Leaving the page within the app removes an unsaved upload. (Closing the tab or reloading cannot be covered reliably.)
  useEffect(() => () => { current.current = null; void cleanup(); }, [cleanup]);

  const load = useCallback(async () => {
    if (isNew) return;
    if (!validId) { setError("This blood test was not found."); return; }
    const sb = getSupabase();
    const [p, r] = await Promise.all([
      sb.from("blood_panels").select("id,collected_on,lab_name,notes,source,report_path,report_filename").eq("id", id).maybeSingle(),
      sb.from("biomarker_results").select("id,panel_id,original_name,marker_key,value,unit,ref_low,ref_high,flag,source").eq("panel_id", id).order("original_name"),
    ]);
    if (p.error || r.error) { setError(errMsg(p.error ?? r.error)); return; }
    if (!p.data) { setError("This blood test was not found."); return; }
    setPanel(p.data as Panel); setMeta({ date: p.data.collected_on, lab: p.data.lab_name ?? "", notes: p.data.notes ?? "" });
    setResults(((r.data ?? []) as Result[]).map((x) => ({ ...x, value: Number(x.value), ref_low: x.ref_low === null ? null : Number(x.ref_low), ref_high: x.ref_high === null ? null : Number(x.ref_high) })));
  }, [id, isNew, validId]);
  useEffect(() => { if (session) load(); }, [session, load]);
  useEffect(() => {
    if (session && isNew) loadPanels().then((p) => setSameDay(p.filter((x) => x.collected_on === meta.date).map((x) => x.id))).catch(() => setSameDay([]));
  }, [session, isNew, meta.date]);

  // ------------------------------------------------------------ file + automatic reading (review before saving)
  async function pick(f: File | undefined) {
    // A different file invalidates anything read from the previous one and the consent given for it.
    setError(null); setDup(null); setInfo(null); setConsent(false); setChecked(false);
    setPending((p) => p.filter((x) => x.source !== "document")); setEditRow(null);
    current.current = null;
    const next = await prepare(f);
    current.current = next?.path ?? null; setFile(next);
    void cleanup();                                  // an upload of the previous file is no longer needed
  }
  async function prepare(f: File | undefined): Promise<Picked | null> {
    if (!f) return null;
    if (!EXT[f.type]) { setError("Only PDF, PNG, JPEG or WebP files are supported."); return null; }
    if (f.size > MAX_BYTES) { setError("The file is larger than 10 MB."); return null; }
    let sha: string;
    try { sha = await sha256Hex(f); }
    catch { setError("This browser could not prepare the file (a secure https connection is required)."); return null; }
    const path = session ? reportPath(session.user.id, sha, f.type) : null;
    if (!path) { setError("Please sign in again."); return null; }
    return { f, sha, path };
  }
  async function read() {
    if (!file) return;
    const path = file.path;
    setReading(true); setError(null); setDup(null);
    try {
      await ensureUploaded(file);
      const r = await extractReport(path);
      if (current.current !== path) { void cleanup(); return; }   // another file was picked meanwhile
      if (r.duplicate) { setDup(r.duplicate); void cleanup(path); return; }
      const x = r.extraction!;
      setMeta((m) => ({ ...m, date: x.collected_on ?? m.date, lab: m.lab || x.lab_name || "" }));
      setPending(x.results.map((e) => ({ draft: { original_name: e.original_name, value: e.value, unit: e.unit, ref_low: e.ref_low, ref_high: e.ref_high, flag: e.flag }, include: true, source: "document" })));
      setInfo({ skipped: x.skipped, fromDoc: true }); setChecked(false);
      if (!x.collected_on) setError("The collection date could not be read. Check the date below before saving.");
    } catch (e) { if (current.current === path) setError(errMsg(e)); else void cleanup(); } finally { setReading(false); }
  }

  // ------------------------------------------------------------ create
  async function saveNew() {
    setError(null);
    const dErr = validatePanelDate(meta.date, todayIso());
    if (dErr) { setError(dErr); return; }
    const rows = pending.filter((p) => p.include);
    for (const r of rows) { const v = validateResult(r.draft); if (v) { setError(v); return; } }
    const keys = rows.map((r) => resultKey(r.draft.original_name, r.draft.unit));
    if (new Set(keys).size !== keys.length) { setError("The same marker appears twice with the same unit. Remove or rename one."); return; }
    if (reviewBlocked(rows, checked)) { setError("Confirm that you checked the extracted values against the original report."); return; }
    setBusy(true);
    const sb = getSupabase();
    const path = file?.path ?? null;
    try {
      if (file) await ensureUploaded(file);         // reuses the object uploaded for reading, if any
      const { data, error: e } = await sb.rpc("save_blood_panel", {
        p_panel: { collected_on: meta.date, lab_name: meta.lab, notes: meta.notes, source: rows.some((r) => r.source === "document") ? "document" : "manual", report_path: path, report_filename: file?.f.name.slice(0, 200) ?? null, report_sha256: file?.sha ?? null },
        p_results: rows.map((r) => ({ ...toRow(r.draft), source: r.source })),
      });
      if (e) throw e;
      if (path) created.current.delete(path);       // now referenced by the saved blood test: never clean it up
      router.push(`/biomarkers/panels/${data as string}`);
    } catch (e) {
      if (path) await cleanup(path);                // no orphaned file after a failed save (only if this page uploaded it)
      setError(dbError(e)); setBusy(false);
    }
  }

  // ------------------------------------------------------------ edit existing
  async function saveMeta() {
    const dErr = validatePanelDate(meta.date, todayIso());
    if (dErr) { setError(dErr); return; }
    const { error: e } = await getSupabase().from("blood_panels").update({ collected_on: meta.date, lab_name: meta.lab.trim() || null, notes: meta.notes.trim() || null }).eq("id", id);
    if (e) setError(errMsg(e)); else { setError(null); setOk("Saved."); await load(); }
  }
  async function addResult(d: ResultDraft) {
    const { error: e } = await getSupabase().from("biomarker_results").insert({ panel_id: id, ...toRow(d), source: "manual" });
    if (e) throw new Error(dbError(e));
    await load();
  }
  async function updateResult(rid: string, d: ResultDraft) {
    const { error: e } = await getSupabase().from("biomarker_results").update(toRow(d)).eq("id", rid);
    if (e) throw new Error(dbError(e));
    setEditRow(null); await load();
  }
  async function removeResult(r: Result) {
    if (!window.confirm(`Delete ${r.original_name} (${r.value} ${r.unit}) from this blood test? This cannot be undone.`)) return;
    const { error: e } = await getSupabase().from("biomarker_results").delete().eq("id", r.id);
    if (e) setError(errMsg(e)); else await load();
  }
  async function openReport() {
    const w = window.open("", "_blank");            // opened synchronously so the browser does not treat it as a blocked popup
    const { data, error: e } = await getSupabase().storage.from("lab-reports").createSignedUrl(panel!.report_path!, 60);
    if (e || !data) { w?.close(); setError(e ? errMsg(e) : "Could not open the report."); return; }
    if (w) { w.opener = null; w.location.href = data.signedUrl; } else setError("Your browser blocked the new tab. Allow pop-ups for this site and try again.");
  }
  async function attachReport(f: File | undefined) {
    if (!f || !panel) return;
    setError(null); setOk(null);
    if (!EXT[f.type]) { setError("Only PDF, PNG, JPEG or WebP files are supported."); return; }
    if (f.size > MAX_BYTES) { setError("The file is larger than 10 MB."); return; }
    const sb = getSupabase();
    let uploaded: string | null = null;
    try {
      const sha = await sha256Hex(f);
      const path = session ? reportPath(session.user.id, sha, f.type) : null;
      if (!path) throw new Error("Please sign in again.");
      if ((await uploadLabReport(path, f)) === "created") uploaded = path;
      const { error: e } = await sb.from("blood_panels").update({ report_path: path, report_filename: f.name.slice(0, 200), report_sha256: sha }).eq("id", id);
      if (e) throw e;
      setOk("Report attached."); await load();
    } catch (e) {
      if (uploaded) await sb.storage.from("lab-reports").remove([uploaded]);
      setError((e as { code?: string })?.code === "23505" ? "This report is already attached to another blood test." : errMsg(e));
    }
  }
  async function removePanel() {
    if (!window.confirm("Delete this entire blood test and all its results? This cannot be undone.")) return;
    const sb = getSupabase();
    const { error: e } = await sb.from("blood_panels").delete().eq("id", id);
    if (e) { setError(errMsg(e)); return; }
    if (panel?.report_path) await sb.storage.from("lab-reports").remove([panel.report_path]);
    router.push("/biomarkers");
  }

  const metaForm = (
    <div className="card formgrid">
      <label>Collection date<input type="date" value={meta.date} max={todayIso()} onChange={(e) => setMeta({ ...meta, date: e.target.value })} required /></label>
      <label>Laboratory<input value={meta.lab} maxLength={120} onChange={(e) => setMeta({ ...meta, lab: e.target.value })} placeholder="optional" /></label>
      <label style={{ gridColumn: "1 / -1" }}>Notes<textarea rows={2} maxLength={2000} value={meta.notes} onChange={(e) => setMeta({ ...meta, notes: e.target.value })} /></label>
      {!isNew && <div className="row"><button className="btn" onClick={saveMeta}>Save details</button></div>}
    </div>
  );

  return (
    <>
      <div className="eyebrow"><Link href="/biomarkers" style={{ color: "inherit" }}>← Biomarkers</Link></div>
      <h1>{isNew ? "New blood test" : panel ? `Blood test · ${panel.collected_on}` : "Blood test"}</h1>
      {error && <div className="notice error">{error}</div>}
      {ok && <div className="notice ok">{ok}</div>}

      {!isNew && !panel && !error && <p className="muted">Loading…</p>}
      {(isNew || panel) && metaForm}
      {isNew && sameDay.length > 0 && (
        <div className="notice">You already have {sameDay.length === 1 ? "a blood test" : `${sameDay.length} blood tests`} on this date.
          {sameDay.length === 1 && <> <Link href={`/biomarkers/panels/${sameDay[0]}`} style={{ color: "var(--green)" }}>Open it</Link> to avoid entering the same results twice.</>}</div>
      )}

      {isNew && (
        <>
          <h2>Original report (optional)</h2>
          <div className="card">
            <p className="muted small" style={{ marginTop: 0 }}>Attach the laboratory&apos;s PDF or photo to keep it privately with this test. You can also let APEX try to read it, then check every value before saving.</p>
            <input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => pick(e.target.files?.[0])} />
            {file && (
              <>
                <label className="check" style={{ flexDirection: "row", gap: 8, alignItems: "flex-start", marginTop: 12 }}>
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ width: "auto", marginTop: 3 }} />
                  <span>I understand that, to read it automatically, this report is sent to Google&apos;s Gemini AI service. Nothing is saved in APEX until I review and confirm.</span>
                </label>
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn" disabled={!consent || reading} onClick={read}>{reading ? "Reading report…" : "Read report automatically"}</button>
                </div>
              </>
            )}
            {dup && <div className="notice">This report was already imported on a blood test dated {dup.collected_on}. <Link href={`/biomarkers/panels/${dup.id}`} style={{ color: "var(--green)" }}>Open it</Link></div>}
          </div>

          <h2>Results</h2>
          {info?.fromDoc && (
            <div className="notice" role="alert">
              <b>Extracted automatically. Not verified.</b> Automatic reading can misread names, numbers, units and ranges. Compare every row with the original report, fix or untick what is wrong.
              {info.skipped.length > 0 && <ul className="small" style={{ margin: "8px 0 0", paddingLeft: 18 }}>{info.skipped.map((s) => <li key={s}>{s}</li>)}</ul>}
            </div>
          )}
          <div className="card">
            {pending.length === 0 && <p className="muted small" style={{ margin: 0 }}>No results added yet. Add them below{file ? " or read the report above" : ""}.</p>}
            {pending.map((p, i) => editRow === i ? (
              <ResultForm key={i} initial={p.draft} submitLabel="Update row" onCancel={() => setEditRow(null)}
                onSubmit={(d) => { setPending(pending.map((x, j) => (j === i ? { ...x, draft: d } : x))); setEditRow(null); }} />
            ) : (
              <div key={i} className={`doserow${p.include ? "" : " off"}`}>
                <input type="checkbox" aria-label={`Include ${p.draft.original_name}`} checked={p.include} onChange={(e) => setPending(pending.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))} style={{ width: "auto" }} />
                <span><b>{p.draft.original_name}</b> {p.draft.value} {p.draft.unit}
                  <span className="muted small"> · lab range {p.draft.ref_low ?? "–"} to {p.draft.ref_high ?? "–"}{p.draft.flag ? ` · flag ${p.draft.flag}` : ""}{p.source === "document" ? " · from report" : ""}{normalizeMarker(p.draft.original_name) ? "" : " · not matched to a known marker"}</span></span>
                <span className="row" style={{ marginLeft: "auto" }}>
                  <button className="chip" type="button" onClick={() => setEditRow(i)}>Edit</button>
                  <button className="chip" type="button" onClick={() => setPending(pending.filter((_, j) => j !== i))}>Remove</button>
                </span>
              </div>
            ))}
          </div>
          <h3 style={{ margin: "16px 0 8px" }}>Add a result</h3>
          <div className="card"><ResultForm submitLabel="Add to list" onSubmit={(d) => setPending([...pending, { draft: d, include: true, source: "manual" }])} /></div>

          {info?.fromDoc && (
            <label className="check" style={{ flexDirection: "row", gap: 8, alignItems: "flex-start", margin: "16px 0 0" }}>
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} style={{ width: "auto", marginTop: 3 }} />
              <span>I checked the extracted values against the original report.</span>
            </label>
          )}
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn" disabled={busy} onClick={saveNew}>{busy ? "Saving…" : `Save blood test (${pending.filter((p) => p.include).length} results)`}</button>
            <Link className="btn ghost" href="/biomarkers">Cancel</Link>
          </div>
        </>
      )}

      {!isNew && panel && (
        <>
          {!panel.report_path && (
            <div className="card" style={{ margin: "12px 0" }}>
              <b className="small">Original report</b>
              <p className="muted small" style={{ margin: "4px 0 8px" }}>Keep the laboratory&apos;s PDF or photo privately with this test.</p>
              <input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => { attachReport(e.target.files?.[0]); e.target.value = ""; }} />
            </div>
          )}
          {panel.report_path && <div className="row" style={{ margin: "12px 0" }}><button className="btn ghost" onClick={openReport}>Open original report{panel.report_filename ? ` (${panel.report_filename})` : ""}</button>{panel.source === "document" && <span className="muted small">Values were read automatically and confirmed by you.</span>}</div>}
          <h2>Results</h2>
          {results.length === 0 && <div className="notice">No results in this blood test yet.</div>}
          <div className="card">
            {results.map((r) => editRow === r.id ? (
              <ResultForm key={r.id} initial={{ original_name: r.original_name, value: r.value, unit: r.unit, ref_low: r.ref_low, ref_high: r.ref_high, flag: r.flag }}
                submitLabel="Save" onCancel={() => setEditRow(null)} onSubmit={(d) => updateResult(r.id, d)} />
            ) : (
              <div key={r.id} className="doserow">
                <span><b>{r.original_name}</b> {r.value} {r.unit}
                  <span className="muted small"> · lab range {r.ref_low ?? "–"} to {r.ref_high ?? "–"}{r.flag ? ` · flag ${r.flag}` : ""}</span></span>
                <span className={`pill ${STATUS_CLASS[rangeStatus(r.value, r.ref_low, r.ref_high)]}`}>{STATUS_TEXT[rangeStatus(r.value, r.ref_low, r.ref_high)]}</span>
                <span className="row" style={{ marginLeft: "auto" }}>
                  <Link className="chip" href={`/biomarkers/${encodeURIComponent(seriesKey(r))}`}>History</Link>
                  <button className="chip" type="button" onClick={() => setEditRow(r.id)}>Edit</button>
                  <button className="chip" type="button" onClick={() => removeResult(r)}>Delete</button>
                </span>
              </div>
            ))}
          </div>
          <h3 style={{ margin: "16px 0 8px" }}>Add a result</h3>
          <div className="card"><ResultForm submitLabel="Add result" onSubmit={addResult} /></div>
          <div className="row" style={{ marginTop: 24 }}><button className="btn ghost" onClick={removePanel}>Delete this blood test</button></div>
        </>
      )}
    </>
  );
}
