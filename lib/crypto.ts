// Server-only AES-256-GCM for per-user credentials. No imports besides node:crypto, so it is unit-testable.
//
// Keys live in environment variables only (never in the database, the client bundle or logs):
//   INTERVALS_ENCRYPTION_KEY       version 1 key (alias of INTERVALS_ENCRYPTION_KEY_V1)
//   INTERVALS_ENCRYPTION_KEY_V<n>  key for version n  (32 random bytes, canonical base64)
//   INTERVALS_ENCRYPTION_ACTIVE_VERSION  version used for new encryptions (default 1)
// Rotation: add KEY_V2, set ACTIVE_VERSION=2. Old blobs stay readable and are re-encrypted on next use.
// Blob format: v<n>.<iv>.<tag>.<ciphertext> (base64url). The additional authenticated data (AAD) binds a blob
// to its owner, so a ciphertext copied to another user's row fails authentication.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type Env = Record<string, string | undefined>;
const IV_LEN = 12, TAG_LEN = 16;

export class CryptoConfigError extends Error {}

/** Strict key parsing: canonical base64 that decodes to exactly 32 bytes. No fallback keys. */
function parseKey(b64: string | undefined, name: string): Buffer {
  const s = (b64 ?? "").trim();
  const key = Buffer.from(s, "base64");
  if (!s || key.length !== 32 || key.toString("base64") !== s) {
    throw new CryptoConfigError(`${name} must be exactly 32 random bytes, base64-encoded.`);
  }
  return key;
}

function keyFor(version: number, env: Env): Buffer {
  const name = version === 1 && env.INTERVALS_ENCRYPTION_KEY ? "INTERVALS_ENCRYPTION_KEY" : `INTERVALS_ENCRYPTION_KEY_V${version}`;
  return parseKey(env[name], name);
}

export function activeVersion(env: Env = process.env): number {
  const raw = env.INTERVALS_ENCRYPTION_ACTIVE_VERSION ?? "1";
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 1 || v > 9999) throw new CryptoConfigError("INTERVALS_ENCRYPTION_ACTIVE_VERSION is invalid.");
  return v;
}

export function encryptSecret(plain: string, aad: string, env: Env = process.env): { blob: string; version: number } {
  const version = activeVersion(env);
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv("aes-256-gcm", keyFor(version, env), iv, { authTagLength: TAG_LEN });
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  const blob = [`v${version}`, iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
  return { blob, version };
}

function parseBlob(blob: string): { version: number; iv: Buffer; tag: Buffer; ct: Buffer } {
  const [v, iv, tag, ct, extra] = blob.split(".");
  const m = /^v(\d{1,4})$/.exec(v ?? "");
  if (!m || !iv || !tag || !ct || extra !== undefined) throw new Error("Unsupported credential format.");
  const out = { version: Number(m[1]), iv: Buffer.from(iv, "base64url"), tag: Buffer.from(tag, "base64url"), ct: Buffer.from(ct, "base64url") };
  if (out.iv.length !== IV_LEN || out.tag.length !== TAG_LEN) throw new Error("Unsupported credential format.");   // rejects truncated tags
  return out;
}

/** Throws on a wrong key, wrong owner (AAD), tampering or a malformed blob. */
export function decryptSecret(blob: string, aad: string, env: Env = process.env): string {
  const p = parseBlob(blob);
  const d = createDecipheriv("aes-256-gcm", keyFor(p.version, env), p.iv, { authTagLength: TAG_LEN });
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(p.tag);
  return Buffer.concat([d.update(p.ct), d.final()]).toString("utf8");
}

/** True when the blob was written with a key version other than the active one. */
export function needsRotation(blob: string, env: Env = process.env): boolean {
  try { return parseBlob(blob).version !== activeVersion(env); } catch { return false; }
}
