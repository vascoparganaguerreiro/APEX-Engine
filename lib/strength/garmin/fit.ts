// Minimal FIT workout file encoder (file_id + workout + workout_step messages), written from the public FIT protocol description, plus a
// small decoder used to verify our own output. Pure (no I/O).
//
// STATUS: experimental. The byte layout is checked by tests (CRCs, round trip), but a file from this encoder has NOT yet been confirmed
// on a Forerunner 965. Garmin documents copying workout files to the watch's GARMIN/NewFiles folder over USB; Garmin Connect's web
// importer does not accept workout FIT files. See docs/strength-hub.md.
import type { Duration, Intensity, Step, StructuredWorkout, Target, WorkoutSport } from "./structured.ts";
import { FIT_CATEGORY } from "../types.ts";

const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];
/** FIT CRC-16 (same polynomial as CRC-16/ARC). */
export function fitCrc(bytes: Uint8Array, start = 0, end = bytes.length, seed = 0): number {
  let crc = seed;
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    let tmp = CRC_TABLE[crc & 0xf]; crc = (crc >> 4) & 0x0fff; crc = crc ^ tmp ^ CRC_TABLE[b & 0xf];
    tmp = CRC_TABLE[crc & 0xf]; crc = (crc >> 4) & 0x0fff; crc = crc ^ tmp ^ CRC_TABLE[(b >> 4) & 0xf];
  }
  return crc;
}

const BT = { enum: 0x00, uint8: 0x02, uint16: 0x84, uint32: 0x86, string: 0x07, uint32z: 0x8c } as const;
type BaseType = keyof typeof BT;
const SIZE: Record<BaseType, number> = { enum: 1, uint8: 1, uint16: 2, uint32: 4, string: 0, uint32z: 4 };
const INVALID: Record<Exclude<BaseType, "string">, number> = { enum: 0xff, uint8: 0xff, uint16: 0xffff, uint32: 0xffffffff, uint32z: 0 };
interface FieldDef { num: number; type: BaseType; size?: number }
type Value = number | string | null;

export const FIT_EPOCH_S = 631065600;                     // 1989-12-31T00:00:00Z
const SPORT: Record<WorkoutSport, [number, number]> = { running: [1, 0], cycling: [2, 0], swimming: [5, 17], strength: [10, 20], hiit: [10, 26], cardio: [10, 26], custom: [0, 0] };
const INTENSITY: Record<Intensity, number> = { active: 0, rest: 1, warmup: 2, cooldown: 3, recovery: 4, interval: 5 };
export const DURATION_TYPE = { time: 0, distance: 1, open: 5, repeat_until_steps_cmplt: 6, reps: 29 } as const;
export const TARGET_TYPE = { speed: 0, heart_rate: 1, open: 2, cadence: 3, power: 4 } as const;

function utf8Fixed(s: string, size: number): number[] {
  const out: number[] = [];
  for (const ch of s) { const b = [...new TextEncoder().encode(ch)]; if (out.length + b.length > size - 1) break; out.push(...b); }
  while (out.length < size) out.push(0);
  return out;
}
const strSize = (values: string[], max: number) => Math.min(max, Math.max(1, ...values.map((v) => new TextEncoder().encode(v).length + 1)));

class Writer {
  bytes: number[] = [];
  u8(v: number) { this.bytes.push(v & 0xff); }
  u16(v: number) { this.u8(v); this.u8(v >>> 8); }
  u32(v: number) { this.u16(v & 0xffff); this.u16(v >>> 16); }
  define(local: number, global: number, fields: FieldDef[]) {
    this.u8(0x40 | local); this.u8(0); this.u8(0); this.u16(global); this.u8(fields.length);
    for (const f of fields) { this.u8(f.num); this.u8(f.type === "string" ? f.size! : SIZE[f.type]); this.u8(BT[f.type]); }
  }
  data(local: number, fields: FieldDef[], values: Value[]) {
    this.u8(local);
    fields.forEach((f, i) => {
      const v = values[i];
      if (f.type === "string") { this.bytes.push(...utf8Fixed(typeof v === "string" ? v : "", f.size!)); return; }
      const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : INVALID[f.type];
      if (SIZE[f.type] === 1) this.u8(n); else if (SIZE[f.type] === 2) this.u16(n); else this.u32(n >>> 0);
    });
  }
}

