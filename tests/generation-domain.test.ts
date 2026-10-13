/**
 * S6：selection/generation 双模式的域层与策略层契约。
 *
 * 锁三件事：旧载荷（没有 mode 键）仍然按选择模式解析；生成模式的词条必须在
 * 「交给我们的候选集合」（即词库投影）里逐字命中，且读音与音节都对齐；生成策略
 * 与选择策略是两个身份，互不通用——已验收的选择组合不会顺手放行生成。
 */

import { describe, expect, it } from "vitest";

import {
  DECISION_MODES,
  decisionInputFromPayload,
  type GenerationDecision,
} from "../src/domain/decision.js";
import { MAX_GENERATED_SCALARS, normalizeReading, resolveGeneratedWord } from "../src/domain/generation.js";
import {
  GENERATION_POLICY_DIGEST,
  GENERATION_PROTOCOL,
  GENERATION_SAMPLING_OPTIONS,
  GENERATION_SYSTEM_PROMPT,
  VALIDATED_GENERATION_IDENTITY,
  VALIDATED_GENERATION_POLICY_DIGEST,
  generationCloudIdentityFor,
  generationIdentityFor,
  generationQuery,
  generationRequestBody,
  generationRequestWire,
  generationResponseFormat,
  isEligibleGenerationIdentity,
  parseGenerationAnswer,
  parseGenerationText,
} from "../src/contracts/generation.js";
import { POLICY_DIGEST, identityFor, isEligibleIdentity } from "../src/contracts/policy.js";
import { MODEL_DIGEST } from "../src/domain/model.js";
import { defaultSeparators } from "../src/json/canonical.js";
import { basePayload } from "./support/oracle.js";

const state = { task: "中文输入法候选选择", preceding_text: "我们今天去看", pinyin: "dianying" };

function generationPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "generation",
    state,
    candidates: ["电影", "电源"],
    candidate_fields: [
      { preedit: "dianying", start: 0, end: 8 },
      { preedit: "dianying", start: 0, end: 8 },
    ],
    ...overrides,
  };
}

function parse(payload: unknown): GenerationDecision {
  const parsed = decisionInputFromPayload(payload);
  if (!parsed.ok) throw new Error("夹具负载必须可用: " + parsed.error);
  if (parsed.value.mode !== "generation") throw new Error("夹具负载必须是生成模式");
  return parsed.value;
}

const dianying = parse(generationPayload());

describe("决策模式的线格式判别", () => {
  it("旧载荷没有 mode 键，仍解析为选择模式", () => {
    const parsed = decisionInputFromPayload(basePayload);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.mode).toBe("selection");
  });

  it("mode 显式缺席或为 null 时按选择模式处理", () => {
    for (const value of [undefined, null]) {
      const parsed = decisionInputFromPayload({ ...generationPayload(), mode: value });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.mode).toBe("selection");
    }
  });

  it("mode 为 generation 时判别为生成模式", () => {
    expect(dianying.mode).toBe("generation");
    expect(DECISION_MODES).toEqual(["selection", "generation"]);
  });

  it("未知的 mode 值一律拒绝，不猜", () => {
    for (const value of ["Generation", "select", "", 1, {}, []]) {
      const parsed = decisionInputFromPayload({ ...generationPayload(), mode: value });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.error).toBe("invalid_mode");
    }
  });

  it("两种模式共用同一份状态与候选校验", () => {
    const broken = decisionInputFromPayload({ ...generationPayload(), candidates: [] });
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toBe("invalid_candidates");
  });
});

describe("词库内生成校验", () => {
  it("命中的词条映射为 1 起的候选显示编号", () => {
    const first = resolveGeneratedWord("电影", dianying);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value).toBe(1);
    const second = resolveGeneratedWord("电源", dianying);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value).toBe(2);
  });

  it("词库外的新词一律拒绝（不造词）", () => {
    const result = resolveGeneratedWord("电能", dianying);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("not_in_lexicon");
  });

  it("空串、非汉字与超长都在协议层拒绝", () => {
    const empty = resolveGeneratedWord("", dianying);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toBe("empty_text");

    const latin = resolveGeneratedWord("dianying", dianying);
    expect(latin.ok).toBe(false);
    if (!latin.ok) expect(latin.error).toBe("invalid_character");

    const long = resolveGeneratedWord("电".repeat(MAX_GENERATED_SCALARS + 1), dianying);
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error).toBe("too_long");
  });

  it("音节无法与字数对齐时拒绝", () => {
    const decision = parse({ ...generationPayload(), state: { ...state, pinyin: "dianyingxyz" } });
    const result = resolveGeneratedWord("电影", decision);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("syllable_mismatch");
  });

  it("词条的读音与本次拼音不一致时拒绝", () => {
    const decision = parse({ ...generationPayload(), state: { ...state, pinyin: "dianyin" } });
    const result = resolveGeneratedWord("电影", decision);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("reading_mismatch");
  });

  it("读音归一化只看字母，撇号与大小写不改变判定", () => {
    expect(normalizeReading(" Dian'Ying ")).toBe("dianying");
    const decision = parse({
      ...generationPayload(),
      candidate_fields: [
        { preedit: "dian'ying", start: 0, end: 8 },
        { preedit: "dianying", start: 0, end: 8 },
      ],
    });
    const result = resolveGeneratedWord("电影", decision);
    expect(result.ok).toBe(true);
  });
});

