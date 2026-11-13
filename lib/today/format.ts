// Presentation formatters for Today. Pure. Explicit mappings for KNOWN engine and database values; anything unknown gets a safe, neutral
// fallback instead of being shown raw. Nothing here changes a value: it only decides how a known value is worded.
import { SPORT_LABEL } from "../activities.ts";
import { SOURCE_TEXT } from "./model.ts";

const own = <T,>(map: Record<string, T>, key: string): T | undefined => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined);

// ------------------------------------------------------------------ the person's name
const MAX_NAME = 24;
/** A clean first name for the greeting, or null (then no name is shown). The raw profile value is never shown as stored:
 *  whitespace is cleaned, only the first name is used, an e-mail address or web address is never used as a name, a very long single token
 *  (a user name rather than a name) is not cut mid-word but left out, and an all-lower-case or all-upper-case name gets a capital letter.
 *  A name that already mixes cases (for example "McKenzie") is left exactly as written. */
export function formatDisplayName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned || /@|:\/\/|www\./i.test(cleaned)) return null;
  // Only enclosing quotes or brackets and trailing sentence punctuation are removed. Digits, underscores or dots inside the word mean it is a user
  // name or handle, not a first name, so it is not used (checked BEFORE anything else is trimmed, so "vasco_123" cannot turn into "Vasco").
  const first = cleaned.split(" ")[0].replace(/^["'“‘(\[]+/, "").replace(/["'”’)\]]+$/, "").replace(/[.,;:!?]+$/, "");
  if (!first || !/\p{L}/u.test(first) || first.length > MAX_NAME) return null;
  if (/[0-9_.]/.test(first) || !/^[\p{L}\p{M}'’-]+$/u.test(first)) return null;
  const lower = first.toLocaleLowerCase(), upper = first.toLocaleUpperCase();
  if (first === lower || first === upper) return lower.charAt(0).toLocaleUpperCase() + lower.slice(1);
  return first;
}

// ------------------------------------------------------------------ sports
/** The label for a sport id from the database. Unknown ids are shown as "Activity", never as the raw identifier. */
export function sportLabel(id: string | null | undefined): string {
  const key = typeof id === "string" ? id.trim().toLowerCase() : "";
  return own(SPORT_LABEL, key) ?? "Activity";
}

// ------------------------------------------------------------------ training form
/** The five states the load model produces (lib/engine.ts tsbState), with the wording shown to the person. */
const FORM_STATE: Record<string, string> = {
  "Detraining risk": "Detraining risk",
  "Peak form window": "Peak form window",
  "Productive training": "Productive training",
  "Elevated fatigue": "Elevated fatigue",
  "Overtraining risk": "Overtraining risk",
};
/** A known state in its display wording; an unknown one gives null (nothing is shown rather than a raw string). */
export const formStateLabel = (state: string | null | undefined): string | null => (typeof state === "string" ? own(FORM_STATE, state) ?? null : null);

export interface FormFacts { tsb: string; state: string | null; fitness: string; fatigue: string }
/** Fitness (CTL), Fatigue (ATL) and Form (TSB) as separate values. Numbers are the model's own, unchanged; Form carries its sign. */
export function formFacts(form: { ctl: number; atl: number; tsb: number; state: string }): FormFacts {
  return { tsb: `${form.tsb > 0 ? "+" : ""}${form.tsb}`, state: formStateLabel(form.state), fitness: String(form.ctl), fatigue: String(form.atl) };
}

// ------------------------------------------------------------------ where a reading came from
/** Plain words for a stored source id. An absent or unknown id is "source not recorded", never the identifier itself. */
export const sourceText = (source: string | null | undefined): string => (typeof source === "string" ? own(SOURCE_TEXT, source) ?? "source not recorded" : "source not recorded");
