/**
 * 文件 IPC 的读写适配层。
 *
 * 这里只负责与文件系统打交道：目录准备、独占写入、fsync、原子改名、清理陈旧文件；
 * 协议本身（信封、校验、字节形态）在 contracts/envelope.ts。旧实现把两者揉在同一个
 * 类里，导致任何一处协议改动都要读完整份文件才知道影响面。
 */

import { closeSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  CONTRACT_VERSION,
  PROTOCOL_VERSION,
  RESPONSE_SLOTS,
  messageBytes,
  parseReadyMarker,
  parseRequest,
  parseResponseRecord,
  readyMarkerWire,
  rejectSecrets,
  requestWire,
  responseSlotFor,
  responseWire,
  type ReadyMarker,
  type RequestEnvelope,
  type RequestKind,
  type ResponseRecord,
  type ResponseSlot,
} from "../contracts/envelope.js";
import type { ProtocolErrorCode } from "../domain/error-codes.js";
import { ENGINE_ID_PATTERN, formatSequence, requestId, type EngineId, type Sequence } from "../domain/ids.js";
import { err, ok, type Result } from "../domain/result.js";
import type { JsonObject } from "../json/guards.js";
import { ensurePrivateDirectory } from "../settings/private-directory.js";

export type FileIpcError = ProtocolErrorCode | "io_failure";

export interface FileIpcOptions {
  readonly requests: string;
  readonly responses: string;
  /** 目录加固钩子；默认在 Windows 上收紧 ACL。 */
  readonly prepareDirectory?: (directory: string) => void;
  /** 注入用：测试里需要确定的时间戳。 */
  readonly now?: () => number;
  /** 注入用：测试里需要确定的请求 id。 */
  readonly randomHex?: (bytes: number) => string;
}

export interface PublishRequestInput {
  readonly engineId: EngineId;
  readonly seq: Sequence;
  readonly kind: RequestKind;
  readonly payload: JsonObject;
  readonly now?: number;
}

/** 请求文件名：req-{engine_id}-{seq 补零 20 位}-{request_id}.json。 */
const REQUEST_FILE = /^req-.*\.json$/;

function isRequestFileName(name: string): boolean {
  return process.platform === "win32"
    ? /^req-.*\.json$/i.test(name)
    : REQUEST_FILE.test(name);
}

/** Windows 上路径比较不区分大小写，排序必须与文件系统一致。 */
function compareNames(left: string, right: string): number {
  const a = process.platform === "win32" ? left.toLowerCase() : left;
  const b = process.platform === "win32" ? right.toLowerCase() : right;
  return a < b ? -1 : a > b ? 1 : 0;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 独占写入 + fsync；给了 renameTo 就先写 .part 再原子改名（旧实现的保险丝）。 */
function writeExclusive(path: string, data: Uint8Array, renameTo?: string): void {
  const handle = openSync(path, "wx");
  try {
    writeSync(handle, data);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  if (renameTo === undefined) return;
  try {
    renameSync(path, renameTo);
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // 改名成功后 .part 已不存在。
    }
  }
}

function writeAll(path: string, data: Uint8Array): void {
  const handle = openSync(path, "w");
  try {
    writeSync(handle, data);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function readSlot(directory: string, slot: ResponseSlot, engineId: EngineId, now: number): ResponseRecord | null {
  const markerPath = join(directory, `response-${slot}.ready`);
  const bodyPath = join(directory, `response-${slot}.json`);
  let marker: ReadyMarker | null;
  let body: Uint8Array;
  try {
    marker = parseReadyMarker(readFileSync(markerPath, "utf8"));
    body = readFileSync(bodyPath);
  } catch {
    return null;
  }
  if (marker === null) return null;
  return parseResponseRecord(marker, body, engineId, now);
}

function collectFiles(directory: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.isFile()) files.push(path);
    }
  };
  walk(directory);
  return files;
}

