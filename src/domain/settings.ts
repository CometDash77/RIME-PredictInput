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

/**
 * 本地通道的缺省端点（Ollama）。传输选择与它绑定：等于它 → Ollama 原生 /api/chat
 * （冻结字节与已验收身份）；改写为任何其他 OpenAI 兼容端点 → /chat/completions。
 */
export const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434";

export type LogMode = "off" | "metadata";
export type Backend = "local";

/** 云端通道四种形态；custom = OpenAI Chat 兼容 wire + 自由端点（决策 09）。 */
export type CloudKind = "openai-responses" | "openai-chat" | "anthropic" | "custom";

export const CLOUD_KINDS: readonly CloudKind[] = ["openai-responses", "openai-chat", "anthropic", "custom"];

export const MAX_URL_LENGTH = 2048;
export const MAX_API_KEY_LENGTH = 4096;

/** 云端通道配置；`api_key` 是设置文件里唯一被豁免凭据扫描的字段槽位（YG 拍板 ②A）。 */
export interface CloudChannel {
  readonly kind: CloudKind;
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl: string | null;
}

/** `ollama_policy.DEFAULT_MODEL` is 71 chars; the settings contract allows 80. */
export const MODEL_NAME_PATTERN = /^[A-Za-z0-9:._/-]{1,80}$/;
export const THRESHOLD_IDENTITY_PATTERN = /^[A-Za-z0-9:._/-]{1,160}$/;

/**
 * The first release keeps `backend`/`provider` as frozen literals (wire
 * compatibility); the channel choice lives in `cloudEnabled`/`cloud`, which are
 * absent in legacy files and default to "local only, cloud off".
 */
export interface Settings {
  readonly enabled: boolean;
  readonly backend: Backend;
  readonly provider: null;
  readonly localModel: string;
  readonly localBaseUrl: string;
  readonly cloudEnabled: boolean;
  readonly cloud: CloudChannel | null;
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
  localBaseUrl: DEFAULT_LOCAL_BASE_URL,
  cloudEnabled: false,
  cloud: null,
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
  "local_base_url",
  "cloud_enabled",
  "cloud",
] as const;

export type CloudChannelWire = {
  readonly kind: CloudKind;
  readonly model: string;
  readonly api_key: string;
  readonly base_url: string | null;
}

export type SettingsWire = {
  readonly enabled: boolean;
  readonly backend: string;
  readonly provider: null;
  readonly local_model: string;
  readonly slot: number;
  readonly local_wait_ms: number;
  readonly thresholds: Record<string, number>;
  readonly log_mode: string;
} & {
  /** 非缺省才写出：旧设置文件读入再写回，字节保持不变（oracle 兼容义务）。 */
  readonly local_base_url?: string;
  readonly cloud_enabled?: boolean;
  readonly cloud?: CloudChannelWire;
}

function cloudToWire(cloud: CloudChannel): CloudChannelWire {
  return { kind: cloud.kind, model: cloud.model, api_key: cloud.apiKey, base_url: cloud.baseUrl };
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
    ...(settings.localBaseUrl === DEFAULT_LOCAL_BASE_URL ? {} : { local_base_url: settings.localBaseUrl }),
    ...(settings.cloudEnabled ? { cloud_enabled: true } : {}),
    ...(settings.cloud === null ? {} : { cloud: cloudToWire(settings.cloud) }),
  };
}

const ALLOWED_KEYS = new Set<string>(SETTINGS_WIRE_KEYS);

const CLOUD_WIRE_KEYS = ["kind", "model", "api_key", "base_url"] as const;

/** 设置错误就是封闭码值本身，调用方只能拿到这些字符串。 */
export type SettingsError = SettingsErrorCode;

