"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { errText, sdb, useLibrary } from "@/lib/strength/hooks";
import { NotSetUp, existingForImport, importChunk } from "@/lib/strength/data";
import { ImportError, MAX_FILE_BYTES, buildPayload, buildPreview, parseHevy, type NameMap, type ParseIssue, type Preview } from "@/lib/strength/hevy";
import { SetupNotice, StrengthNav } from "@/components/strength/Bits";

export default function ImportPage() {
  const lib = useLibrary();
  const [tz, setTz] = useState(() => (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC"));
  const [pv, setPv] = useState<Preview | null>(null);
  const [issues, setIssues] = useState<ParseIssue[]>([]);
  const [map, setMap] = useState<NameMap>({});
  const [db, setDb] = useState<"per_hand" | "combined">("per_hand");
  const [state, setState] = useState<{ step: "pick" | "preview" | "importing" | "done"; progress: number; result?: { imported: number; skipped: number; rejected: number; errors: string[] } }>({ step: "pick", progress: 0 });
  const [error, setError] = useState<string | null>(null);
  const [notSetUp, setNotSetUp] = useState(false);
  const [file, setFile] = useState<File | null>(null);

  async function read(f: File) {
    setError(null); setFile(f);
    if (f.size > MAX_FILE_BYTES) { setError("The file is larger than 8 MB."); return; }
    if (!/\.csv$/i.test(f.name) && f.type && !/csv|text/.test(f.type)) { setError("Choose the .csv file from Hevy's “Export Workouts”."); return; }
    try {
      const parsed = parseHevy(await f.text(), tz);
      let existing: Awaited<ReturnType<typeof existingForImport>> = [];
      try { existing = await existingForImport(sdb()); } catch (e) { if (e instanceof NotSetUp) setNotSetUp(true); else throw e; }
      const p = buildPreview(parsed, existing, lib.all);
      setPv(p); setIssues(parsed.issues);
      setMap(Object.fromEntries(p.names.map((n) => [n.importedName, n.exercise?.key ?? null])));
      setState({ step: "preview", progress: 0 });
    } catch (e) { setError(e instanceof ImportError ? e.message : `The file could not be read: ${errText(e)}`); }
  }
  const chosen = useMemo(() => pv?.workouts.filter((w) => w.include && w.status !== "already_imported" && w.status !== "deleted_before").length ?? 0, [pv]);

  async function run() {
    if (!pv || chosen === 0) return;
    if (!window.confirm(`Import ${chosen} workout${chosen > 1 ? "s" : ""}? Existing history is never overwritten, and importing the same file again adds nothing new.`)) return;
    const chunks = buildPayload(pv, map, lib.all, { dumbbellWeights: db });
    setState({ step: "importing", progress: 0 });
    const total = { imported: 0, skipped: 0, rejected: 0, errors: [] as string[] };
    try {
      for (let i = 0; i < chunks.length; i++) {
        const r = await importChunk(sdb(), chunks[i]);
        total.imported += r.imported; total.skipped += r.skipped; total.rejected += r.rejected; total.errors.push(...r.errors.map((x) => `${x.source_ref.split("|").slice(1).join(" · ")}: ${x.error}`));
        setState({ step: "importing", progress: (i + 1) / chunks.length });
      }
      setState({ step: "done", progress: 1, result: total });
    } catch (e) {
      setState({ step: "done", progress: 1, result: total });
      setError(`${e instanceof NotSetUp ? e.message : errText(e)} ${total.imported} workout(s) were imported before the error; run the import again to continue (already imported workouts are skipped).`);
    }
  }
  const toggle = (i: number) => pv && setPv({ ...pv, workouts: pv.workouts.map((w, j) => (j === i ? { ...w, include: !w.include } : w)) });

  return (
    <>
      <div className="eyebrow">Strength Hub</div>
      <h1>Import from Hevy</h1>
      <StrengthNav />
      {notSetUp && <SetupNotice what="Importing" />}
      {error && <div className="notice error" role="alert">{error}</div>}
      {state.step === "pick" && (
        <div className="card">
          <p style={{ marginTop: 0 }}>No Hevy Pro or API needed. In the Hevy app: <b>Profile → Settings → Export &amp; Import Data → Export Workouts</b>, then choose the CSV file here. Nothing is saved until you review it and confirm.</p>
          <label>Time zone the workouts were logged in<input value={tz} onChange={(e) => setTz(e.target.value)} /></label>
          <p className="muted small">Hevy writes local times without a time zone; they are interpreted in this zone (daylight saving included).</p>
          <input type="file" accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void read(f); }} aria-label="Hevy CSV file" />
        </div>
      )}
      {pv && state.step === "preview" && (
        <>
          <div className="statgrid">
            <div className="kpi"><small>Workouts in file</small><b>{pv.workouts.length}</b></div>
            <div className="kpi"><small>New</small><b>{pv.counts.new}</b></div>
            <div className="kpi"><small>Already imported</small><b>{pv.counts.already}</b></div>
            <div className="kpi"><small>Overlap an APEX log</small><b>{pv.counts.overlaps}</b></div>
            <div className="kpi"><small>Sets</small><b>{pv.sets}</b></div>
          </div>
          <p className="small">{file?.name} · {pv.from?.slice(0, 10)} to {pv.to?.slice(0, 10)} · weights in <b>{pv.weightUnit ?? "not present"}</b>{pv.missing.length ? ` · not in this file: ${pv.missing.join(", ")}` : ""}.</p>
          {issues.length > 0 && <details className="notice"><summary>{issues.length} row(s) need attention (skipped or left empty, never guessed)</summary><ul className="small">{issues.slice(0, 50).map((x, i) => <li key={i}>{x.line ? `Line ${x.line}: ` : ""}{x.message}</li>)}</ul></details>}

          <h2>Dumbbell weights</h2>
          <div className="card">
            <p className="small" style={{ marginTop: 0 }}>The file does not say whether dumbbell weights are per dumbbell or combined. Choose how you logged them in Hevy:</p>
            <label className="check"><input type="radio" checked={db === "per_hand"} onChange={() => setDb("per_hand")} /> Weight of one dumbbell (per hand)</label>
            <label className="check"><input type="radio" checked={db === "combined"} onChange={() => setDb("combined")} /> Both dumbbells added together</label>
          </div>

          <h2>Exercises ({pv.names.filter((n) => !map[n.importedName]).length} not matched)</h2>
          <div className="card tablewrap">
            <table className="tbl"><thead><tr><th>Name in Hevy</th><th>APEX exercise</th></tr></thead>
              <tbody>{pv.names.map((n) => (
                <tr key={n.importedName}><td>{n.importedName}{n.exercise && <span className="muted small"> · matched ({n.how})</span>}</td>
                  <td><select value={map[n.importedName] ?? ""} onChange={(e) => setMap({ ...map, [n.importedName]: e.target.value || null })}>
                    <option value="">Keep the imported name (not linked to the library)</option>
                    {lib.all.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}
                  </select></td></tr>
              ))}</tbody></table>
            <p className="muted small">Only confident matches are pre-selected. An unlinked exercise keeps its history under its own name but is not counted in muscle analytics.</p>
          </div>

          <h2>Workouts</h2>
          <div className="card">
            {pv.workouts.map((w, i) => (
              <label key={w.ref} className={`check doserow${w.status === "already_imported" || w.status === "deleted_before" ? " off" : ""}`} style={{ margin: 0 }}>
                <input type="checkbox" disabled={w.status === "already_imported" || w.status === "deleted_before"} checked={w.include} onChange={() => toggle(i)} />
                <span className="muted small tl-date">{w.startedAt.slice(0, 10)}</span>
                <span style={{ flex: 1 }}><b>{w.title}</b> <span className="muted small">· {w.exercises.length} exercises · {w.exercises.reduce((n, e) => n + e.sets.length, 0)} sets</span></span>
                {w.status === "already_imported" && <span className="badge off">already imported</span>}
                {w.status === "deleted_before" && <span className="badge off">imported before, then deleted by you</span>}
                {w.status === "overlaps_apex" && <span className="pill st-low" title={`Overlaps "${w.overlapWith}" logged in APEX`}>possible duplicate of an APEX log</span>}
              </label>
            ))}
          </div>
          <div className="row savebar"><button className="btn" disabled={chosen === 0} onClick={() => void run()}>Import {chosen} workout{chosen === 1 ? "" : "s"}</button><button className="btn ghost" onClick={() => { setPv(null); setState({ step: "pick", progress: 0 }); }}>Choose another file</button></div>
        </>
      )}
      {state.step === "importing" && <div className="notice" role="status">Importing… {Math.round(state.progress * 100)}%</div>}
      {state.step === "done" && state.result && (
        <div className="notice ok">
          <b>Import finished.</b> Imported {state.result.imported} · skipped (already there) {state.result.skipped} · rejected {state.result.rejected}.
          {state.result.errors.length > 0 && <ul className="small">{state.result.errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}</ul>}
          <div className="row" style={{ marginTop: 8 }}><Link className="btn tiny" href="/strength/analytics" style={{ textDecoration: "none" }}>See progress</Link><Link className="btn ghost tiny" href="/strength/duplicates" style={{ textDecoration: "none" }}>Check Garmin duplicates</Link></div>
        </div>
      )}
    </>
  );
}
