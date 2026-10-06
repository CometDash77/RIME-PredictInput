import { createHash } from "node:crypto";

import { compact, sortedCompact, sortedDefault, type JsonValue } from "./canonical.js";

/** sha256 of a UTF-8 string, lowercase hex — the only digest form the protocol accepts. */
export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** `contracts._digest`: sorted, compact, UTF-8 encoded. */
export function jsonDigest(value: JsonValue): string {
  return sha256Hex(sortedCompact(value));
}

/** `ollama_policy.POLICY_DIGEST`: sorted with Python's default separators. */
export function policyDigest(value: JsonValue): string {
  return sha256Hex(sortedDefault(value));
}

/** `ipc._json_bytes`: compact UTF-8 message body. */
export function messageBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(compact(value));
}

export const HEX_32 = /^[a-f0-9]{32}$/;
export const HEX_40 = /^[a-f0-9]{40}$/;
export const HEX_64 = /^[a-f0-9]{64}$/;
export const HEX_64_ANY_CASE = /^[A-Fa-f0-9]{64}$/;
