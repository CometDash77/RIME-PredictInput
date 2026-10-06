import { HEX_32, HEX_40 } from "../json/digest.js";
import { err, ok, type Result } from "./result.js";

/**
 * Identifiers that must never be confused with one another.
 *
 * The Lua filter, the sidecar and the Weasel completion notice all carry an
 * engine id, a request id and a sequence number side by side; they are all
 * strings/numbers on the wire, and the legacy code relied on naming discipline
 * alone to keep them apart.
 */
declare const engineIdBrand: unique symbol;
declare const requestIdBrand: unique symbol;
declare const sequenceBrand: unique symbol;

export type EngineId = string & { readonly [engineIdBrand]: "EngineId" };
export type RequestId = string & { readonly [requestIdBrand]: "RequestId" };
export type Sequence = number & { readonly [sequenceBrand]: "Sequence" };

export type IdentifierError = "invalid_engine_id" | "invalid_request_id" | "invalid_sequence";

/** `ipc.ENGINE_ID`: 1..48 chars of `[A-Za-z0-9_-]`. */
export const ENGINE_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;
/** The Lua filter mints exactly 20 random bytes, i.e. 40 hex characters. */
export const LUA_ENGINE_ID_PATTERN = HEX_40;
export const REQUEST_ID_PATTERN = HEX_32;

export function engineId(value: string): Result<EngineId, IdentifierError> {
  return ENGINE_ID_PATTERN.test(value) ? ok(value as EngineId) : err("invalid_engine_id");
}

export function requestId(value: string): Result<RequestId, IdentifierError> {
  return REQUEST_ID_PATTERN.test(value) ? ok(value as RequestId) : err("invalid_request_id");
}

export function sequence(value: number): Result<Sequence, IdentifierError> {
  return Number.isInteger(value) && value >= 1 && value <= Number.MAX_SAFE_INTEGER
    ? ok(value as Sequence)
    : err("invalid_sequence");
}

/**
 * The notice the Weasel host accepts is narrower than the protocol: a 40-hex
 * engine id, a 32-hex request id and a `uint64`-sized sequence.
 */
export function isNotifiableEngineId(value: string): boolean {
  return LUA_ENGINE_ID_PATTERN.test(value);
}

/** Sequence numbers are printed zero-padded to 20 digits in request file names. */
export function formatSequence(value: number): string {
  return String(Math.trunc(value)).padStart(20, "0");
}
