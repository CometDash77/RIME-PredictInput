/**
 * 进程间协议的信封层：请求、响应与就绪标记的读写形态。
 *
 * 这一层只做结构校验，不做语义判断：它能判定「这不是一个合法请求」，但不会解释
 * payload 的含义——那是领域层的事。响应与就绪标记的校验函数是纯函数，文件读写全部
 * 留在 ipc/file-ipc.ts，便于用 fixture 逐字节比对。
 */

import { compact, type JsonValue } from "../json/canonical.js";
import type { ProtocolErrorCode } from "../domain/error-codes.js";
import { ENGINE_ID_PATTERN, REQUEST_ID_PATTERN, type EngineId, type RequestId, type Sequence } from "../domain/ids.js";
import { err, ok, type Result } from "../domain/result.js";
import { isJsonObject, type JsonObject } from "../json/guards.js";
import { findSecretKey as findForbiddenKey } from "../domain/secret-keys.js";
import { sha256Hex } from "../json/digest.js";

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 256 * 1024;

/** 凭据键名清单只在 domain/secret-keys.ts 维护；IPC 与设置页共用同一份。 */
export {
  SECRET_KEYS as FORBIDDEN_KEYS,
  casefold,
  findSecretKey as findForbiddenKey,
} from "../domain/secret-keys.js";

export type RequestKind = "predict" | "health" | "settings";

export const REQUEST_KINDS: readonly RequestKind[] = ["predict", "health", "settings"];

export function isRequestKind(value: unknown): value is RequestKind {
  return value === "predict" || value === "health" || value === "settings";
}



/** 消息里出现任何形似凭据的键名即拒绝；旧实现抛 ProtocolError。 */
export function rejectSecrets(value: unknown): Result<true, ProtocolErrorCode> {
  return findForbiddenKey(value) === null ? ok(true) : err("secrets are not allowed in IPC");
}

/** 消息字节：紧凑 JSON、UTF-8，超过 256 KiB 即拒绝。 */
export function messageBytes(value: JsonValue): Result<Uint8Array, ProtocolErrorCode> {
  let text: string;
  try {
    text = compact(value);
  } catch {
    return err("message is not valid JSON");
  }
  const bytes = new TextEncoder().encode(text);
  return bytes.byteLength > MAX_MESSAGE_BYTES ? err("message is too large") : ok(bytes);
}

export interface RequestEnvelope {
  readonly version: typeof PROTOCOL_VERSION;
  readonly engineId: EngineId;
  readonly seq: Sequence;
  readonly requestId: RequestId;
  readonly kind: RequestKind;
  readonly sentAt: number;
  readonly payload: JsonObject;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * 解析一个请求文件。
 *
 * 校验顺序与旧实现逐条对齐，因为 Lua 侧只会看到第一个失败原因。JSON 里的整数
 * 超出 JS 安全范围时（旧实现能表示，这里不能）按非法序列处理——Lua 只发小整数，
 * 这是有意收紧而不是行为偏移。
 */
export function parseRequest(raw: Uint8Array): Result<RequestEnvelope, ProtocolErrorCode> {
  if (raw.byteLength > MAX_MESSAGE_BYTES) return err("request is too large");
  let value: unknown;
  try {
    value = JSON.parse(UTF8.decode(raw)) as unknown;
  } catch {
    return err("request is incomplete or invalid");
  }
  if (!isJsonObject(value) || value["version"] !== PROTOCOL_VERSION) {
    return err("unsupported request envelope");
  }
  const engine = value["engine_id"];
  if (typeof engine !== "string" || !ENGINE_ID_PATTERN.test(engine)) return err("invalid engine id");
  const rawSeq = value["seq"];
  if (!Number.isInteger(rawSeq) || (rawSeq as number) < 1 || (rawSeq as number) > Number.MAX_SAFE_INTEGER) {
    return err("invalid request sequence");
  }
  const rawRequestId = value["request_id"];
  if (typeof rawRequestId !== "string" || !REQUEST_ID_PATTERN.test(rawRequestId)) return err("invalid request id");
  const kind = value["kind"];
  if (!isRequestKind(kind)) return err("invalid request kind");
  const sentAt = value["sent_at"];
  if (typeof sentAt !== "number" || !Number.isFinite(sentAt) || sentAt <= 0) return err("invalid request timestamp");
  const payload = value["payload"];
  if (!isJsonObject(payload)) return err("request payload must be an object");
  const secrets = rejectSecrets(value);
  if (!secrets.ok) return err(secrets.error);

  return ok({
    version: PROTOCOL_VERSION,
    engineId: engine as EngineId,
    seq: rawSeq as Sequence,
    requestId: rawRequestId as RequestId,
    kind,
    sentAt,
    payload,
  });
}

/** 请求的线上形态：键序固定，与旧实现写出的文件逐字节对应。 */
export function requestWire(envelope: RequestEnvelope): JsonObject {
  return {
    version: envelope.version,
    engine_id: envelope.engineId,
    seq: envelope.seq,
    request_id: envelope.requestId,
    kind: envelope.kind,
    sent_at: envelope.sentAt,
    payload: envelope.payload,
  };
}

export type ResponseSlot = "a" | "b";

export const RESPONSE_SLOTS: readonly ResponseSlot[] = ["a", "b"];

/** 两个槽位交替使用：奇数序号写 a，偶数写 b。 */
export function responseSlotFor(seq: number): ResponseSlot {
  return seq % 2 === 1 ? "a" : "b";
}

export interface ResponseRecord {
  readonly version: number;
  readonly engineId: EngineId;
  readonly seq: Sequence;
  readonly requestId: RequestId | null;
  readonly createdAt: number | null;
  readonly payload: JsonObject;
  readonly slot: ResponseSlot;
}

export interface ReadyMarker {
  readonly version: number;
  readonly seq: number;
  readonly ts: number;
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * 校验就绪标记。
 *
 * 标记先于正文被读取，所以它只需要自身自洽；与正文的一致性由 parseResponseRecord 检查。
 */
export function parseReadyMarker(text: string): ReadyMarker | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isJsonObject(value)) return null;
  if (value["version"] !== PROTOCOL_VERSION) return null;
  const ts = value["ts"];
  if (typeof ts !== "number" || Number.isNaN(ts)) return null;
  const bytes = value["bytes"];
  const seq = value["seq"];
  const digest = value["sha256"];
  if (!Number.isInteger(seq) || !Number.isInteger(bytes) || typeof digest !== "string") return null;
  return { version: PROTOCOL_VERSION, seq: seq as number, ts, bytes: bytes as number, sha256: digest };
}

