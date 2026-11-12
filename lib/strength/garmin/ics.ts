// iCalendar (RFC 5545) export of planned workouts: works with Google Calendar, Samsung Calendar and Apple Calendar by file import.
// Pure (no I/O). No OAuth: the user imports the file themselves.
import { describe, type StructuredWorkout } from "./structured.ts";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
/** Fold lines longer than 75 octets (RFC 5545 §3.1), never splitting a multi-byte character. */
export function fold(line: string): string {
  const enc = new TextEncoder(), parts: string[] = [];
  let cur = "", len = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (len + n > (parts.length ? 74 : 75)) { parts.push(cur); cur = ""; len = 0; }
    cur += ch; len += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export interface CalendarEntry { uid: string; workout: StructuredWorkout; date: string; startTime?: string | null; durationMin?: number | null }
export function buildIcs(entries: CalendarEntry[], now: Date): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//APEX Engine//Training plan//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const e of entries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw new Error("Invalid date.");
    const day = e.date.replace(/-/g, "");
    lines.push("BEGIN:VEVENT", `UID:${e.uid}@apex-engine`, `DTSTAMP:${stamp(now)}`);
    if (e.startTime && /^\d{2}:\d{2}$/.test(e.startTime)) {
      const start = `${day}T${e.startTime.replace(":", "")}00`;                           // floating local time: shown at that clock time wherever the user is
      lines.push(`DTSTART:${start}`, `DURATION:PT${Math.max(1, Math.round(e.durationMin ?? 60))}M`);
    } else {
      const next = new Date(Date.UTC(+e.date.slice(0, 4), +e.date.slice(5, 7) - 1, +e.date.slice(8, 10) + 1)).toISOString().slice(0, 10).replace(/-/g, "");
      lines.push(`DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${next}`);
    }
    lines.push(`SUMMARY:${esc(e.workout.name)}`, `DESCRIPTION:${esc(describe(e.workout))}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
