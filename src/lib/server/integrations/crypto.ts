import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function key(purpose: string) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set");
  return createHash("sha256").update(`${purpose}:${secret}`).digest();
}

/** AES-256-GCM, key derived from BETTER_AUTH_SECRET. Output: base64url(iv|tag|ciphertext). */
export function encrypt(plain: string, purpose = "flowops:google") {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(purpose), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64url");
}
export function decrypt(blob: string, purpose = "flowops:google") {
  const buf = Buffer.from(blob, "base64url");
  const d = createDecipheriv("aes-256-gcm", key(purpose), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

export function sign(value: string, purpose = "flowops:state") {
  return `${value}.${createHmac("sha256", key(purpose)).update(value).digest("base64url")}`;
}
export function verify(signed: string, purpose = "flowops:state"): string | null {
  const i = signed.lastIndexOf(".");
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const a = Buffer.from(sign(value, purpose));
  const b = Buffer.from(signed);
  return a.length === b.length && timingSafeEqual(a, b) ? value : null;
}
