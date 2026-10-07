/**
 * 设置模型通道化扩展（spec #10，决策 09）的行为锁定。
 *
 * 三条硬约束：
 * - 向后兼容是字节级的：旧设置文件读入再写回，输出键集与顺序保持不变
 *   （新字段一律 omit-if-default）。
 * - 凭据豁免面窄到「已识别通道结构内的 api_key 槽位」；其余任何位置的
 *   凭据键名照旧被拒绝。
 * - 云端 opt-in 默认关闭：缺字段 = 本地通道、云端关，行为与通道化之前一致。
 */

import { describe, expect, it } from "vitest";

import {
  CLOUD_KINDS,
  DEFAULT_LOCAL_BASE_URL,
  DEFAULT_SETTINGS,
  MODEL_NAME_PATTERN,
  settingsEqual,
  settingsFromMapping,
  toWire,
} from "../src/domain/settings.js";
import type { Settings, SettingsError } from "../src/domain/settings.js";
import { expectOk, type Result } from "../src/domain/result.js";

const load = (result: Result<Settings, SettingsError>): Settings =>
  expectOk(result, (error) => "fixture must be valid: " + String(error));

const codeOf = (result: Result<Settings, SettingsError>): SettingsError => {
  if (result.ok) throw new Error("expected an error, got a valid settings");
  return result.error;
};

const LEGACY_WIRE_KEYS = [
  "enabled",
  "backend",
  "provider",
  "local_model",
  "slot",
  "local_wait_ms",
  "thresholds",
  "log_mode",
] as const;

const cloudMapping = {
  kind: "openai-chat",
  model: "gpt-4o-mini",
  api_key: "sk-test-123",
  base_url: null,
};

