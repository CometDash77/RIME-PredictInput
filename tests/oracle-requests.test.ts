/**
 * 请求信封的解析与重编码，逐字节对齐旧实现。
 *
 * 快照里的 raw 就是旧实现写进文件的那串字节；能原样重编出来，才说明
 * 数字拼写、键顺序与转义规则都没有漂移。
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { isRequestKind, parseRequest, requestWire } from "../src/contracts/envelope.js";
import { compact } from "../src/json/canonical.js";
import { requestCases } from "./support/oracle.js";

describe("请求信封", () => {
  it.each(requestCases())("%s", (_name, item) => {
    const raw = new TextEncoder().encode(item.raw);
    const result = parseRequest(raw);
    if (!item.result.ok) {
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe(item.result.code);
      return;
    }
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wire = requestWire(result.value);
    expect(wire).toEqual(item.result.value);
    // parse 与旧实现一样忽略未知的顶层键，而重编码只写信封字段：
    // 只有输入键集与信封一致时才谈得上逐字节还原。
    const input = z.record(z.string(), z.unknown()).parse(JSON.parse(item.raw));
    if (Object.keys(input).length === Object.keys(wire).length) {
      expect(compact(wire)).toBe(item.raw);
    } else {
      expect(Object.keys(wire)).not.toContain("extra");
    }
  });

  it("未知的 kind 不是合法的请求类型", () => {
    expect(isRequestKind("shutdown")).toBe(false);
    expect(isRequestKind("predict")).toBe(true);
  });
});
