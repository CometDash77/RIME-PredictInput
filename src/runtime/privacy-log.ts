/**
 * 允许清单式诊断日志：只写短元数据码，限行宽、限龄、限总量。
 *
 * 与旧 `privacy_log.py` 对齐：写入前按 1 MiB 上限轮转、写入后按 7 天与 5 MiB 修剪；
 * 永不记录用户正文、候选或模型回答。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { isSafeMetadataCode } from "../domain/error-codes.js";
import type { LogMode } from "../domain/settings.js";
import { compact, type JsonValue } from "../json/canonical.js";

export const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
export const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const MAX_FILE_BYTES = 1024 * 1024;
export const ROTATED_COPIES = 5;
export const MAX_DURATION_MS = 3_600_000;

export interface MetadataLoggerOptions {
  readonly mode?: LogMode;
  /** 墙钟秒数，用来给每行打 UTC 时间戳并判断日志年龄。 */
  readonly now?: () => number;
}

/** Python `datetime.fromtimestamp(t, timezone.utc).isoformat()` 的等价输出。 */
export function pythonIsoformatUtc(seconds: number): string {
  const totalMicroseconds = Math.round(seconds * 1_000_000);
  const microseconds = ((totalMicroseconds % 1_000_000) + 1_000_000) % 1_000_000;
  const whole = Math.floor(totalMicroseconds / 1_000_000);
  const date = new Date(whole * 1000).toISOString();
  const fraction = microseconds === 0 ? "" : `.${String(microseconds).padStart(6, "0")}`;
  return `${date.slice(0, 19)}${fraction}+00:00`;
}

/** Python `round(value, digits)` 用的是 banker's rounding，这里保持一致。 */
function roundHalfEven(value: number, digits: number): number {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const lower = Math.floor(scaled);
  if (scaled - lower === 0.5) {
    return (lower % 2 === 0 ? lower : lower + 1) / factor;
  }
  return Math.round(scaled) / factor;
}

function removeIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // 文件本来就不在；旧实现同样忽略 FileNotFoundError。
  }
}

function modifiedSeconds(path: string): number | null {
  try {
    return statSync(path).mtimeMs / 1000;
  } catch {
    return null;
  }
}

export class MetadataLogger {
  readonly #path: string;
  readonly #now: () => number;
  #mode: LogMode;

  constructor(path: string, options: MetadataLoggerOptions = {}) {
    this.#path = path;
    this.#now = options.now ?? (() => Date.now() / 1000);
    this.#mode = options.mode ?? "metadata";
  }

  get path(): string {
    return this.#path;
  }

  get mode(): LogMode {
    return this.#mode;
  }

  set mode(value: LogMode) {
    this.#mode = value;
  }

  write(event: string, status: string, durationMs: number | null = null, errorCode: string | number | null = null): void {
    if (this.#mode === "off") return;
    if (!isSafeMetadataCode(event) || !isSafeMetadataCode(status)) {
      throw new Error("diagnostic values must be short metadata codes");
    }
    if (errorCode !== null && !isSafeMetadataCode(String(errorCode))) {
      throw new Error("error_code must be a metadata code");
    }
    if (
      durationMs !== null &&
      (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > MAX_DURATION_MS)
    ) {
      throw new Error("duration_ms is invalid");
    }

    const row: Record<string, JsonValue> = { ts: pythonIsoformatUtc(this.#now()), event, status };
    if (durationMs !== null) row["duration_ms"] = roundHalfEven(durationMs, 3);
    if (errorCode !== null) row["error_code"] = String(errorCode);
    const encoded = Buffer.from(`${compact(row)}\n`, "utf8");

    mkdirSync(dirname(this.#path), { recursive: true });
    this.#rotateIfNeeded(encoded.byteLength);
    appendFileSync(this.#path, encoded);
    this.#prune();
  }

  /** 已轮转的副本，按修改时间从新到旧。 */
  #rotated(): string[] {
    const directory = dirname(this.#path);
    const prefix = `${basename(this.#path)}.`;
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      return [];
    }
    const found: { path: string; modified: number }[] = [];
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const candidate = join(directory, name);
      const modified = modifiedSeconds(candidate);
      if (modified === null) continue;
      found.push({ path: candidate, modified });
    }
    found.sort((left, right) => right.modified - left.modified);
    return found.map((entry) => entry.path);
  }

  #sibling(index: number): string {
    return join(dirname(this.#path), `${basename(this.#path)}.${index}`);
  }

  #rotateIfNeeded(incoming: number): void {
    if (!existsSync(this.#path)) return;
    const current = modifiedSeconds(this.#path);
    if (current === null) return;
    let size: number;
    try {
      size = statSync(this.#path).size;
    } catch {
      return;
    }
    if (size + incoming <= MAX_FILE_BYTES) return;

    removeIfExists(this.#sibling(ROTATED_COPIES));
    for (let index = ROTATED_COPIES - 1; index > 0; index -= 1) {
      const source = this.#sibling(index);
      const target = this.#sibling(index + 1);
      removeIfExists(target);
      if (existsSync(source)) renameSync(source, target);
    }
    renameSync(this.#path, this.#sibling(1));
  }

  #prune(): void {
    const cutoff = this.#now() - MAX_AGE_SECONDS;
    for (const path of [this.#path, ...this.#rotated()]) {
      if (!existsSync(path)) continue;
      const modified = modifiedSeconds(path);
      if (modified !== null && modified < cutoff) removeIfExists(path);
    }

    const survivors: { path: string; modified: number; size: number }[] = [];
    for (const path of [this.#path, ...this.#rotated()]) {
      const modified = modifiedSeconds(path);
      if (modified === null) continue;
      try {
        survivors.push({ path, modified, size: statSync(path).size });
      } catch {
        // 文件在枚举与 stat 之间消失；跳过。
      }
    }
    let total = survivors.reduce((sum, entry) => sum + entry.size, 0);
    survivors.sort((left, right) => left.modified - right.modified);
    for (const entry of survivors) {
      if (total <= MAX_TOTAL_BYTES) break;
      removeIfExists(entry.path);
      total -= entry.size;
    }
  }
}
