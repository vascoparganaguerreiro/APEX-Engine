// Browser-side loaders shared by the biomarker pages. Uses the signed-in user's client, so RLS limits every query to their rows.
import { getSupabase } from "@/lib/supabase";
import { friendlyMessage } from "@/lib/userError";
import { fetchAll, type Panel, type ResultPoint, type Schedule, type Supplement } from "@/lib/health/core";

type Row = Omit<ResultPoint, "collected_on" | "lab_name"> & { blood_panels: { collected_on: string; lab_name: string | null } | null };

const RESULT_COLS = "id,panel_id,original_name,marker_key,value,unit,ref_low,ref_high,flag,source,blood_panels(collected_on,lab_name)";

/** All of the user's results. Paged with .range() in a fixed order (by id), so nothing is silently cut off by a row cap. */
export async function loadResults(): Promise<ResultPoint[]> {
  const sb = getSupabase();
  let counted = false;
  const data = await fetchAll<Row>(async (from, to) => {
    const { data: rows, error, count } = await sb.from("biomarker_results")
      .select(RESULT_COLS, counted ? undefined : { count: "exact" }).order("id", { ascending: true }).range(from, to);
    if (error) throw error;
    if (count !== null && count !== undefined) counted = true;
    return { rows: (rows ?? []) as unknown as Row[], total: count ?? null };
  });
  return data.filter((r) => r.blood_panels).map((r) => ({
    id: r.id, panel_id: r.panel_id, original_name: r.original_name, marker_key: r.marker_key, value: Number(r.value), unit: r.unit,
    ref_low: r.ref_low === null ? null : Number(r.ref_low), ref_high: r.ref_high === null ? null : Number(r.ref_high), flag: r.flag, source: r.source,
    collected_on: r.blood_panels!.collected_on, lab_name: r.blood_panels!.lab_name,
  }));
}

export async function loadPanels(): Promise<Panel[]> {
  const { data, error } = await getSupabase().from("blood_panels")
    .select("id,collected_on,lab_name,notes,source,report_path,report_filename").order("collected_on", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Panel[];
}

export async function loadSupplementsAndSchedules(): Promise<{ supplements: Supplement[]; schedules: Schedule[] }> {
  const sb = getSupabase();
  const [s, c] = await Promise.all([sb.from("supplements").select("*"), sb.from("supplement_schedules").select("*")]);
  if (s.error) throw s.error;
  if (c.error) throw c.error;
  return { supplements: (s.data ?? []) as Supplement[], schedules: (c.data ?? []) as Schedule[] };
}

export const errMsg = (e: unknown) => friendlyMessage(e, "That could not be completed", { scope: "health" });