function durationFields(d: Duration): [number, number | null] {
  switch (d.type) {
    case "time": return [DURATION_TYPE.time, d.seconds * 1000];
    case "distance": return [DURATION_TYPE.distance, Math.round(d.meters * 100)];
    case "reps": return [DURATION_TYPE.reps, d.reps];
    default: return [DURATION_TYPE.open, null];
  }
}
function targetFields(t: Target): [number, number, number | null, number | null] {
  switch (t.type) {
    case "heart_rate": return [TARGET_TYPE.heart_rate, 0, t.low + 100, t.high + 100];            // custom bpm values are offset by 100
    case "power": return [TARGET_TYPE.power, 0, t.low + 1000, t.high + 1000];                    // custom watts are offset by 1000
    case "cadence": return [TARGET_TYPE.cadence, 0, t.low, t.high];
    case "pace": return [TARGET_TYPE.speed, 0, Math.round((1000 / t.slowSPerKm) * 1000), Math.round((1000 / t.fastSPerKm) * 1000)];   // mm/s
    default: return [TARGET_TYPE.open, 0, null, null];
  }
}

/** Encode a structured workout as a FIT workout file. `createdAt` makes the output deterministic for tests. */
export function encodeWorkoutFit(w: StructuredWorkout, createdAt: Date): Uint8Array {
  const flat: Array<{ step: Step; index: number } | { repeatFrom: number; times: number; index: number }> = [];
  for (const s of w.steps) {
    if (s.kind === "repeat") { const from = flat.length; for (const x of s.steps) flat.push({ step: x, index: flat.length }); flat.push({ repeatFrom: from, times: s.times, index: flat.length }); }
    else flat.push({ step: s, index: flat.length });
  }
  const names = flat.map((f) => ("step" in f ? f.step.name : "")), notes = flat.map((f) => ("step" in f ? f.step.notes ?? "" : ""));
  const out = new Writer();
  const fileId: FieldDef[] = [{ num: 0, type: "enum" }, { num: 1, type: "uint16" }, { num: 2, type: "uint16" }, { num: 3, type: "uint32z" }, { num: 4, type: "uint32" }];
  out.define(0, 0, fileId);
  out.data(0, fileId, [5, 255, 0, (Math.floor(createdAt.getTime() / 1000) % 0x7fffffff) || 1, Math.floor(createdAt.getTime() / 1000) - FIT_EPOCH_S]);   // type 5 = workout, manufacturer 255 = development
  const [sport, sub] = SPORT[w.sport];
  const wkt: FieldDef[] = [{ num: 4, type: "enum" }, { num: 6, type: "uint16" }, { num: 8, type: "string", size: strSize([w.name], 32) }, { num: 11, type: "enum" }];
  out.define(1, 26, wkt);
  out.data(1, wkt, [sport, flat.length, w.name, sub]);
  const step: FieldDef[] = [
    { num: 254, type: "uint16" }, { num: 0, type: "string", size: strSize(names, 32) }, { num: 1, type: "enum" }, { num: 2, type: "uint32" }, { num: 3, type: "enum" },
    { num: 4, type: "uint32" }, { num: 5, type: "uint32" }, { num: 6, type: "uint32" }, { num: 7, type: "enum" }, { num: 8, type: "string", size: strSize(notes, 64) },
    { num: 10, type: "uint16" }, { num: 12, type: "uint16" }, { num: 13, type: "enum" },
  ];
  out.define(2, 27, step);
  for (const f of flat) {
    if ("step" in f) {
      const [dt, dv] = durationFields(f.step.duration), [tt, tv, lo, hi] = targetFields(f.step.target);
      const ex = f.step.exercise ?? null;
      out.data(2, step, [f.index, f.step.name, dt, dv, tt, tv, lo, hi, INTENSITY[f.step.intensity], f.step.notes ?? "",
        ex ? FIT_CATEGORY[ex.fit] : null, ex && ex.weightKg !== null ? Math.round(ex.weightKg * 100) : null, ex && ex.weightKg !== null ? 1 : null]);
    } else {
      out.data(2, step, [f.index, "", DURATION_TYPE.repeat_until_steps_cmplt, f.repeatFrom, TARGET_TYPE.open, f.times, null, null, null, "", null, null, null]);
    }
  }
  const data = out.bytes, header = new Uint8Array(14);
  header[0] = 14; header[1] = 0x10; header[2] = 2132 & 0xff; header[3] = 2132 >> 8;          // protocol 1.0, profile 21.32
  header[4] = data.length & 0xff; header[5] = (data.length >> 8) & 0xff; header[6] = (data.length >> 16) & 0xff; header[7] = (data.length >>> 24) & 0xff;
  header.set([0x2e, 0x46, 0x49, 0x54], 8);                                                   // ".FIT"
  const hcrc = fitCrc(header, 0, 12); header[12] = hcrc & 0xff; header[13] = hcrc >> 8;
  const file = new Uint8Array(14 + data.length + 2);
  file.set(header, 0); file.set(data, 14);
  const crc = fitCrc(file, 0, 14 + data.length);
  file[14 + data.length] = crc & 0xff; file[15 + data.length] = crc >> 8;
  return file;
}

