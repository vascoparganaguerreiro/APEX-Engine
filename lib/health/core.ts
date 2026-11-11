// Pure logic for supplements, blood biomarkers and the unified timeline. No imports (unit-testable).
// Dates are ISO strings "YYYY-MM-DD". Nothing here invents data: values, units and ranges are always the
// laboratory's own; observations describe timing only and never claim cause or give advice.

// ------------------------------------------------------------------ types
export type Slot = "morning" | "lunch" | "dinner";
export const SLOTS: Slot[] = ["morning", "lunch", "dinner"];
export const SLOT_LABEL: Record<Slot, string> = { morning: "Morning", lunch: "Lunch", dinner: "Dinner" };
export const DOSE_UNITS = ["mg", "mcg", "g", "IU", "ml", "drops", "other"] as const;
export const FORMULATIONS = ["capsule", "tablet", "softgel", "powder", "liquid", "gummy", "spray", "injection", "other"] as const;
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface Supplement {
  id: string; name: string; brand: string | null; ingredients: string | null; formulation: string | null;
  dose: number | null; dose_unit: string | null; notes: string | null; start_date: string; end_date: string | null;
  status: "active" | "discontinued"; discontinuation_reason: string | null;
}
export interface Schedule {
  id?: string; supplement_id: string; slot: Slot; dose: number; dose_unit: string; days: number[]; valid_from: string; valid_to: string | null;
}
export interface Intake { supplement_id: string; slot: Slot; day: string; status: "taken" | "skipped" }
export interface Panel { id: string; collected_on: string; lab_name: string | null; notes: string | null; source: string; report_path: string | null; report_filename: string | null }
export interface Result {
  id: string; panel_id: string; original_name: string; marker_key: string | null; value: number; unit: string;
  ref_low: number | null; ref_high: number | null; flag: string | null; source: string;
}
export interface ResultPoint extends Result { collected_on: string; lab_name: string | null }

// ------------------------------------------------------------------ dates
export const isIsoDate = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
export const addDay = (day: string, n: number): string => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export const isoWeekday = (day: string): number => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
};
const inRange = (day: string, from: string, to: string | null) => day >= from && (to === null || day <= to);
export const activeOn = (s: Pick<Supplement, "start_date" | "end_date">, day: string) => inRange(day, s.start_date, s.end_date);

// ------------------------------------------------------------------ supplements
const finitePositive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

export function validateSupplement(s: Partial<Supplement>): string | null {
  if (!s.name || s.name.trim().length < 1 || s.name.length > 120) return "Give the supplement a name (up to 120 characters).";
  if (s.dose != null && !finitePositive(s.dose)) return "Dose must be a positive number.";
  if (s.dose_unit != null && !(DOSE_UNITS as readonly string[]).includes(s.dose_unit)) return "Unknown dose unit.";
  if (s.formulation != null && !(FORMULATIONS as readonly string[]).includes(s.formulation)) return "Unknown formulation.";
  if (!isIsoDate(s.start_date)) return "Start date is required.";
  if (s.end_date != null && (!isIsoDate(s.end_date) || s.end_date < s.start_date)) return "End date cannot be before the start date.";
  if (s.status === "discontinued" && !s.end_date) return "A discontinued supplement needs an end date.";
  return null;
}

