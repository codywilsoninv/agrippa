import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM for connection secrets (Founding doc 4: tokens stored encrypted).
// Key: AGRIPPA_ENCRYPTION_KEY, 32 random bytes as base64, set only in Vercel.
// Stored format: v1.<iv>.<tag>.<ciphertext>, each part base64url.

function key(): Buffer {
  const raw = process.env.AGRIPPA_ENCRYPTION_KEY;
  if (!raw) throw new Error("AGRIPPA_ENCRYPTION_KEY is not set");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("AGRIPPA_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return k;
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv, tag, data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function decryptJson<T>(stored: string): T {
  const [v, iv, tag, data] = stored.split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Unrecognised secret format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const out = Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]);
  return JSON.parse(out.toString("utf8")) as T;
}
