/**
 * 评测资产：三次一致复跑 rig 的判分、指标与结论逻辑锁定。
 * 全部使用确定性假传输，不打任何真实端点。
 */

import { describe, expect, it } from "vitest";

import {
  FixtureTransport,
  HttpTransport,
  extractOutput,
  judgeVerdict,
  scoreSample,
  type ArmConfig,
  type FrozenSample,
  type ThresholdConfig,
  type TransportOutcome,
} from "../src/eval/rig.js";
import type { Transport } from "../src/eval/rig.js";

const READINGS = new Map<string, ReadonlySet<string>>([
  ["你", new Set(["ni"])],
  ["好", new Set(["hao"])],
  ["拟", new Set(["ni"])],
]);

const ARM: ArmConfig = {
  model: "fixture-model",
  response_kind: "raw",
  system: "test",
  user_template: "上文：{context}\n拼音：{pinyin}",
  transport: { kind: "fixture", file: "unused" },
};

function generationSample(overrides: Partial<FrozenSample> = {}): FrozenSample {
  return {
    id: "s1",
    kind: "generation",
    dimension: "outside-complete",
    precedingText: "前文",
    pinyin: "nihao",
    target: "拟好",
    labels: {
      "rime-ice": { inside_complete: false, rank: null, beyond_page: false, outside_complete: true },
      "rime-frost": { inside_complete: false, rank: null, beyond_page: false, outside_complete: true },
    },
    ...overrides,
  };
}

const okOutcome = (content: string): TransportOutcome => ({ kind: "ok", content, latencyMs: 5 });
const failureOutcome = (code: string): TransportOutcome => ({ kind: "failure", code, latencyMs: 5 });

const STRICT_THRESHOLD: ThresholdConfig = {
  frozen: false,
  min_outside_hit_rate: 0.6,
  min_hit_rate: 0.6,
  max_blank_rate: 0.3,
  max_error_rate: 0.1,
};

describe("extractOutput", () => {
  it("raw 直接返回内容", () => {
    expect(extractOutput("拟好", ARM)).toBe("拟好");
  });

  it("json-text-field 取 text 字段", () => {
    expect(extractOutput(JSON.stringify({ text: "拟好" }), { ...ARM, response_kind: "json-text-field" })).toBe("拟好");
  });

  it("坏 JSON 返回 null", () => {
    expect(extractOutput("{broken", { ...ARM, response_kind: "json-text-field" })).toBe(null);
  });
});

describe("scoreSample", () => {
  it("协议拒绝（不可整切）不发请求记 unsup", () => {
    const outcome = scoreSample(generationSample({ kind: "boundary", pinyin: "nh" }), okOutcome("拟好"), ARM, READINGS);
    expect(outcome.category).toBe("unsup");
  });

  it("精确命中目标记 hit", () => {
    const outcome = scoreSample(generationSample(), okOutcome("拟好"), ARM, READINGS);
    expect(outcome.category).toBe("hit");
  });

  it("通过校验但目标不等记 wrong", () => {
    const outcome = scoreSample(generationSample(), okOutcome("你好"), ARM, READINGS);
    expect(outcome.category).toBe("wrong");
  });

  it("校验失败（读音不符）记 blank", () => {
    const outcome = scoreSample(generationSample(), okOutcome("泥好"), ARM, READINGS);
    expect(outcome.category).toBe("blank");
  });

  it("传输失败记 error 并保留失败码", () => {
    const outcome = scoreSample(generationSample(), failureOutcome("http_500"), ARM, READINGS);
    expect(outcome.category).toBe("error");
    expect(outcome.failureCode).toBe("http_500");
  });

  it("响应形状失败记 error", () => {
    const outcome = scoreSample(generationSample(), okOutcome("not-json"), { ...ARM, response_kind: "json-text-field" }, READINGS);
    expect(outcome.category).toBe("error");
    expect(outcome.failureCode).toBe("invalid_response");
  });
});

describe("judgeVerdict", () => {
  const metricsOf = (outsideHits: number, hits: number, blanks: number, errors: number) => ({
    perSchema: {
      "rime-ice": { outsideTotal: 10, outsideHits, hits, blanks, errors },
      "rime-frost": { outsideTotal: 10, outsideHits, hits, blanks, errors },
    },
    total: 20,
    hits,
    blanks,
    errors,
    coldLatencyMs: 0,
    warmP50Ms: 0,
    warmP90Ms: 0,
    categories: {},
  });

  it("全部阈值满足判 pass", () => {
    expect(judgeVerdict(metricsOf(7, 14, 3, 0), STRICT_THRESHOLD)).toBe("pass");
  });

  it("候选外命中率不足判 fail", () => {
    expect(judgeVerdict(metricsOf(5, 14, 3, 0), STRICT_THRESHOLD)).toBe("fail");
  });

  it("任一 schema 不满足即 fail", () => {
    const metrics = metricsOf(7, 14, 3, 0);
    const first = metrics.perSchema["rime-ice"] as { outsideHits: number };
    (metrics.perSchema["rime-frost"] as { outsideHits: number }).outsideHits = 2;
    void first;
    expect(judgeVerdict(metrics, STRICT_THRESHOLD)).toBe("fail");
  });
});

describe("FixtureTransport", () => {
  it("按 id 返回确定内容，缺失记 fixture_missing", async () => {
    const transport: Transport = new FixtureTransport({ s1: "拟好", s2: { error: "timeout" } });
    const hit = await transport.call(generationSample({ id: "s1" }), ARM);
    expect(hit).toEqual({ kind: "ok", content: "拟好", latencyMs: expect.any(Number) });
    const err = await transport.call(generationSample({ id: "s2" }), ARM);
    expect(err).toEqual({ kind: "failure", code: "timeout", latencyMs: expect.any(Number) });
    const missing = await transport.call(generationSample({ id: "s3" }), ARM);
    expect(missing).toEqual({ kind: "failure", code: "fixture_missing", latencyMs: 0 });
  });
});

describe("HttpTransport", () => {
  it("请求体显式 think:false 且合并冻结采样参数；响应经 ChatResponseSchema 校验", async () => {
    const { createServer } = await import("node:http");
    const bodies: unknown[] = [];
    const server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
      });
      request.on("end", () => {
        bodies.push(JSON.parse(raw) as unknown);
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ model: "m", done: true, done_reason: "stop", message: { role: "assistant", content: "拟好" } }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no listen port");
    const transport: Transport = new HttpTransport();
    try {
      const outcome = await transport.call(generationSample(), {
        ...ARM,
        transport: { kind: "http", endpoint: `http://127.0.0.1:${address.port}` },
      });
      expect(outcome).toEqual({ kind: "ok", content: "拟好", latencyMs: expect.any(Number) });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const body = bodies[0] as Record<string, unknown>;
    expect(body["think"]).toBe(false);
    expect(body["stream"]).toBe(false);
    expect(body["model"]).toBe("fixture-model");
    expect(body["options"]).toEqual({ temperature: 0, seed: 19, num_predict: 32, num_ctx: 2048 });
    const messages = body["messages"] as { role: string; content: string }[];
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toBe("test");
    expect(messages[1]?.content).toBe("上文：前文\n拼音：nihao");
  });
});
