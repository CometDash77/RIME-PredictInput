/**
 * settings 校验与序列化顺序，逐条对齐旧实现。
 *
 * 键顺序不是美学问题：settings.json 的字节会被设置页与伴随进程同时读写，
 * 顺序变化会让「谁改的」这类比对失效。
 */

import { describe, expect, it } from "vitest";

import { settingsFromMapping, toWire } from "../src/domain/settings.js";
import { settingsCases } from "./support/oracle.js";

describe("设置校验", () => {
  it.each(settingsCases())("%s", (_name, item) => {
    const result = settingsFromMapping(item.mapping);
    if (!item.result.ok) {
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe(item.result.code);
      return;
    }
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 旧实现记录的是 from_mapping(...).to_mapping()，等价于这里的 toWire。
    expect(toWire(result.value)).toEqual(item.result.value);
  });
});