function pruneEmptyDirectories(directory: string): void {
  const walk = (current: string): boolean => {
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return true;
    }
    let empty = true;
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        empty = false;
        continue;
      }
      const child = join(current, entry.name);
      if (!walk(child)) empty = false;
    }
    if (empty && current !== directory) {
      try {
        rmdirSync(current);
        return true;
      } catch {
        return false;
      }
    }
    return empty;
  };
  walk(directory);
}

export class FileIpc {
  readonly #requests: string;
  readonly #responses: string;
  readonly #prepare: (directory: string) => void;
  readonly #now: () => number;
  readonly #randomHex: (bytes: number) => string;
  readonly #prepared = new Set<string>();

  constructor(options: FileIpcOptions) {
    if (!isAbsolute(options.requests) || !isAbsolute(options.responses)) {
      throw new Error("IPC directories must be absolute");
    }
    this.#requests = options.requests;
    this.#responses = options.responses;
    this.#prepare = options.prepareDirectory ?? ensurePrivateDirectory;
    this.#now = options.now ?? (() => Date.now() / 1000);
    this.#randomHex = options.randomHex ?? ((bytes) => randomBytes(bytes).toString("hex"));
  }

  get requestsDirectory(): string {
    return this.#requests;
  }

  get responsesDirectory(): string {
    return this.#responses;
  }

