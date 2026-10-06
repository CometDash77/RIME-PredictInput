import { err, ok, type Result } from "./result.js";
import type { SettingsErrorCode } from "./error-codes.js";
import { DEFAULT_MODEL } from "./model.js";
import { findSecretKey } from "./secret-keys.js";

export { DEFAULT_MODEL };

export const DEFAULT_SLOT = 5;
export const DEFAULT_LOCAL_WAIT_MS = 150;
export const MAX_LOCAL_WAIT_MS = 200;
export const MAX_SETTINGS_BYTES = 64 * 1024;
export const MAX_THRESHOLDS = 16;
export const MAX_SLOT = 2 ** 31 - 1;

export type LogMode = "off" | "metadata";
export type Backend = "local";

/** `ollama_policy.DEFAULT_MODEL` is 71 chars; the settings contract allows 80. */
export const MODEL_NAME_PATTERN = /^[A-Za-z0-9:._/-]{1,80}$/;
export const THRESHOLD_IDENTITY_PATTERN = /^[A-Za-z0-9:._/-]{1,160}$/;

/**
 * The first release is local-Ollama-only. Keeping `backend` and `provider` as
 * literal types means "cloud provider configured" is not a state this program
 * can represent, instead of a state that is merely rejected at runtime.
 */
export interface Settings {
  readonly enabled: boolean;
  readonly backend: Backend;
  readonly provider: null;
  readonly localModel: string;
  readonly slot: number;
  readonly localWaitMs: number;
  readonly thresholds: Readonly<Record<string, number>>;
  readonly logMode: LogMode;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: false,
  backend: "local",
  provider: null,
  localModel: DEFAULT_MODEL,
  slot: DEFAULT_SLOT,
  localWaitMs: DEFAULT_LOCAL_WAIT_MS,
  thresholds: {},
  logMode: "metadata",
};

/** Key order matters: it is the order `settings.json` is written in. */
export const SETTINGS_WIRE_KEYS = [
  "enabled",
  "backend",
  "provider",
  "local_model",
  "slot",
  "local_wait_ms",
  "thresholds",
  "log_mode",
] as const;

export type SettingsWire = {
  readonly enabled: boolean;
  readonly backend: string;
  readonly provider: null;
  readonly local_model: string;
  readonly slot: number;
  readonly local_wait_ms: number;
  readonly thresholds: Record<string, number>;
  readonly log_mode: string;
}

export function toWire(settings: Settings): SettingsWire {
  return {
    enabled: settings.enabled,
    backend: settings.backend,
    provider: null,
    local_model: settings.localModel,
    slot: settings.slot,
    local_wait_ms: settings.localWaitMs,
    thresholds: { ...settings.thresholds },
    log_mode: settings.logMode,
  };
}

const ALLOWED_KEYS = new Set<string>(SETTINGS_WIRE_KEYS);

/** 设置错误就是封闭码值本身，调用方只能拿到这些字符串。 */
export type SettingsError = SettingsErrorCode;

function settingsError(code: SettingsErrorCode): Result<never, SettingsError> {
  return err(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `settings.Settings.from_mapping` — the strict validator used by the writer. */
export function settingsFromMapping(raw: unknown): Result<Settings, SettingsError> {
  if (!isPlainObject(raw)) return settingsError("settings must be a JSON object");
  if (findSecretKey(raw) !== null) return settingsError("secrets are not supported in local settings");
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) return settingsError("settings contain unsupported fields");
  }

  const enabled = raw["enabled"] ?? false;
  const backend = raw["backend"] ?? "local";
  const provider = raw["provider"] ?? null;
  const localModel = raw["local_model"] ?? DEFAULT_MODEL;
  const slot = raw["slot"] ?? DEFAULT_SLOT;
  const localWaitMs = raw["local_wait_ms"] ?? DEFAULT_LOCAL_WAIT_MS;
  const thresholds = raw["thresholds"] ?? {};
  const logMode = raw["log_mode"] ?? "metadata";

  if (typeof enabled !== "boolean") return settingsError("enabled must be a boolean");
  if (backend !== "local" || provider !== null) return settingsError("local_only");
  if (typeof localModel !== "string" || !MODEL_NAME_PATTERN.test(localModel.trim())) {
    return settingsError("local_model is invalid");
  }
  if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 1 || slot > MAX_SLOT) {
    return settingsError("slot must be a positive integer");
  }
  if (
    typeof localWaitMs !== "number" ||
    !Number.isInteger(localWaitMs) ||
    localWaitMs < 1 ||
    localWaitMs > MAX_LOCAL_WAIT_MS
  ) {
    return settingsError("local_wait_ms must be between 1 and 200");
  }
  if (logMode !== "off" && logMode !== "metadata") return settingsError("log_mode must be off or metadata");
  if (!isPlainObject(thresholds) || Object.keys(thresholds).length > MAX_THRESHOLDS) {
    return settingsError("thresholds must be a small object");
  }

  const safeThresholds: Record<string, number> = {};
  for (const [identity, value] of Object.entries(thresholds)) {
    if (!THRESHOLD_IDENTITY_PATTERN.test(identity)) return settingsError("threshold identity is invalid");
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      return settingsError("threshold must be a finite number between zero and one");
    }
    safeThresholds[identity] = value;
  }

  return ok({
    enabled,
    backend: "local",
    provider: null,
    localModel: localModel.trim(),
    slot,
    localWaitMs,
    thresholds: safeThresholds,
    logMode,
  });
}

/**
 * 两份设置是否等价。
 *
 * 旧实现直接比较 `Settings` dataclass，阈值字典按内容比较；runtime 用它判断
 * 「延迟响应发出前设置是否已经变过」。
 */
export function settingsEqual(left: Settings, right: Settings): boolean {
  if (
    left.enabled !== right.enabled ||
    left.backend !== right.backend ||
    left.provider !== right.provider ||
    left.localModel !== right.localModel ||
    left.slot !== right.slot ||
    left.localWaitMs !== right.localWaitMs ||
    left.logMode !== right.logMode
  ) {
    return false;
  }
  const leftKeys = Object.keys(left.thresholds);
  if (leftKeys.length !== Object.keys(right.thresholds).length) return false;
  for (const key of leftKeys) {
    if (left.thresholds[key] !== right.thresholds[key]) return false;
  }
  return true;
}
