/**
 * 设置页返回值的裁剪规则。
 *
 * 旧实现用 `_safe_metadata` 把任何要回给浏览器的结构压成「JSON 标量/容器」并丢掉
 * 敏感或体积大的键；`_safe_error` 则只放行一份固定的错误文案白名单，其它一律折成
 * `invalid_request`。两者都是**响应边界**，与领域逻辑无关，因此单独成模块。
 */
import type { JsonValue } from "../json/canonical.js";
import { SECRET_KEYS, casefold } from "../domain/secret-keys.js";

/** 旧实现的额外禁用键：预测正文、候选与置信度一律不得回给浏览器。 */
const EXTRA_FORBIDDEN_KEYS: readonly string[] = [
  "text",
  "state",
  "candidates",
  "choice",
  "probabilities",
  "confidence",
  "fits",
  "response",
];

function isForbiddenKey(key: string): boolean {
  const folded = casefold(key);
  return SECRET_KEYS.includes(folded) || EXTRA_FORBIDDEN_KEYS.includes(folded);
}

/**
 * 旧实现用 `isinstance(value, dict)` 判断要不要递归。
 * 这里认的是「纯对象」：`Date`、类实例、`Map` 都按不可序列化处理，折成 null。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 旧实现原样放行的错误文案。不在表内的错误一律变成 `invalid_request`，
 * 避免把内部路径、文件名或异常文本泄露到页面上。
 */
const SAFE_ERRORS: readonly string[] = [
  "settings must be a JSON object",
  "settings contain unsupported fields",
  "enabled must be a boolean",
  "local_only",
  "provider is unsupported",
  "local_model is invalid",
  "slot must be a positive integer",
  "local_wait_ms must be between 1 and 200",
  "log_mode must be off or metadata",
  "thresholds must be a small object",
  "threshold identity is invalid",
  "threshold must be a finite number between zero and one",
  "secrets are not supported in local settings",
];

export function safeError(value: string): string {
  return SAFE_ERRORS.includes(value) ? value : "invalid_request";
}

/**
 * 递归裁剪：对象丢禁用键，数组逐项裁剪，标量原样保留，其它（含非有限数）变成 null。
 * 旧实现对 Python 的 `NaN` 会走到底层的 JSON 编码异常，这里直接折成 null。
 */
export function safeMetadata(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map((item) => safeMetadata(item));
  if (isPlainObject(value)) {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (isForbiddenKey(key)) continue;
      result[key] = safeMetadata(item);
    }
    return result;
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return null;
}