export function validateSchedule(rows: Array<Pick<Schedule, "slot" | "dose" | "dose_unit" | "days">>): string | null {
  const seen = new Set<string>();
  for (const r of rows) {
    if (!SLOTS.includes(r.slot)) return "Unknown time slot.";
    if (!finitePositive(r.dose)) return `${SLOT_LABEL[r.slot] ?? r.slot}: dose must be a positive number.`;
    if (!(DOSE_UNITS as readonly string[]).includes(r.dose_unit)) return `${SLOT_LABEL[r.slot]}: unknown unit.`;
    if (!r.days.length || r.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return `${SLOT_LABEL[r.slot]}: pick at least one weekday.`;
    if (seen.has(r.slot)) return `${SLOT_LABEL[r.slot]} is listed twice.`;
    seen.add(r.slot);
  }
  return null;
}

export interface DueDose { supplement_id: string; slot: Slot; dose: number; dose_unit: string }
/** Doses expected on a day: active supplement + schedule version valid that day + weekday selected. */
export function dueOn(day: string, supplements: Supplement[], schedules: Schedule[]): DueDose[] {
  const active = new Set(supplements.filter((s) => activeOn(s, day)).map((s) => s.id));
  const wd = isoWeekday(day);
  return schedules
    .filter((c) => active.has(c.supplement_id) && inRange(day, c.valid_from, c.valid_to) && c.days.includes(wd))
    .map((c) => ({ supplement_id: c.supplement_id, slot: c.slot, dose: c.dose, dose_unit: c.dose_unit }));
}

export interface Adherence { expected: number; taken: number; skipped: number; missed: number; rate: number | null }
/** Adherence from `from` to `today`. Past doses with no log count as missed; today's unlogged doses are still pending. */
export function adherence(supplementId: string, supplements: Supplement[], schedules: Schedule[], intakes: Intake[], from: string, today: string): Adherence {
  const log = new Map(intakes.filter((i) => i.supplement_id === supplementId).map((i) => [`${i.day}|${i.slot}`, i.status]));
  const mine = supplements.filter((s) => s.id === supplementId), sch = schedules.filter((c) => c.supplement_id === supplementId);
  const a: Adherence = { expected: 0, taken: 0, skipped: 0, missed: 0, rate: null };
  for (let d = from; d <= today; d = addDay(d, 1)) {
    for (const due of dueOn(d, mine, sch)) {
      const st = log.get(`${d}|${due.slot}`);
      if (!st && d === today) continue;
      a.expected += 1;
      if (st === "taken") a.taken += 1; else if (st === "skipped") a.skipped += 1; else a.missed += 1;
    }
  }
  a.rate = a.expected ? a.taken / a.expected : null;
  return a;
}

// ------------------------------------------------------------------ biomarker identity
export const normText = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Conservative dictionary (English/Portuguese). Only exact matches count; ambiguous names (e.g. a bare "vitamin d")
// are NOT mapped, so they stay as the laboratory wrote them.
const MARKERS: Array<{ key: string; label: string; names: string[] }> = [
  { key: "cholesterol_total", label: "Total cholesterol", names: ["cholesterol total", "total cholesterol", "colesterol total"] },
  { key: "hdl", label: "HDL cholesterol", names: ["hdl", "hdl cholesterol", "colesterol hdl", "hdl colesterol"] },
  { key: "ldl", label: "LDL cholesterol", names: ["ldl", "ldl cholesterol", "colesterol ldl", "ldl colesterol"] },
  { key: "triglycerides", label: "Triglycerides", names: ["triglycerides", "triglicerideos", "triglicerides", "triacilgliceróis", "triacilgliceroes"] },
  { key: "glucose", label: "Glucose (fasting)", names: ["glucose", "glicose", "glucose fasting", "fasting glucose", "glicemia", "glicose em jejum", "glucose em jejum"] },
  { key: "hba1c", label: "HbA1c", names: ["hba1c", "hemoglobina glicada", "hemoglobina glicosilada", "glycated hemoglobin", "hemoglobin a1c", "hb a1c"] },
  { key: "insulin", label: "Insulin", names: ["insulin", "insulina"] },
  { key: "hemoglobin", label: "Hemoglobin", names: ["hemoglobin", "hemoglobina", "hb"] },
  { key: "hematocrit", label: "Hematocrit", names: ["hematocrit", "hematocrito"] },
  { key: "wbc", label: "White blood cells", names: ["white blood cells", "wbc", "leucocitos", "leococitos", "globulos brancos"] },
  { key: "platelets", label: "Platelets", names: ["platelets", "plaquetas"] },
  { key: "ferritin", label: "Ferritin", names: ["ferritin", "ferritina"] },
  { key: "iron", label: "Iron", names: ["iron", "ferro", "ferro serico", "serum iron"] },
  { key: "vitamin_d_25oh", label: "Vitamin D (25-OH)", names: ["25 oh vitamin d", "vitamin d 25 oh", "25 hydroxy vitamin d", "25 hydroxyvitamin d", "vitamina d 25 oh", "25 oh vitamina d", "25 hidroxivitamina d", "25 hidroxi vitamina d", "25 oh d"] },
  { key: "vitamin_b12", label: "Vitamin B12", names: ["vitamin b12", "vitamina b12", "cobalamin", "cobalamina", "b12"] },
  { key: "folate", label: "Folate", names: ["folate", "folato", "acido folico", "folic acid"] },
  { key: "tsh", label: "TSH", names: ["tsh", "thyroid stimulating hormone", "hormona estimuladora da tiroide"] },
  { key: "free_t4", label: "Free T4", names: ["free t4", "t4 livre", "ft4", "tiroxina livre"] },
  { key: "free_t3", label: "Free T3", names: ["free t3", "t3 livre", "ft3", "triiodotironina livre"] },
  { key: "creatinine", label: "Creatinine", names: ["creatinine", "creatinina"] },
  { key: "urea", label: "Urea", names: ["urea", "ureia"] },
  { key: "egfr", label: "eGFR", names: ["egfr", "gfr", "taxa de filtracao glomerular", "tfg"] },
  { key: "alt", label: "ALT", names: ["alt", "alanine aminotransferase", "alanina aminotransferase", "tgp", "alat"] },
  { key: "ast", label: "AST", names: ["ast", "aspartate aminotransferase", "aspartato aminotransferase", "tgo", "asat"] },
  { key: "ggt", label: "GGT", names: ["ggt", "gamma gt", "gama gt", "gama glutamil transferase", "gamma glutamyl transferase"] },
  { key: "crp", label: "C-reactive protein", names: ["c reactive protein", "crp", "pcr", "proteina c reativa", "proteina c reactiva", "hs crp"] },
  { key: "testosterone_total", label: "Testosterone (total)", names: ["testosterone", "testosterona", "testosterone total", "testosterona total"] },
  { key: "cortisol", label: "Cortisol", names: ["cortisol"] },
  { key: "magnesium", label: "Magnesium", names: ["magnesium", "magnesio"] },
  { key: "calcium", label: "Calcium", names: ["calcium", "calcio"] },
  { key: "sodium", label: "Sodium", names: ["sodium", "sodio"] },
  { key: "potassium", label: "Potassium", names: ["potassium", "potassio"] },
  { key: "zinc", label: "Zinc", names: ["zinc", "zinco"] },
  { key: "uric_acid", label: "Uric acid", names: ["uric acid", "acido urico"] },
  { key: "homocysteine", label: "Homocysteine", names: ["homocysteine", "homocisteina"] },
];
const BY_NAME = new Map<string, { key: string; label: string }>();
for (const m of MARKERS) for (const n of m.names) BY_NAME.set(normText(n), { key: m.key, label: m.label });
const LABELS = new Map(MARKERS.map((m) => [m.key, m.label]));

export function normalizeMarker(name: string): { key: string; label: string } | null {
  return BY_NAME.get(normText(name)) ?? null;
}
/** Grouping key for a result: the recognised identity, or the laboratory's own name when not recognised. */
export const seriesKey = (r: Pick<Result, "marker_key" | "original_name">) => r.marker_key ?? `name:${normText(r.original_name)}`;
export const seriesLabel = (key: string, fallbackName: string) => LABELS.get(key) ?? fallbackName;

// ------------------------------------------------------------------ units, ranges, series
export const unitKey = (u: string) => u.toLowerCase().replace(/[µμ]/g, "u").replace(/\s+/g, "");

export type RangeStatus = "below" | "within" | "above" | "unknown";
/** Status against THAT result's own laboratory range. No range printed (or none usable) means unknown. */
export function rangeStatus(value: number, low: number | null, high: number | null): RangeStatus {
  if (low === null && high === null) return "unknown";
  if (low !== null && value < low) return "below";
  if (high !== null && value > high) return "above";
  return "within";
}

export interface UnitSeries { unit: string; key: string; points: ResultPoint[] }
/** One series per unit: values in different units are never put on the same line (and never converted). */
export function splitByUnit(points: ResultPoint[]): UnitSeries[] {
  const m = new Map<string, UnitSeries>();
  for (const p of [...points].sort((a, b) => a.collected_on.localeCompare(b.collected_on))) {
    const k = unitKey(p.unit);
    if (!m.has(k)) m.set(k, { unit: p.unit, key: k, points: [] });
    m.get(k)!.points.push(p);
  }
  return [...m.values()].sort((a, b) => b.points.length - a.points.length);
}

export const sameRange = (a: Pick<Result, "ref_low" | "ref_high">, b: Pick<Result, "ref_low" | "ref_high">) => a.ref_low === b.ref_low && a.ref_high === b.ref_high;

export function change(prev: number, cur: number): { abs: number; pct: number | null } {
  return { abs: cur - prev, pct: prev === 0 ? null : ((cur - prev) / Math.abs(prev)) * 100 };
}

// ------------------------------------------------------------------ supplement/biomarker relationship
export const ASSOCIATION_NOTE =
  "These observations only describe timing: what you were taking when each test was done. They do not show that a supplement caused any change, and are not advice to start, stop or change anything. Discuss results with a clinician.";

export function supplementsDuring(supplements: Supplement[], from: string, to: string) {
  const activeBoth: Supplement[] = [], started: Supplement[] = [], stopped: Supplement[] = [], activeSome: Supplement[] = [];
  for (const s of supplements) {
    const overlaps = s.start_date <= to && (s.end_date === null || s.end_date >= from);
    if (!overlaps) continue;
    activeSome.push(s);
    const atFrom = activeOn(s, from), atTo = activeOn(s, to);
    if (atFrom && atTo) activeBoth.push(s);
    else if (!atFrom && atTo) started.push(s);
    else if (atFrom && !atTo) stopped.push(s);
  }
  return { activeBoth, started, stopped, activeSome };
}

/** Plain-language timing notes for consecutive comparable measurements (same unit). */
export function observations(series: UnitSeries, supplements: Supplement[], max = 3): string[] {
  const pts = series.points, out: string[] = [];
  for (let i = pts.length - 1; i >= 1 && out.length < max; i--) {
    const a = pts[i - 1], b = pts[i];
    const c = change(a.value, b.value);
    const dir = c.abs === 0 ? "was unchanged" : c.abs > 0 ? "was higher" : "was lower";
    const pct = c.pct === null || c.abs === 0 ? "" : ` (${c.pct > 0 ? "+" : ""}${c.pct.toFixed(0)}%)`;
    const sup = supplementsDuring(supplements, a.collected_on, b.collected_on);
    const parts: string[] = [];
    if (sup.activeBoth.length) parts.push(`you were taking ${sup.activeBoth.map((s) => s.name).join(", ")} at both tests`);
    if (sup.started.length) parts.push(`you started ${sup.started.map((s) => s.name).join(", ")} in between`);
    if (sup.stopped.length) parts.push(`you stopped ${sup.stopped.map((s) => s.name).join(", ")} in between`);
    const when = parts.length ? `; ${parts.join("; ")}` : "; no supplements were recorded in this period";
    out.push(`${b.collected_on}: ${b.value} ${series.unit} ${dir} than on ${a.collected_on} (${a.value} ${series.unit})${pct}${when}.`);
  }
  return out;
}

export interface SupplementEvent { date: string; type: "start" | "stop" | "schedule"; supplement_id: string; label: string }
export function supplementEvents(supplements: Supplement[], schedules: Schedule[]): SupplementEvent[] {
  const ev: SupplementEvent[] = [];
  for (const s of supplements) {
    ev.push({ date: s.start_date, type: "start", supplement_id: s.id, label: `Started ${s.name}` });
    if (s.end_date) ev.push({ date: s.end_date, type: "stop", supplement_id: s.id, label: `Stopped ${s.name}` });
    const dates = new Set(schedules.filter((c) => c.supplement_id === s.id && c.valid_from > s.start_date).map((c) => c.valid_from));
    for (const d of dates) ev.push({ date: d, type: "schedule", supplement_id: s.id, label: `Schedule changed: ${s.name}` });
  }
  return ev.sort((a, b) => a.date.localeCompare(b.date));
}

// ------------------------------------------------------------------ unified timeline
export interface TimelineItem { date: string; kind: "panel" | "start" | "stop" | "schedule"; title: string; detail: string; href?: string }
export function buildTimeline(panels: Panel[], results: Result[], supplements: Supplement[], schedules: Schedule[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const p of panels) {
    const rs = results.filter((r) => r.panel_id === p.id);
    const out = rs.filter((r) => { const s = rangeStatus(r.value, r.ref_low, r.ref_high); return s === "below" || s === "above"; }).length;
    items.push({
      date: p.collected_on, kind: "panel", title: `Blood test${p.lab_name ? ` · ${p.lab_name}` : ""}`,
      detail: `${rs.length} result${rs.length === 1 ? "" : "s"}${out ? `, ${out} outside the laboratory range` : ""}`, href: `/biomarkers/panels/${p.id}`,
    });
  }
  for (const e of supplementEvents(supplements, schedules)) {
    items.push({ date: e.date, kind: e.type, title: e.label, detail: "", href: "/supplements" });
  }
  return items.sort((a, b) => b.date.localeCompare(a.date));
}

// ------------------------------------------------------------------ results validation (manual and imported)
export interface ResultInput { original_name: string; value: number; unit: string; ref_low: number | null; ref_high: number | null }
export function validateResult(r: ResultInput): string | null {
  if (!r.original_name || !r.original_name.trim() || r.original_name.length > 160) return "Marker name is required.";
  if (typeof r.value !== "number" || !Number.isFinite(r.value)) return `${r.original_name}: the result must be a number.`;
  if (!r.unit || !r.unit.trim() || r.unit.length > 30) return `${r.original_name}: the unit is required (use the laboratory's unit).`;
  for (const n of [r.ref_low, r.ref_high]) if (n !== null && !Number.isFinite(n)) return `${r.original_name}: invalid reference range.`;
  if (r.ref_low !== null && r.ref_high !== null && r.ref_low > r.ref_high) return `${r.original_name}: reference low is above reference high.`;
  return null;
}
export function validatePanelDate(day: string, today: string): string | null {
  if (!isIsoDate(day)) return "Collection date is required.";
  if (day > addDay(today, 1)) return "Collection date cannot be in the future.";
  return null;
}
export const resultKey = (name: string, unit: string) => `${normText(name)}|${unitKey(unit)}`;

// ------------------------------------------------------------------ AI/OCR extraction (never trusted blindly)
export interface ExtractedResult {
  original_name: string; value: number; unit: string; ref_low: number | null; ref_high: number | null;
  flag: string | null; marker_key: string | null;
}
export interface Extraction { collected_on: string | null; lab_name: string | null; results: ExtractedResult[]; skipped: string[] }

export const EXTRACTION_PROMPT = `You read laboratory blood-test reports (PDF or photo). Extract ONLY what is printed in the document.
Return JSON: {"collected_on":"YYYY-MM-DD"|null,"lab_name":string|null,"results":[{"name":string,"value":number|string,"unit":string|null,"ref_low":number|null,"ref_high":number|null,"flag":string|null}]}.
Rules: copy marker names, units and reference ranges exactly as printed; never convert units; never guess a value, unit or range that is not printed (use null);
"collected_on" is the sample collection date, not the print or report date; "flag" is the lab's own marker (e.g. H, L, High, Low, *) or null;
if a value is like "<0.5" or "negative", keep it as the printed string. Do not diagnose or comment.`;

const toNum = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^\s*-?\d+([.,]\d+)?\s*$/.test(v)) return Number(v.replace(",", "."));
  return null;
};
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Validate whatever the model returned. Anything not clearly a number with a unit is left out (and reported). */
export function parseExtraction(raw: unknown, today: string): Extraction {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const date = isIsoDate(o.collected_on) && o.collected_on <= addDay(today, 1) ? o.collected_on : null;
  const out: Extraction = { collected_on: date, lab_name: str(o.lab_name, 120), results: [], skipped: [] };
  const seen = new Set<string>();
  for (const item of (Array.isArray(o.results) ? o.results : []).slice(0, 200)) {
    const r = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const name = str(r.name, 160);
    if (!name) continue;
    const value = toNum(r.value), unit = str(r.unit, 30);
    if (value === null) { out.skipped.push(`${name}: value "${String(r.value).slice(0, 30)}" is not a plain number; add it manually if needed`); continue; }
    if (!unit) { out.skipped.push(`${name}: no unit was printed or readable; add it manually`); continue; }
    let low = toNum(r.ref_low), high = toNum(r.ref_high);
    if (low !== null && high !== null && low > high) { low = null; high = null; }
    const k = resultKey(name, unit);
    if (seen.has(k)) { out.skipped.push(`${name}: duplicate line ignored`); continue; }
    seen.add(k);
    out.results.push({ original_name: name, value, unit, ref_low: low, ref_high: high, flag: str(r.flag, 40), marker_key: normalizeMarker(name)?.key ?? null });
  }
  return out;
}