/**
 * 校验响应正文与标记。
 *
 * 任一步不成立都返回 null，调用方据此跳过该槽位——旧实现用吞异常实现同一效果，
 * 但标记文件不是对象时会抛 AttributeError 直接崩掉伴随进程；这里按无效标记跳过。
 */
export function parseResponseRecord(
  marker: ReadyMarker,
  body: Uint8Array,
  engineId: EngineId,
): ResponseRecord | null {
  if (body.byteLength !== marker.bytes) return null;
  if (sha256Hex(body) !== marker.sha256) return null;
  let value: unknown;
  try {
    value = JSON.parse(UTF8.decode(body)) as unknown;
  } catch {
    return null;
  }
  if (!isJsonObject(value)) return null;
  if (value["version"] !== PROTOCOL_VERSION) return null;
  if (value["engine_id"] !== engineId) return null;
  if (value["seq"] !== marker.seq) return null;
  const payload = value["payload"];
  if (!isJsonObject(payload)) return null;
  const secrets = rejectSecrets(value);
  if (!secrets.ok) return null;
  const requestId = value["request_id"];
  const createdAt = value["created_at"];
  return {
    version: PROTOCOL_VERSION,
    engineId,
    seq: marker.seq as Sequence,
    requestId: typeof requestId === "string" && REQUEST_ID_PATTERN.test(requestId) ? (requestId as RequestId) : null,
    createdAt: typeof createdAt === "number" ? createdAt : null,
    payload,
    slot: responseSlotFor(marker.seq),
  };
}

/** 响应正文的线上形态。 */
export function responseWire(input: {
  readonly engineId: EngineId;
  readonly seq: Sequence;
  readonly requestId: RequestId;
  readonly createdAt: number;
  readonly payload: JsonObject;
}): JsonObject {
  return {
    version: PROTOCOL_VERSION,
    engine_id: input.engineId,
    seq: input.seq,
    request_id: input.requestId,
    created_at: input.createdAt,
    payload: input.payload,
  };
}

/** 就绪标记的线上形态；正文摘要与字节数在这里就固定下来，读侧据此校验。 */
export function readyMarkerWire(input: {
  readonly seq: Sequence;
  readonly ts: number;
  readonly body: Uint8Array;
}): JsonObject {
  return {
    version: PROTOCOL_VERSION,
    seq: input.seq,
    ts: input.ts,
    bytes: input.body.byteLength,
    sha256: sha256Hex(input.body),
  };
}