describe("向后兼容（字节级）", () => {
  it("旧 mapping 读入后 toWire 输出恰好八个旧键", () => {
    const settings = load(settingsFromMapping({ enabled: true, local_model: "qwen3:4b" }));
    const wire = toWire(settings);
    expect(Object.keys(wire)).toEqual([...LEGACY_WIRE_KEYS]);
  });

  it("缺新字段的域模型取通道缺省：本地端点、云端关", () => {
    const settings = load(settingsFromMapping({}));
    expect(settings.localBaseUrl).toBe(DEFAULT_LOCAL_BASE_URL);
    expect(settings.cloudEnabled).toBe(false);
    expect(settings.cloud).toBeNull();
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it("显式写回缺省值等价于缺字段", () => {
    const explicit = load(settingsFromMapping({ local_base_url: DEFAULT_LOCAL_BASE_URL, cloud_enabled: false, cloud: null }));
    expect(Object.keys(toWire(explicit))).toEqual([...LEGACY_WIRE_KEYS]);
  });

  it("DEFAULT_SETTINGS 写出仍是旧八键", () => {
    expect(Object.keys(toWire(DEFAULT_SETTINGS))).toEqual([...LEGACY_WIRE_KEYS]);
  });
});

describe("本地通道端点（YG 拍板 ③A）", () => {
  it("改写端点进入线格式并去掉尾斜杠", () => {
    const settings = load(settingsFromMapping({ local_base_url: "http://192.168.1.5:1234/v1/" }));
    expect(settings.localBaseUrl).toBe("http://192.168.1.5:1234/v1");
    expect(toWire(settings).local_base_url).toBe("http://192.168.1.5:1234/v1");
  });

  it.each([
    ["ftp://example.com"],
    ["not a url"],
    ["http://example.com/?x=1"],
    ["http://user:pass@example.com"],
    ["https://example.com/#frag"],
    [""],
  ])("拒绝端点 %s", (raw) => {
    expect(codeOf(settingsFromMapping({ local_base_url: raw }))).toBe("local_base_url must be a valid http(s) URL");
  });

  it("非字符串同样拒绝", () => {
    expect(codeOf(settingsFromMapping({ local_base_url: 42 }))).toBe("local_base_url must be a valid http(s) URL");
  });
});

describe("云端通道配置", () => {
  it("完整配置读入并原样写回", () => {
    const settings = load(settingsFromMapping({ cloud_enabled: true, cloud: cloudMapping }));
    expect(settings.cloudEnabled).toBe(true);
    expect(settings.cloud).toEqual({ kind: "openai-chat", model: "gpt-4o-mini", apiKey: "sk-test-123", baseUrl: null });
    expect(toWire(settings).cloud).toEqual(cloudMapping);
    expect(toWire(settings).cloud_enabled).toBe(true);
  });

  it("custom 端点去尾斜杠后保存", () => {
    const settings = load(
      settingsFromMapping({ cloud: { kind: "custom", model: "qwen3", api_key: "", base_url: "http://127.0.0.1:8000/v1/" } }),
    );
    expect(settings.cloud?.baseUrl).toBe("http://127.0.0.1:8000/v1");
  });

  it("四种 kind 都接受", () => {
    for (const kind of CLOUD_KINDS) {
      const mapping = { ...cloudMapping, kind, ...(kind === "custom" ? { base_url: "https://gw.example.com/v1" } : {}) };
      expect(load(settingsFromMapping({ cloud: mapping })).cloud?.kind).toBe(kind);
    }
  });

  it("键集不是恰好四键的 cloud 一律拒绝", () => {
    const message = "cloud must be an object with kind, model, api_key and base_url";
    expect(codeOf(settingsFromMapping({ cloud: { kind: "openai-chat" } }))).toBe(message);
    expect(codeOf(settingsFromMapping({ cloud: "openai-chat" }))).toBe(message);
    // 数组不是已识别结构 → 豁免失效，其内的 api_key 按凭据拦截。
    expect(codeOf(settingsFromMapping({ cloud: [cloudMapping] }))).toBe("secrets are not supported in local settings");
  });

  it("kind 不在封闭集内拒绝", () => {
    expect(codeOf(settingsFromMapping({ cloud: { ...cloudMapping, kind: "azure" } }))).toBe(
      "cloud kind must be openai-responses, openai-chat, anthropic or custom",
    );
  });

  it("custom 必须带端点；固定通道不允许端点", () => {
    expect(codeOf(settingsFromMapping({ cloud: { kind: "custom", model: "qwen3", api_key: "", base_url: null } }))).toBe(
      "custom channel requires base_url",
    );
    expect(codeOf(settingsFromMapping({ cloud: { ...cloudMapping, base_url: "https://proxy.example.com/v1" } }))).toBe(
      "base_url is only supported by the custom channel",
    );
  });

  it("模型名复用本地同一个字符集", () => {
    expect(MODEL_NAME_PATTERN.test("claude-sonnet-4-5-20250929")).toBe(true);
    expect(MODEL_NAME_PATTERN.test("ft:gpt-4o-mini:org:suffix")).toBe(true);
    expect(codeOf(settingsFromMapping({ cloud: { ...cloudMapping, model: "bad model" } }))).toBe("cloud model is invalid");
  });
});

describe("凭据槽豁免（YG 拍板 ②A）", () => {
  it("cloud.api_key 任意值不被凭据扫描拒绝", () => {
    const settings = load(settingsFromMapping({ cloud: { ...cloudMapping, api_key: "sk-super-secret" } }));
    expect(settings.cloud?.apiKey).toBe("sk-super-secret");
  });

  it("顶层与嵌套的凭据键名照旧拒绝", () => {
    expect(codeOf(settingsFromMapping({ api_key: "sk-x" }))).toBe("secrets are not supported in local settings");
    expect(codeOf(settingsFromMapping({ thresholds: { token: 1 } }))).toBe("secrets are not supported in local settings");
  });

  it("cloud 混入未知键时豁免失效，凭据扫描先拦截", () => {
    // 扫描先于结构校验：变形 cloud 里的 api_key 按凭据处理，绝不因结构不明而漏过。
    expect(codeOf(settingsFromMapping({ cloud: { ...cloudMapping, extra: 1 } }))).toBe(
      "secrets are not supported in local settings",
    );
  });

  it("api_key 非字符串按凭据拒绝；超长按结构拒绝", () => {
    expect(codeOf(settingsFromMapping({ cloud: { ...cloudMapping, api_key: 42 } }))).toBe(
      "secrets are not supported in local settings",
    );
    expect(codeOf(settingsFromMapping({ cloud: { ...cloudMapping, api_key: "k".repeat(4097) } }))).toBe(
      "cloud api_key must be a short string",
    );
  });
});

describe("cloud_enabled 开关", () => {
  it("非布尔拒绝", () => {
    expect(codeOf(settingsFromMapping({ cloud_enabled: "yes" }))).toBe("cloud_enabled must be a boolean");
  });

  it("开着开关但未填配置是合法的中间态（预测仍走本地）", () => {
    const settings = load(settingsFromMapping({ cloud_enabled: true }));
    expect(settings.cloudEnabled).toBe(true);
    expect(settings.cloud).toBeNull();
  });
});

describe("settingsEqual 覆盖通道字段", () => {
  const base = load(settingsFromMapping({}));
  const cloudA = load(settingsFromMapping({ cloud_enabled: true, cloud: cloudMapping }));
  const cloudB = load(settingsFromMapping({ cloud_enabled: true, cloud: { ...cloudMapping, api_key: "sk-rotated" } }));
  const compat = load(settingsFromMapping({ local_base_url: "http://192.168.1.5:1234/v1" }));

  it("云端开关与配置变化都被视为设置变更", () => {
    expect(settingsEqual(base, cloudA)).toBe(false);
    expect(settingsEqual(cloudA, cloudB)).toBe(false);
    expect(settingsEqual(base, compat)).toBe(false);
    expect(settingsEqual(cloudA, cloudA)).toBe(true);
  });
});
