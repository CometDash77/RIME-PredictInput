import type { JsonValue } from "./canonical.js";

/** 一个已经过 JSON 结构检查的对象；嵌套值仍按未知数据处理。 */
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * 只承认非 null、非数组的对象。
 *
 * 边界上唯一需要的结构判定：数据来自 JSON.parse 或 IPC 文件，嵌套值的形状由下游
 * 领域校验负责，这里不重复递归检查。
 */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
