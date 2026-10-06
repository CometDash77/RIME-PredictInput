import { candidatesDigest, stateDigest, type DecisionInput } from "../domain/decision.js";
import { DEFAULT_CACHE_ENTRIES } from "../domain/cache-limits.js";
import type { PredictionOutcome } from "./outcome.js";

/** 缓存身份里除摘要之外的三个维度，与旧实现的 key 元组一一对应。 */
export interface CacheIdentity {
  readonly backend: string;
  readonly provider: string;
  readonly modelIdentity: string;
}

export { DEFAULT_CACHE_ENTRIES };

/**
 * 旧 `ResultCache`：最多 256 条、LRU、进出都深拷贝。
 *
 * 深拷贝不是洁癖：命中缓存后会往结果里写 `cache_hit` 再返回，共享同一个对象会让
 * 第二次调用看到上一次改过的字段。
 */
export class PredictionCache {
  readonly #maxEntries: number;
  readonly #items = new Map<string, PredictionOutcome>();

  constructor(maxEntries: number = DEFAULT_CACHE_ENTRIES) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("max_entries must be positive");
    this.#maxEntries = maxEntries;
  }

  static key(decision: DecisionInput, identity: CacheIdentity): string {
    return [
      stateDigest(decision),
      candidatesDigest(decision),
      `${identity.backend}:${identity.provider}`,
      identity.modelIdentity,
    ].join("\u0000");
  }

  get(decision: DecisionInput, identity: CacheIdentity): PredictionOutcome | null {
    const key = PredictionCache.key(decision, identity);
    const value = this.#items.get(key);
    if (value === undefined) return null;
    this.#items.delete(key);
    this.#items.set(key, value);
    return structuredClone(value);
  }

  put(decision: DecisionInput, identity: CacheIdentity, value: PredictionOutcome): void {
    const key = PredictionCache.key(decision, identity);
    this.#items.delete(key);
    this.#items.set(key, structuredClone(value));
    while (this.#items.size > this.#maxEntries) {
      const oldest = this.#items.keys().next();
      if (oldest.done === true) break;
      this.#items.delete(oldest.value);
    }
  }

  clear(): void {
    this.#items.clear();
  }

  get size(): number {
    return this.#items.size;
  }
}