// ------------------------------------------------------------------ complete paginated loading
/** Read every row, page by page, in a fixed order. Works even when the server returns fewer rows than asked
 *  (a server-side row cap): it keeps asking from where the last page ended until it has `total` rows or gets an empty page.
 *  Throws instead of silently returning an incomplete list. */
export async function fetchAll<T>(
  page: (from: number, to: number) => Promise<{ rows: T[]; total: number | null }>, pageSize = 1000, max = 100_000,
): Promise<T[]> {
  const out: T[] = [];
  let total: number | null = null;
  while (total === null || out.length < total) {
    const r = await page(out.length, out.length + pageSize - 1);
    if (total === null && r.total !== null) {
      total = r.total;
      if (total > max) throw new Error(`Too many results to load (${total}).`);
    }
    if (r.rows.length === 0) break;
    out.push(...r.rows);
    if (out.length > max) throw new Error("Too many results to load.");
  }
  if (total !== null && out.length < total) throw new Error("Could not load all results. Please try again.");
  return out;
}

// ------------------------------------------------------------------ schedule form drafts (also used to detect "schedule unchanged")
export interface SlotDraft { on: boolean; dose: string; unit: string; days: boolean[] }
export type SlotDrafts = Record<Slot, SlotDraft>;
export const emptySlots = (): SlotDrafts =>
  Object.fromEntries(SLOTS.map((s) => [s, { on: false, dose: "", unit: "mg", days: Array(7).fill(true) }])) as SlotDrafts;

/** Form state from the schedule rows currently in force (what Edit pre-fills). */
export function slotsFrom(current: Schedule[]): SlotDrafts {
  const out = emptySlots();
  for (const c of current) out[c.slot] = { on: true, dose: String(c.dose), unit: c.dose_unit, days: [1, 2, 3, 4, 5, 6, 7].map((d) => c.days.includes(d)) };
  return out;
}
/** Schedule rows from form state. An unchanged form gives back the same rows, so saving does not create a new schedule version. */
export function slotRows(slots: SlotDrafts) {
  return SLOTS.filter((s) => slots[s].on).map((s) => ({
    slot: s, dose: Number(slots[s].dose.replace(",", ".")), dose_unit: slots[s].unit,
    days: slots[s].days.map((on, i) => (on ? i + 1 : 0)).filter(Boolean),
  }));
}
