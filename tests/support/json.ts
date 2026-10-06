/**
 * 测试辅助：把 schema 验证过的外部数据转成项目内部的 JSON 类型。
 *
 * 快照文件是外部输入。schema 只能证明它「是 JSON」，不能证明它符合 `JsonValue`；
 * 这里的转换就是那条边界，转换过程本身不改动任何数据。
 */
import type { JsonValue } from "../../src/json/canonical.js";
import { isJsonObject, type JsonObject } from "../../src/json/guards.js";

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((item: unknown) => toJsonValue(item));
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) result[key] = toJsonValue(item);
    return result;
  }
  throw new Error("value is not representable as JSON");
}

export function toJsonObject(value: unknown): JsonObject {
  const converted = toJsonValue(value);
  if (!isJsonObject(converted)) throw new Error("value is not a JSON object");
  return converted;
}