describe("生成请求的线上形状", () => {
  it("查询带协议、拼音、音节切分与候选窗（协议 v2，#34）", () => {
    expect(generationQuery(dianying)).toEqual({
      protocol: GENERATION_PROTOCOL,
      raw_input: "dianying",
      preceding_text: "我们今天去看",
      // 冻结切分器给出全部合法切分（DP 序），不做唯一化：「不规定唯一解释」是提示词
      // 里的原话，请求也因此把歧义如实交给模型。
      reference_pinyin: [
        ["di", "an", "ying"],
        ["dian", "ying"],
      ],
      // 协议 v2：候选列表进请求（权重序窗），响应枚举以它为唯一自由度。
      candidates: ["电影", "电源"],
    });
  });

  it("请求体沿用冻结的生成策略：提示词、格式与采样参数", () => {
    const body = generationRequestBody(dianying, "some-model");
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    expect(body.value.messages[0]).toEqual({ role: "system", content: GENERATION_SYSTEM_PROMPT });
    expect(body.value.messages[1].content).toBe(defaultSeparators(generationQuery(dianying)));
    expect(body.value.format).toEqual(generationResponseFormat(["电影", "电源"]));
    expect(body.value.options).toEqual(GENERATION_SAMPLING_OPTIONS);
    expect(body.value.keepAlive).toBe("60s");
  });

  it("线格式键序与选择模式一致，便于两种模式对照", () => {
    const body = generationRequestBody(dianying, "some-model");
    if (!body.ok) throw new Error("夹具请求体必须可用");
    const wire = generationRequestWire(body.value);
    expect(Object.keys(wire)).toEqual(["model", "stream", "think", "keep_alive", "messages", "format", "options"]);
    expect(wire["format"]).toEqual(body.value.format);
    expect(generationRequestWire(body.value, { keepAlive: false })).not.toHaveProperty("keep_alive");
  });

  it("无法切分或切分过多的拼音在发问前就拒绝", () => {
    const unsupported = parse({ ...generationPayload(), state: { ...state, pinyin: "dxx" } });
    const unsupportedBody = generationRequestBody(unsupported, "some-model");
    expect(unsupportedBody.ok).toBe(false);
    if (!unsupportedBody.ok) expect(unsupportedBody.error).toBe("unsupported_input");

    // 切分超过冻结上限（32 条）→ ambiguous_input，不替模型挑一种解释。
    // "anan"×5 的切分数量超过上限（实测 64，越过 32 的闸门）。
    const ambiguous = parse({ ...generationPayload(), state: { ...state, pinyin: "anan".repeat(5) } });
    const ambiguousBody = generationRequestBody(ambiguous, "some-model");
    expect(ambiguousBody.ok).toBe(false);
    if (!ambiguousBody.ok) expect(ambiguousBody.error).toBe("ambiguous_input");
  });
});

describe("生成答案的解析", () => {
  it("恰一个 text 键，null 表示模型拒答", () => {
    expect(parseGenerationAnswer({ text: "电影" })).toEqual({ ok: true, value: "电影" });
    expect(parseGenerationAnswer({ text: null })).toEqual({ ok: true, value: null });
    expect(parseGenerationAnswer({ text: "电影", choice: 1 })).toEqual({ ok: false, error: "invalid_model_response" });
    expect(parseGenerationAnswer({ choice: 1 })).toEqual({ ok: false, error: "invalid_model_response" });
    expect(parseGenerationAnswer({ text: 3 })).toEqual({ ok: false, error: "invalid_model_response" });
  });

  it("文本层拒绝重复键与非法 JSON", () => {
    expect(parseGenerationText('{"text":"电影"}')).toEqual({ ok: true, value: "电影" });
    expect(parseGenerationText('{"text":"电影","text":"电源"}')).toEqual({ ok: false, error: "invalid_model_response" });
    expect(parseGenerationText("电影")).toEqual({ ok: false, error: "invalid_model_response" });
    expect(parseGenerationText("")).toEqual({ ok: false, error: "invalid_model_response" });
  });
});

describe("生成策略身份与选择策略身份互相隔离", () => {
  it("两个策略摘要不同，模型身份也因此不同", () => {
    expect(GENERATION_POLICY_DIGEST).not.toBe(POLICY_DIGEST);
    const generation = generationIdentityFor(MODEL_DIGEST);
    expect(generation).not.toBe(identityFor(MODEL_DIGEST));
    expect(generation.startsWith("ollama:")).toBe(true);
  });

  it("没有已验收的生成策略时，Ollama 生成身份一律不合格", () => {
    expect(VALIDATED_GENERATION_POLICY_DIGEST).toBeNull();
    expect(VALIDATED_GENERATION_IDENTITY).toBeNull();
    expect(isEligibleGenerationIdentity(generationIdentityFor(MODEL_DIGEST))).toBe(false);
    expect(isEligibleIdentity(identityFor(MODEL_DIGEST))).toBe(true);
  });

  it("契约验收集通道沿用选择模式的同一套前缀规则", () => {
    const compat = generationCloudIdentityFor("local-compat", "http://127.0.0.1:1234", "m");
    expect(compat.startsWith("local-compat:")).toBe(true);
    expect(isEligibleGenerationIdentity(compat)).toBe(true);
    expect(isEligibleGenerationIdentity(generationCloudIdentityFor("custom", "https://example.invalid/v1", "m"))).toBe(true);
    expect(isEligibleGenerationIdentity("prototype-generation:abc")).toBe(false);
  });
});
