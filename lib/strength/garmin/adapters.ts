// Modular workout export. Each adapter states honestly whether it is available, experimental or waiting for third-party approval.
// Pure (no I/O): adapters return file bytes; the UI triggers the download.
import { encodeWorkoutFit } from "./fit.ts";
import { buildIcs } from "./ics.ts";
import { validateStructured, type StructuredWorkout } from "./structured.ts";

export type AdapterStatus = "available" | "experimental" | "requires_approval";
export interface ExportFile { filename: string; mime: string; bytes: Uint8Array }
export interface ExportAdapter {
  id: "fit" | "ics" | "json" | "garmin_connect";
  label: string;
  status: AdapterStatus;
  /** What the user must do with the output, in plain words. */
  instructions: string;
  export(w: StructuredWorkout, now: Date): ExportFile;
}
export class ExportUnavailable extends Error {}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "_").slice(0, 40) || "workout";
const checked = (w: StructuredWorkout) => { const e = validateStructured(w); if (e) throw new ExportUnavailable(e); return w; };

export const FIT_ADAPTER: ExportAdapter = {
  id: "fit", label: "Workout file for the watch (.fit)", status: "experimental",
  instructions: "Experimental, not yet confirmed on a Forerunner 965. Connect the watch by USB and copy the file into the GARMIN/NewFiles folder (on Windows the watch appears as a portable device; on a Mac use an MTP tool such as OpenMTP). After unplugging, look under Training > Workouts. Garmin Connect's website does not import workout .fit files.",
  export(w, now) { return { filename: `${safeName(w.name)}.fit`, mime: "application/octet-stream", bytes: encodeWorkoutFit(checked(w), now) }; },
};
export const ICS_ADAPTER: ExportAdapter = {
  id: "ics", label: "Calendar event (.ics)", status: "available",
  instructions: "Import the file into Google Calendar (Settings > Import & export), Samsung Calendar or Apple Calendar. The event description lists every step.",
  export(w, now) {
    if (!w.scheduledDate) throw new ExportUnavailable("Choose a date for the calendar entry first.");
    const ics = buildIcs([{ uid: `${safeName(w.name)}-${w.scheduledDate}`, workout: checked(w), date: w.scheduledDate }], now);
    return { filename: `${safeName(w.name)}_${w.scheduledDate}.ics`, mime: "text/calendar", bytes: new TextEncoder().encode(ics) };
  },
};
export const JSON_ADAPTER: ExportAdapter = {
  id: "json", label: "Structured workout (.json)", status: "available",
  instructions: "A complete, machine-readable copy of the workout steps and targets, for backups or other tools.",
  export(w) { return { filename: `${safeName(w.name)}.json`, mime: "application/json", bytes: new TextEncoder().encode(JSON.stringify({ format: "apex-structured-workout", version: 1, workout: checked(w) }, null, 2)) }; },
};
/** Placeholder for Garmin's official Training API. It needs an approved Garmin Connect Developer Program (business) application and
 *  user OAuth consent; APEX has neither, so this adapter never pretends to send anything. */
export const GARMIN_CONNECT_ADAPTER: ExportAdapter = {
  id: "garmin_connect", label: "Send to Garmin Connect", status: "requires_approval",
  instructions: "Not available. Sending workouts to Garmin Connect (and from there to the watch) requires Garmin's Training API, which is only open to approved business developers. Use the .fit file or recreate the workout in Garmin Connect from the step list.",
  export() { throw new ExportUnavailable("Direct Garmin Connect publishing is not available without Garmin Training API approval."); },
};
export const ADAPTERS: readonly ExportAdapter[] = [FIT_ADAPTER, ICS_ADAPTER, JSON_ADAPTER, GARMIN_CONNECT_ADAPTER];