// ------------------------------------------------------------------ decoder (verification only)
export interface FitMessage { global: number; fields: Record<number, number | string> }
export function decodeFit(file: Uint8Array): { messages: FitMessage[]; headerCrcOk: boolean; fileCrcOk: boolean } {
  if (file.length < 16 || file[0] < 12 || String.fromCharCode(...file.slice(8, 12)) !== ".FIT") throw new Error("Not a FIT file.");
  const hs = file[0], dataSize = file[4] | (file[5] << 8) | (file[6] << 16) | (file[7] << 24);
  const headerCrcOk = hs < 14 || (file[12] | (file[13] << 8)) === 0 || fitCrc(file, 0, 12) === (file[12] | (file[13] << 8));
  const end = hs + dataSize;
  const fileCrcOk = fitCrc(file, 0, end) === (file[end] | (file[end + 1] << 8));
  const defs = new Map<number, { global: number; fields: Array<{ num: number; size: number; type: number }> }>();
  const messages: FitMessage[] = [];
  let i = hs;
  const td = new TextDecoder();
  while (i < end) {
    const h = file[i++];
    if (h & 0x80) throw new Error("Compressed timestamps are not used by this encoder.");
    const local = h & 0x0f;
    if (h & 0x40) {
      i++; const arch = file[i++]; if (arch !== 0) throw new Error("Only little-endian files are expected.");
      const global = file[i] | (file[i + 1] << 8); i += 2;
      const n = file[i++], fields = [];
      for (let k = 0; k < n; k++) { fields.push({ num: file[i], size: file[i + 1], type: file[i + 2] }); i += 3; }
      defs.set(local, { global, fields });
      continue;
    }
    const d = defs.get(local);
    if (!d) throw new Error("Data message without a definition.");
    const fields: Record<number, number | string> = {};
    for (const f of d.fields) {
      const b = file.slice(i, i + f.size); i += f.size;
      if (f.type === 0x07) { const z = b.indexOf(0); fields[f.num] = td.decode(b.slice(0, z < 0 ? b.length : z)); }
      else { let v = 0; for (let k = f.size - 1; k >= 0; k--) v = v * 256 + b[k]; fields[f.num] = v; }
    }
    messages.push({ global: d.global, fields });
  }
  return { messages, headerCrcOk, fileCrcOk };
}
