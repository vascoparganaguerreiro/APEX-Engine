"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import { extractReport } from "@/lib/api";
import { todayIso } from "@/lib/dates";
import { errMsg } from "@/lib/health/load";
import { normalizeMarker, rangeStatus, resultKey, seriesKey, validatePanelDate, validateResult, type Panel, type Result } from "@/lib/health/core";
import ResultForm, { type ResultDraft } from "@/components/health/ResultForm";

const EXT: Record<string, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const MAX_BYTES = 10 * 1024 * 1024;
const STATUS_TEXT = { below: "Below lab range", within: "Within lab range", above: "Above lab range", unknown: "No range printed" } as const;
const STATUS_CLASS = { below: "st-low", within: "st-ok", above: "st-high", unknown: "st-na" } as const;
interface Pending { draft: ResultDraft; include: boolean; source: "manual" | "document" }

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
  const [file, setFile] = useState<{ f: File; sha: string } | null>(null);
  const [consent, setConsent] = useState(false);
  const [checked, setChecked] = useState(false);
  const [reading, setReading] = useState(false);
  const [info, setInfo] = useState<{ skipped: string[]; fromDoc: boolean } | null>(null);
  const [dup, setDup] = useState<{ id: string; collected_on: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (isNew) return;
    const sb = getSupabase();
    const [p, r] = await Promise.all([
      sb.from("blood_panels").select("id,collected_on,lab_name,notes,source,report_path,report_filename").eq("id", id).maybeSingle(),
      sb.from("biomarker_results").select("id,panel_id,original_name,marker_key,value,unit,ref_low,ref_high,flag,source").eq("panel_id", id).order("original_name"),
    ]);
    if (p.error || r.error) { setError(errMsg(p.error ?? r.error)); return; }
    if (!p.data) { setError("This blood test was not found."); return; }
    setPanel(p.data as Panel); setMeta({ date: p.data.collected_on, lab: p.data.lab_name ?? "", notes: p.data.notes ?? "" });
    setResults(((r.data ?? []) as Result[]).map((x) => ({ ...x, value: Number(x.value), ref_low: x.ref_low === null ? null : Number(x.ref_low), ref_high: x.ref_high === null ? null : Number(x.ref_high) })));
  }, [id, isNew]);
  useEffect(() => { if (session) load(); }, [session, load]);

  // ------------------------------------------------------------ file + automatic reading (review before saving)
  async function pick(f: File | undefined) {
    setError(null); setDup(null); setInfo(null);
    if (!f) { setFile(null); return; }
    if (!EXT[f.type]) { setError("Only PDF, PNG, JPEG or WebP files are supported."); return; }
    if (f.size > MAX_BYTES) { setError("The file is larger than 10 MB."); return; }
    setFile({ f, sha: await sha256Hex(f) });
  }
  async function read() {
    if (!file) return;
    setReading(true); setError(null); setDup(null);
    try {
      const r = await extractReport(file.f);
      if (r.duplicate) { setDup(r.duplicate); return; }
      const x = r.extraction!;
      setMeta((m) => ({ ...m, date: x.collected_on ?? m.date, lab: m.lab || x.lab_name || "" }));
      setPending(x.results.map((e) => ({ draft: { original_name: e.original_name, value: e.value, unit: e.unit, ref_low: e.ref_low, ref_high: e.ref_high, flag: e.flag }, include: true, source: "document" })));
      setInfo({ skipped: x.skipped, fromDoc: true }); setChecked(false);
      if (!x.collected_on) setError("The collection date could not be read. Check the date below before saving.");
    } catch (e) { setError(errMsg(e)); } finally { setReading(false); }
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
    if (info?.fromDoc && rows.some((r) => r.source === "document") && !checked) { setError("Confirm that you checked the extracted values against the original report."); return; }
    setBusy(true);
    const sb = getSupabase();
    let uploaded: string | null = null;
    try {
      let path: string | null = null;
      if (file) {
        path = `${session!.user.id}/${file.sha}.${EXT[file.f.type]}`;
        const up = await sb.storage.from("lab-reports").upload(path, file.f, { contentType: file.f.type, upsert: false });
        if (up.error && !/already exists|Duplicate/i.test(up.error.message)) throw up.error;
        if (!up.error) uploaded = path;
      }
      const { data, error: e } = await sb.rpc("save_blood_panel", {
        p_panel: { collected_on: meta.date, lab_name: meta.lab, notes: meta.notes, source: info?.fromDoc ? "document" : "manual", report_path: path, report_filename: file?.f.name.slice(0, 200) ?? null, report_sha256: file?.sha ?? null },
        p_results: rows.map((r) => ({ ...toRow(r.draft), source: r.source })),
      });
      if (e) throw e;
      router.push(`/biomarkers/panels/${data as string}`);
    } catch (e) {
      if (uploaded) await sb.storage.from("lab-reports").remove([uploaded]);   // no orphaned file after a failed save
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
    const { data, error: e } = await getSupabase().storage.from("lab-reports").createSignedUrl(panel!.report_path!, 60);
    if (e || !data) setError(errMsg(e)); else window.open(data.signedUrl, "_blank", "noopener");
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

      {metaForm}

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
