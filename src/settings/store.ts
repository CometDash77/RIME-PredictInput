/**
 * settings.json 的读写边界。
 *
 * 这一层只做两件事：把磁盘上的字节变成一个已验证的 `Settings`，以及把 `Settings`
 * 原子地写回磁盘。写入路径刻意不覆盖并发写入的对方文件（overwrite:false 走硬链接），
 * 因为旧实现里“用户正在改设置、伴随进程同时写默认值”是真实发生过的丢设置来源。
 */

import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  DEFAULT_SETTINGS,
  MAX_SETTINGS_BYTES,
  settingsFromMapping,
  toWire,
  type Settings,
  type SettingsError,
} from "../domain/settings.js";
import type { SettingsStoreErrorCode } from "../domain/error-codes.js";
import { indented } from "../json/canonical.js";
import { isJsonObject, type JsonObject } from "../json/guards.js";
import { err, ok, type Result } from "../domain/result.js";
import type { AppPaths } from "../ipc/app-paths.js";
import { ensurePrivateDirectory } from "./private-directory.js";

export type SettingsStoreError = SettingsError | SettingsStoreErrorCode;

export interface SettingsStoreOptions {
  /** 目录加固钩子；默认在 Windows 上收紧 ACL。 */
  readonly prepareDirectory?: (directory: string) => void;
  /** 临时文件名的随机部分，测试里可注入以获得确定的字节。 */
  readonly randomHex?: (bytes: number) => string;
}

type ParsedJson =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

const LOCAL_BACKEND = "local";

function parseJsonBytes(raw: Uint8Array): ParsedJson {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return { ok: false };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return { ok: true, value: parsed };
  } catch {
    return { ok: false };
  }
}

/** 旧的 Cloud 偏好：保留原文件，但运行期一律按默认（本地）设置走。 */
function hasCloudPreference(raw: JsonObject): boolean {
  return (raw["backend"] ?? LOCAL_BACKEND) !== LOCAL_BACKEND || (raw["provider"] ?? null) !== null;
}

function writeExclusive(path: string, text: string): void {
  const descriptor = openSync(path, "wx");
  try {
    writeSync(descriptor, Buffer.from(text, "utf8"));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

export class SettingsStore {
  readonly #path: string;
  readonly #prepareDirectory: (directory: string) => void;
  readonly #randomHex: (bytes: number) => string;

  constructor(path: string, options: SettingsStoreOptions = {}) {
    if (!isAbsolute(path)) throw new Error("settings path must be absolute");
    this.#path = path;
    this.#prepareDirectory = options.prepareDirectory ?? ensurePrivateDirectory;
    this.#randomHex = options.randomHex ?? ((bytes: number) => randomBytes(bytes).toString("hex"));
  }

  get path(): string {
    return this.#path;
  }

  load(): Result<Settings, SettingsStoreError> {
    if (!existsSync(this.#path)) return ok(DEFAULT_SETTINGS);
    let raw: Uint8Array;
    try {
      raw = readFileSync(this.#path);
    } catch {
      return err("settings file is unreadable");
    }
    if (raw.byteLength > MAX_SETTINGS_BYTES) return err("settings file is too large");
    const parsed = parseJsonBytes(raw);
    if (!parsed.ok) return err("settings file is unreadable");
    if (isJsonObject(parsed.value) && hasCloudPreference(parsed.value)) return ok(DEFAULT_SETTINGS);
    return settingsFromMapping(parsed.value);
  }

  save(settings: Settings, options: { readonly overwrite?: boolean } = {}): Result<Settings, SettingsStoreError> {
    const validated = settingsFromMapping(toWire(settings));
    if (!validated.ok) return validated;
    const value = validated.value;
    const text = indented(toWire(value));
    const directory = dirname(this.#path);
    this.#prepareDirectory(directory);
    const temporary = join(directory, "." + basename(this.#path) + "." + this.#randomHex(8) + ".tmp");
    try {
      writeExclusive(temporary, text);
      if (options.overwrite === false) {
        try {
          linkSync(temporary, this.#path);
        } catch (error) {
          return err(isErrnoException(error) && error.code === "EEXIST" ? "settings_already_exists" : "settings_unwritable");
        }
      } else {
        renameSync(temporary, this.#path);
      }
    } catch {
      return err("settings_unwritable");
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        // 已改名或已链接走的临时文件不再存在，这里只是清理。
      }
    }
    return ok(value);
  }
}

/**
 * 把旧位置（%LOCALAPPDATA%\\rime-model-predict\\settings.json）的设置搬到用户目录。
 *
 * 目标已存在、没有旧文件或旧文件读不出来时都不动任何文件；只有真的搬成功才返回 true。
 */
export function migrateLegacySettings(paths: AppPaths, localAppData?: string | null): boolean {
  if (existsSync(paths.settings)) return false;
  const base = localAppData ?? process.env["LOCALAPPDATA"];
  if (base === undefined || base === "") return false;
  const legacy = join(base, "rime-model-predict", "settings.json");
  if (!isAbsolute(legacy)) throw new Error("legacy application data path must be absolute");
  if (!existsSync(legacy)) return false;
  const loaded = new SettingsStore(legacy).load();
  if (!loaded.ok) return false;
  ensurePrivateDirectory(paths.root);
  ensurePrivateDirectory(paths.requests);
  ensurePrivateDirectory(paths.responses);
  const saved = new SettingsStore(paths.settings).save(loaded.value, { overwrite: false });
  return saved.ok;
}
