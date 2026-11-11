// Server-only AES-256-GCM for per-user credentials. The key lives in an environment variable
// (INTERVALS_ENCRYPTION_KEY, 32 random bytes, base64), never in the database or the client bundle.
// Format: v1.<iv>.<tag>.<ciphertext> (base64url). The version prefix allows key rotation later.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function keyFrom(b64: string | undefined): Buffer {
  const key = Buffer.from(b64 ?? "", "base64");
  if (key.length !== 32) throw new Error("INTERVALS_ENCRYPTION_KEY must be 32 bytes, base64-encoded.");
  return key;
}

export function encryptSecret(plain: string, keyB64: string | undefined = process.env.INTERVALS_ENCRYPTION_KEY): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyFrom(keyB64), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(blob: string, keyB64: string | undefined = process.env.INTERVALS_ENCRYPTION_KEY): string {
  const [v, iv, tag, ct] = blob.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unsupported credential format.");
  const d = createDecipheriv("aes-256-gcm", keyFrom(keyB64), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