  #preparePath(directory: string): void {
    if (!this.#prepared.has(directory) || !isDirectory(directory)) {
      this.#prepare(directory);
      this.#prepared.add(directory);
    }
  }

  /** 写一个请求文件；返回写入的信封，调用方据此关联响应。 */
  publishRequest(input: PublishRequestInput): Result<RequestEnvelope, FileIpcError> {
    try {
      this.#preparePath(this.#requests);
      this.#preparePath(this.#responses);
    } catch {
      return err("io_failure");
    }
    const minted = requestId(this.#randomHex(16));
    if (!minted.ok) return err("invalid request id");
    const envelope: RequestEnvelope = {
      version: PROTOCOL_VERSION,
      contractVersion: CONTRACT_VERSION,
      engineId: input.engineId,
      seq: input.seq,
      requestId: minted.value,
      kind: input.kind,
      sentAt: input.now ?? this.#now(),
      payload: input.payload,
    };
    const wire = requestWire(envelope);
    const bytes = messageBytes(wire);
    if (!bytes.ok) return err(bytes.error);
    const secrets = rejectSecrets(wire);
    if (!secrets.ok) return err(secrets.error);
    const stem = `req-${envelope.engineId}-${formatSequence(envelope.seq)}-${envelope.requestId}`;
    try {
      writeExclusive(join(this.#requests, `${stem}.part`), bytes.value, join(this.#requests, `${stem}.json`));
    } catch {
      return err("io_failure");
    }
    return ok(envelope);
  }

  /** 取走并删除全部请求文件；解析失败的文件静默丢弃（内容可能是用户文本）。 */
  takeRequests(): RequestEnvelope[] {
    const found: RequestEnvelope[] = [];
    try {
      this.#preparePath(this.#requests);
    } catch {
      return found;
    }
    let names: string[];
    try {
      names = readdirSync(this.#requests).filter(isRequestFileName);
    } catch {
      return found;
    }
    names.sort(compareNames);
    for (const name of names) {
      const path = join(this.#requests, name);
      try {
        const parsed = parseRequest(readFileSync(path));
        if (parsed.ok) found.push(parsed.value);
      } catch {
        // 读取失败与解析失败一样：丢弃。
      } finally {
        try {
          unlinkSync(path);
        } catch {
          // 文件已被别处删除。
        }
      }
    }
    return found;
  }

  /**
   * 发布响应。
   *
   * 槽位里已有更新的响应时拒绝写入：这是「旧结果不得显示」在存储层的落点，
   * 新的一次输入已经产生答案时，迟到的旧答案必须消失而不是覆盖它。
   */
  publishResponse(
    request: RequestEnvelope,
    payload: JsonObject,
    now?: number,
  ): Result<boolean, FileIpcError> {
    let latest: ResponseRecord | null;
    try {
      latest = this.#readLatest(request.engineId);
    } catch {
      return err("io_failure");
    }
    if (latest !== null) {
      if (latest.seq > request.seq) return ok(false);
      if (latest.seq === request.seq && latest.requestId !== request.requestId) return ok(false);
    }
    const wire = responseWire({
      engineId: request.engineId,
      seq: request.seq,
      requestId: request.requestId,
      createdAt: now ?? this.#now(),
      payload,
    });
    const body = messageBytes(wire);
    if (!body.ok) return err(body.error);
    const secrets = rejectSecrets(wire);
    if (!secrets.ok) return err(secrets.error);
    const marker = readyMarkerWire({
      seq: request.seq,
      ts: now ?? this.#now(),
      body: body.value,
    });
    const markerBytes = messageBytes(marker);
    if (!markerBytes.ok) return err(markerBytes.error);
    const directory = join(this.#responses, request.engineId);
    const slot = responseSlotFor(request.seq);
    try {
      this.#preparePath(directory);
      this.#preparePath(this.#requests);
      try {
        unlinkSync(join(directory, `response-${slot}.ready`));
      } catch {
        // 没有旧标记是正常情况。
      }
      writeAll(join(directory, `response-${slot}.json`), body.value);
      writeAll(join(directory, `response-${slot}.ready`), markerBytes.value);
    } catch {
      return err("io_failure");
    }
    return ok(true);
  }

  /** 读取该引擎最新的一条响应；内容不自洽的槽位被跳过而不是报错。 */
  readLatestResponse(engineId: string): Result<ResponseRecord | null, FileIpcError> {
    if (!ENGINE_ID_PATTERN.test(engineId)) return err("invalid engine id");
    try {
      return ok(this.#readLatest(engineId as EngineId));
    } catch {
      return err("io_failure");
    }
  }

  /** 只有 request_id 与最新响应一致时才删除该槽位——旧答案被消费后不再重复呈现。 */
  consumeResponse(engineId: string, requestIdValue: string): Result<boolean, FileIpcError> {
    if (!ENGINE_ID_PATTERN.test(engineId)) return err("invalid engine id");
    const typed = engineId as EngineId;
    let response: ResponseRecord | null;
    try {
      response = this.#readLatest(typed);
    } catch {
      return err("io_failure");
    }
    if (response === null || response.requestId !== requestIdValue) return ok(false);
    const directory = join(this.#responses, typed);
    const slot = responseSlotFor(response.seq);
    try {
      for (const suffix of [".ready", ".json"]) {
        try {
          unlinkSync(join(directory, `response-${slot}${suffix}`));
        } catch {
          // 已经被删掉。
        }
      }
    } catch {
      return err("io_failure");
    }
    return ok(true);
  }

  /** 删除早于阈值的中转文件与空目录；启动时清掉上次崩溃留下的残骸。 */
  cleanTransientFiles(olderThan?: number): void {
    try {
      this.#preparePath(this.#requests);
      this.#preparePath(this.#responses);
    } catch {
      return;
    }
    for (const directory of [this.#requests, this.#responses]) {
      for (const path of collectFiles(directory)) {
        try {
          if (olderThan === undefined || statSync(path).mtimeMs / 1000 < olderThan) unlinkSync(path);
        } catch {
          // 文件已消失。
        }
      }
      pruneEmptyDirectories(directory);
    }
  }

  #readLatest(engineId: EngineId): ResponseRecord | null {
    const directory = join(this.#responses, engineId);
    const found: ResponseRecord[] = [];
    for (const slot of RESPONSE_SLOTS) {
      const record = readSlot(directory, slot, engineId, this.#now());
      if (record !== null) found.push(record);
    }
    let best: ResponseRecord | null = null;
    for (const record of found) {
      if (best === null || record.seq > best.seq) best = record;
    }
    return best;
  }
}
