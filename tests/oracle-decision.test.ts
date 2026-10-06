/**
 * 决策输入的校验与缓存身份，逐条对齐旧实现。
 *
 * 这一层是「什么算合法输入」的唯一入口：Lua 滤镜送进来的 JSON 先经过它，
 * 只有通过校验的数据才允许进入模型调用与缓存键计算。
 */

import { describe, expect, it } from "vitest";

import { candidatesDigest, decisionInputFromPayload, stateDigest } from "../src/domain/decision.js";
import { decisionCases } from "./support/oracle.js";

describe("决策输入", () => {
  it.each(decisionCases())("%s", (_name, item) => {
    const result = decisionInputFromPayload(item.payload);
    if (!item.result.ok) {
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe(item.result.code);
      return;
    }
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(stateDigest(result.value)).toBe(item.state_digest);
    expect(candidatesDigest(result.value)).toBe(item.candidates_digest);
  });

  it("缺少候选字段与显式 null 得到同一个候选摘要", () => {
    const without = decisionInputFromPayload({
      state: { task: "中文输入法候选选择", preceding_text: "我们今天去看", pinyin: "dianying" },
      candidates: ["电影", "电源", "电涌", "电阻", "电工"],
    });
    const explicit = decisionInputFromPayload({
      state: { task: "中文输入法候选选择", preceding_text: "我们今天去看", pinyin: "dianying" },
      candidates: ["电影", "电源", "电涌", "电阻", "电工"],
      candidate_fields: null,
    });
    expect(without.ok).toBe(true);
    expect(explicit.ok).toBe(true);
    if (!without.ok || !explicit.ok) return;
    expect(candidatesDigest(without.value)).toBe(candidatesDigest(explicit.value));
  });
});
