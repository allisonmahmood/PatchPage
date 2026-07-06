import { createHash, randomBytes } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function contentHash(value: string): string {
  return `sha256:${sha256(value)}`;
}

export function randomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}