function settingsError(code: SettingsErrorCode): Result<never, SettingsError> {
  return err(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 端点校验：http(s)、无 userinfo/query/hash、长度受限；返回去掉尾斜杠的规范化值。
 * 拼接规则是 `<base>/chat/completions` 一类路径追加，base 需自带版本段（如 /v1）。
 */
export function normalizeBaseUrl(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed === "" ? null : trimmed;
}

/**
 * 凭据槽豁免（YG 拍板 ②A）：仅当顶层 `cloud` 的键集恰好是通道契约四键且
 * `api_key` 是字符串时，才把它从扫描副本里剥掉。其余任何位置（顶层、嵌套、
 * 变形的 cloud）照旧被 findSecretKey 拒绝——豁免面窄到「已识别通道结构内的
 * 一个具名字段」。
 */
function withoutCredentialSlot(raw: Record<string, unknown>): Record<string, unknown> {
  const cloud = raw["cloud"];
  if (!isPlainObject(cloud)) return raw;
  const keys = Object.keys(cloud);
  if (keys.length !== CLOUD_WIRE_KEYS.length) return raw;
  if (!CLOUD_WIRE_KEYS.every((key) => key in cloud)) return raw;
  if (typeof cloud["api_key"] !== "string") return raw;
  const { api_key: _slot, ...rest } = cloud;
  return { ...raw, cloud: rest };
}

/** `settings.Settings.from_mapping` — the strict validator used by the writer. */
export function settingsFromMapping(raw: unknown): Result<Settings, SettingsError> {
  if (!isPlainObject(raw)) return settingsError("settings must be a JSON object");
  if (findSecretKey(withoutCredentialSlot(raw)) !== null) return settingsError("secrets are not supported in local settings");
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
  const localBaseUrl = raw["local_base_url"] ?? DEFAULT_LOCAL_BASE_URL;
  const cloudEnabled = raw["cloud_enabled"] ?? false;
  const cloud = raw["cloud"] ?? null;

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

  // ---- 通道扩展（spec #10：向后兼容；缺字段 = 本地通道、云端关） ----
  if (typeof cloudEnabled !== "boolean") return settingsError("cloud_enabled must be a boolean");
  let localEndpoint = DEFAULT_LOCAL_BASE_URL;
  if (localBaseUrl !== DEFAULT_LOCAL_BASE_URL) {
    if (typeof localBaseUrl !== "string") return settingsError("local_base_url must be a valid http(s) URL");
    const normalized = normalizeBaseUrl(localBaseUrl);
    if (normalized === null) return settingsError("local_base_url must be a valid http(s) URL");
    localEndpoint = normalized;
  }
  let cloudChannel: CloudChannel | null = null;
  if (cloud !== null) {
    if (!isPlainObject(cloud)) return settingsError("cloud must be an object with kind, model, api_key and base_url");
    const keys = Object.keys(cloud);
    if (keys.length !== CLOUD_WIRE_KEYS.length || !CLOUD_WIRE_KEYS.every((key) => key in cloud)) {
      return settingsError("cloud must be an object with kind, model, api_key and base_url");
    }
    const kind = cloud["kind"];
    if (typeof kind !== "string" || !CLOUD_KINDS.includes(kind as CloudKind)) {
      return settingsError("cloud kind must be openai-responses, openai-chat, anthropic or custom");
    }
    const model = cloud["model"];
    if (typeof model !== "string" || !MODEL_NAME_PATTERN.test(model.trim())) {
      return settingsError("cloud model is invalid");
    }
    const apiKey = cloud["api_key"];
    if (typeof apiKey !== "string" || apiKey.length > MAX_API_KEY_LENGTH) {
      return settingsError("cloud api_key must be a short string");
    }
    const baseUrl = cloud["base_url"];
    if (baseUrl !== null && typeof baseUrl !== "string") {
      return settingsError("cloud base_url must be a valid http(s) URL");
    }
    let cloudEndpoint: string | null = null;
    if (typeof baseUrl === "string") {
      if (kind !== "custom") return settingsError("base_url is only supported by the custom channel");
      const normalized = normalizeBaseUrl(baseUrl);
      if (normalized === null) return settingsError("cloud base_url must be a valid http(s) URL");
      cloudEndpoint = normalized;
    } else if (kind === "custom") {
      return settingsError("custom channel requires base_url");
    }
    cloudChannel = { kind: kind as CloudKind, model: model.trim(), apiKey, baseUrl: cloudEndpoint };
  }

  return ok({
    enabled,
    backend: "local",
    provider: null,
    localModel: localModel.trim(),
    localBaseUrl: localEndpoint,
    cloudEnabled,
    cloud: cloudChannel,
    slot,
    localWaitMs,
    thresholds: safeThresholds,
    logMode,
  });
}

function cloudEqual(left: CloudChannel | null, right: CloudChannel | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.kind === right.kind &&
    left.model === right.model &&
    left.apiKey === right.apiKey &&
    left.baseUrl === right.baseUrl
  );
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
    left.localBaseUrl !== right.localBaseUrl ||
    left.cloudEnabled !== right.cloudEnabled ||
    left.slot !== right.slot ||
    left.localWaitMs !== right.localWaitMs ||
    left.logMode !== right.logMode
  ) {
    return false;
  }
  if ((left.cloud === null) !== (right.cloud === null)) return false;
  if (!cloudEqual(left.cloud, right.cloud)) return false;
  const leftKeys = Object.keys(left.thresholds);
  if (leftKeys.length !== Object.keys(right.thresholds).length) return false;
  for (const key of leftKeys) {
    if (left.thresholds[key] !== right.thresholds[key]) return false;
  }
  return true;
}
