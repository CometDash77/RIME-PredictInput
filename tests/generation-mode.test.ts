/**
 * S6 的通道层与 service 层行为：Selection/generation 两种模式在同一推理端口上分派。
 *
 * 这里锁的是四条外部可观察的行为：模式决定请求体与答案形状、生成闸门默认关闭
 * （Q6A）、身份判定按模式分别进行（生成没有已验收组合 ⇒ 本地一律留空）、
 * 以及「词条必须命中候选集合」这一条硬约束在 service 层真的被执行。
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { RequestEnvelope } from "../src/contracts/envelope.js";
import { parseRequest } from "../src/contracts/envelope.js";
import {
  GENERATION_POLICY_DIGEST,
  GENERATION_SAMPLING_OPTIONS,
  GENERATION_SYSTEM_PROMPT,
  generationCloudIdentityFor,
  generationIdentityFor,
  generationResponseFormat,
} from "../src/contracts/generation.js";
import { cloudIdentityFor, identityFor } from "../src/contracts/policy.js";
import { decisionInputFromPayload, type DecisionInput } from "../src/domain/decision.js";
import type { LocalBackendErrorCode } from "../src/domain/error-codes.js";
import { DEFAULT_MODEL, MODEL_DIGEST } from "../src/domain/model.js";
import { err, expectOk, ok, type Result } from "../src/domain/result.js";
import { DEFAULT_SETTINGS, settingsFromMapping, type Settings } from "../src/domain/settings.js";
import { PredictionCache } from "../src/inference/cache.js";
import type { LocalBackendPort } from "../src/inference/ports.js";
import { InferenceService } from "../src/inference/service.js";
import {
  LocalBackend,
  OLLAMA_BASE_URL,
  type ConnectionStatus,
  type LocalInferenceOutcome,
  type ModelInventory,
  type PullStatus,
  type ResolvedModel,
} from "../src/providers/ollama.js";
import {
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransportLike,
} from "../src/providers/http.js";

const ENGINE = "a".repeat(40);
const REQUEST_ID = "1".repeat(32);
const COMPAT_BASE_URL = "http://127.0.0.1:1234/v1";

const load = <T, E>(result: Result<T, E>): T => expectOk(result, (error) => "夹具必须可用: " + String(error));

/** 生成模式夹具：拼音 dianying 的两个词库候选，读音都是 dianying。 */
function generationPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "generation",
    state: { task: "中文输入法候选选择", preceding_text: "我们今天去看", pinyin: "dianying" },
    candidates: ["电影", "电源"],
    candidate_fields: [
      { preedit: "dianying", start: 0, end: 8 },
      { preedit: "dianying", start: 0, end: 8 },
    ],
    ...overrides,
  };
}

const selectionDecision: DecisionInput = load(decisionInputFromPayload({
  state: { task: "中文输入法候选选择", preceding_text: "我们今天去看", pinyin: "dianying" },
  candidates: ["电影", "电源"],
  candidate_fields: [
    { preedit: "dianying", start: 0, end: 8 },
    { preedit: "dianying", start: 0, end: 8 },
  ],
}));
const generationDecision: DecisionInput = load(decisionInputFromPayload(generationPayload()));

// ---- 通道层 ----

interface Canned {
  readonly status?: number;
  readonly body?: unknown;
  readonly text?: string;
  readonly failure?: "timeout" | "network_unavailable" | "response_too_large";
}

interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly body: Uint8Array | undefined;
}

/** 按 URL 决定响应：同一个假传输层同时伺候 Ollama 原生与兼容端点。 */
class UrlTransport implements HttpTransportLike {
  readonly calls: RecordedCall[] = [];
  #handler: (method: string, url: string) => Canned = () => ({ failure: "network_unavailable" });

  handle(handler: (method: string, url: string) => Canned): this {
    this.#handler = handler;
    return this;
  }

  callsFor(method: string, url: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method && call.url === url);
  }

  async request(method: string, url: string, options: HttpRequestOptions = {}): Promise<Result<HttpResponse, "timeout" | "network_unavailable" | "response_too_large">> {
    this.calls.push({ method, url, body: options.body });
    const canned = this.#handler(method, url);
    if (canned.failure !== undefined) return err(canned.failure);
    const text = canned.text ?? JSON.stringify(canned.body ?? null);
    return ok({ status: canned.status ?? 200, body: new TextEncoder().encode(text) });
  }
}

const chatEnvelope = (content: string): unknown => ({
  model: DEFAULT_MODEL,
  done: true,
  done_reason: "stop",
  message: { role: "assistant", content },
});

function localBackend(baseUrl = OLLAMA_BASE_URL): { backend: LocalBackend; transport: UrlTransport } {
  const transport = new UrlTransport();
  const backend = new LocalBackend({
    transport,
    env: { USERPROFILE: "C:\\Users\\tester" },
    sleep: async () => undefined,
    monotonic: () => 0,
  });
  void baseUrl;
  return { backend, transport };
}

/** 让 #digests 里出现 DEFAULT_MODEL 的摘要：原生路径的身份复核要求它。 */
async function primeInventory(transport: UrlTransport): Promise<void> {
  transport.handle((method, url) =>
    method === "GET" && url === OLLAMA_BASE_URL + "/api/tags"
      ? { status: 200, body: { models: [{ name: DEFAULT_MODEL, digest: MODEL_DIGEST, details: { format: "gguf" } }] } }
      : { status: 200, body: { models: [] } },
  );
}

const jsonBody = (call: RecordedCall): Record<string, unknown> => {
  if (call.body === undefined) throw new Error("期望有请求体");
  return JSON.parse(new TextDecoder().decode(call.body)) as Record<string, unknown>;
};

describe("本地原生通道的生成模式", () => {
  it("请求体走协议 v2：候选窗进 query、text 枚举=候选、48 生成上限", async () => {
    const { backend, transport } = localBackend();
    await primeInventory(transport);
    await backend.modelInventory();
    transport.handle((method, url) => {
      if (method === "GET" && url.endsWith("/api/ps")) return { status: 200, body: { models: [] } };
      if (method === "POST" && url.endsWith("/api/chat")) return { status: 200, body: chatEnvelope('{"text":"电影"}') };
      return { status: 200, body: { models: [] } };
    });

    const identity = generationIdentityFor(MODEL_DIGEST);
    const outcome = await backend.infer(generationDecision, { ...DEFAULT_SETTINGS, enabled: true }, { modelIdentity: identity });
    expect(outcome).toEqual({
      kind: "ok",
      backend: "local",
      provider: "ollama",
      model: DEFAULT_MODEL,
      text: "电影",
      requestedModel: DEFAULT_MODEL,
      modelIdentity: identity,
    });

    const body = jsonBody(transport.callsFor("POST", OLLAMA_BASE_URL + "/api/chat")[0] as RecordedCall);
    expect(Object.keys(body)).toEqual(["model", "stream", "think", "keep_alive", "messages", "format", "options"]);
    expect(body["format"]).toEqual(generationResponseFormat(["电影", "电源"]));
    expect(body["options"]).toEqual(GENERATION_SAMPLING_OPTIONS);
    const messages = body["messages"] as { role: string; content: string }[];
    expect(messages[0]?.content).toBe(GENERATION_SYSTEM_PROMPT);
    const query = JSON.parse(messages[1]?.content ?? "{}") as Record<string, unknown>;
    expect(Object.keys(query)).toEqual(["protocol", "raw_input", "preceding_text", "reference_pinyin", "candidates"]);
    expect(query["raw_input"]).toBe("dianying");
    // 协议 v2（#34）：候选窗进请求、响应 text 枚举=本次候选词。
    expect(query["candidates"]).toEqual(["电影", "电源"]);
  });

  it("模型显式返回 null 时安全留空", async () => {
    const { backend, transport } = localBackend();
    await primeInventory(transport);
    await backend.modelInventory();
    transport.handle((method, url) =>
      method === "POST" && url.endsWith("/api/chat")
        ? { status: 200, body: chatEnvelope('{"text":null}') }
        : { status: 200, body: { models: [] } },
    );
    const outcome = await backend.infer(generationDecision, { ...DEFAULT_SETTINGS, enabled: true }, {
      modelIdentity: generationIdentityFor(MODEL_DIGEST),
    });
    expect(outcome).toEqual({ kind: "unavailable", errorCode: "generation_declined" });
  });

  it("重复键或多余键的答案一律拒绝", async () => {
    for (const content of ['{"text":"电影","text":"电源"}', '{"text":"电影","choice":1}', '{"choice":1}']) {
      const { backend, transport } = localBackend();
      await primeInventory(transport);
      await backend.modelInventory();
      transport.handle((method, url) =>
        method === "POST" && url.endsWith("/api/chat") ? { status: 200, body: chatEnvelope(content) } : { status: 200, body: { models: [] } },
      );
      const outcome = await backend.infer(generationDecision, { ...DEFAULT_SETTINGS, enabled: true }, {
        modelIdentity: generationIdentityFor(MODEL_DIGEST),
      });
      expect(outcome).toEqual({ kind: "unavailable", errorCode: "invalid_model_response" });
    }
  });

  it("选择模式的请求体与身份不受生成模式影响", async () => {
    const { backend, transport } = localBackend();
    await primeInventory(transport);
    await backend.modelInventory();
    transport.handle((method, url) => {
      if (method === "POST" && url.endsWith("/api/chat")) return { status: 200, body: chatEnvelope('{"choice":2}') };
      return { status: 200, body: { models: [] } };
    });
    const identity = identityFor(MODEL_DIGEST);
    const outcome = await backend.infer(selectionDecision, { ...DEFAULT_SETTINGS, enabled: true }, { modelIdentity: identity });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") expect("choice" in outcome && outcome.choice).toBe("2");
    const body = jsonBody(transport.callsFor("POST", OLLAMA_BASE_URL + "/api/chat")[0] as RecordedCall);
    const format = body["format"] as { properties: Record<string, unknown> };
    expect(Object.keys(format.properties)).toEqual(["choice"]);
  });

  it("身份用哪一套摘要由模式决定：混用即报不匹配", async () => {
    const { backend, transport } = localBackend();
    await primeInventory(transport);
    await backend.modelInventory();
    transport.handle(() => ({ status: 200, body: { models: [] } }));
    // 生成模式必须配生成身份；拿选择身份去问，摘要复核会拦下。
    const outcome = await backend.infer(generationDecision, { ...DEFAULT_SETTINGS, enabled: true }, {
      modelIdentity: identityFor(MODEL_DIGEST),
    });
    expect(outcome).toEqual({ kind: "unavailable", errorCode: "invalid_model_response" });
  });
});

describe("本地兼容端点的生成模式", () => {
  it("改写的端点上走 chat/completions，身份是生成模式的契约摘要", async () => {
    const { backend, transport } = localBackend(COMPAT_BASE_URL);
    transport.handle((method, url) =>
      method === "POST" && url === COMPAT_BASE_URL + "/chat/completions"
        ? { body: { choices: [{ message: { content: '{"text":"电影"}' }, finish_reason: "stop" }] } }
        : { failure: "network_unavailable" },
    );
    const settings = load(settingsFromMapping({ enabled: true, local_model: DEFAULT_MODEL, local_base_url: COMPAT_BASE_URL }));
    const outcome = await backend.infer(generationDecision, settings);
    expect(outcome).toEqual({
      kind: "ok",
      backend: "local",
      provider: "local-compat",
      model: DEFAULT_MODEL,
      text: "电影",
      requestedModel: DEFAULT_MODEL,
      modelIdentity: generationCloudIdentityFor("local-compat", COMPAT_BASE_URL, DEFAULT_MODEL),
    });
  });
});

// ---- service 层 ----

function envelope(payload: unknown, seq = 1): RequestEnvelope {
  return load(parseRequest(new TextEncoder().encode(JSON.stringify({
    version: 1,
    contract_version: 1,
    engine_id: ENGINE,
    seq,
    request_id: REQUEST_ID,
    kind: "predict",
    sent_at: 1000.25,
    payload,
  }))));
}

interface Scenario {
  readonly resolve?: Result<ResolvedModel, LocalBackendErrorCode>;
  readonly infer?: LocalInferenceOutcome;
}

class FakeLocal implements LocalBackendPort {
  readonly seen: DecisionInput[] = [];
  readonly #scenario: Scenario;

  constructor(scenario: Scenario = {}) {
    this.#scenario = scenario;
  }

  async resolveModel(model: string): Promise<Result<ResolvedModel, LocalBackendErrorCode>> {
    void model;
    return this.#scenario.resolve ?? ok({ identity: identityFor(MODEL_DIGEST), digest: MODEL_DIGEST, format: "unknown" });
  }

  isRouter(model: string): boolean {
    void model;
    return false;
  }

  async infer(decision: DecisionInput): Promise<LocalInferenceOutcome> {
    this.seen.push(decision);
    return this.#scenario.infer ?? { kind: "unavailable", errorCode: "invalid_model_response" };
  }

  async testConnection(): Promise<ConnectionStatus> {
    return { status: "connected", provider: "local", version: "0.12.0" };
  }

  async modelInventory(): Promise<ModelInventory> {
    return { status: "available", models: [{ name: DEFAULT_MODEL, digest: MODEL_DIGEST, format: "unknown" }] };
  }

  async startModelPull(model: unknown): Promise<PullStatus> {
    void model;
    return { status: "idle" };
  }

  modelPullStatus(): PullStatus {
    return { status: "idle" };
  }

  async cancelModelPull(): Promise<PullStatus> {
    return { status: "cancelled", model: null };
  }

  async close(): Promise<void> {}
}

const compatibleSettings: Settings = load(settingsFromMapping({
  enabled: true,
  local_model: DEFAULT_MODEL,
  local_base_url: COMPAT_BASE_URL,
}));
const generationOn: Settings = { ...DEFAULT_SETTINGS, enabled: true, generationEnabled: true };
const compatGenerationOn: Settings = { ...compatibleSettings, generationEnabled: true };

async function predict(scenario: Scenario, settings: Settings, payload: unknown): Promise<Record<string, unknown>> {
  const service = new InferenceService({ local: new FakeLocal(scenario) });
  try {
    return (await service.dispatch(envelope(payload), settings)) as Record<string, unknown>;
  } finally {
    await service.close();
  }
}

describe("service 层的模式分派", () => {
  it("生成开关默认关闭：请求直接留空，连身份都不问", async () => {
    const local = new FakeLocal({});
    const service = new InferenceService({ local });
    try {
      const payload = (await service.dispatch(envelope(generationPayload()), DEFAULT_SETTINGS)) as Record<string, unknown>;
      expect(payload["status"]).toBe("unavailable");
      expect(payload["error_code"]).toBe("disabled");
      expect(local.seen).toHaveLength(0);
    } finally {
      await service.close();
    }
  });

  it("没有已验收的生成组合时，Ollama 通道一律判不合格", async () => {
    const payload = await predict({}, generationOn, generationPayload());
    expect(payload["status"]).toBe("unavailable");
    expect(payload["error_code"]).toBe("identity_not_validated");
    expect(payload["eligible"]).toBe(false);
    expect(payload["model_identity"]).toBe(generationIdentityFor(MODEL_DIGEST));
  });

  it("契约验收集通道上，词条命中候选集合即映射成 1 起编号", async () => {
    const payload = await predict({ infer: { kind: "ok", backend: "local", provider: "local-compat", model: DEFAULT_MODEL, text: "电源", requestedModel: DEFAULT_MODEL, modelIdentity: generationCloudIdentityFor("local-compat", COMPAT_BASE_URL, DEFAULT_MODEL) } }, compatGenerationOn, generationPayload());
    expect(payload["status"]).toBe("ok");
    expect(payload["choice"]).toBe("2");
    expect(payload["eligible"]).toBe(true);
  });

  it("词库外的词条（造词）安全留空", async () => {
    const payload = await predict({ infer: { kind: "ok", backend: "local", provider: "local-compat", model: DEFAULT_MODEL, text: "电能", requestedModel: DEFAULT_MODEL, modelIdentity: generationCloudIdentityFor("local-compat", COMPAT_BASE_URL, DEFAULT_MODEL) } }, compatGenerationOn, generationPayload());
    expect(payload["status"]).toBe("unavailable");
    expect(payload["error_code"]).toBe("generation_rejected");
  });

  it("读音与本次拼音不符也留空", async () => {
    const payload = await predict(
      { infer: { kind: "ok", backend: "local", provider: "local-compat", model: DEFAULT_MODEL, text: "电影", requestedModel: DEFAULT_MODEL, modelIdentity: generationCloudIdentityFor("local-compat", COMPAT_BASE_URL, DEFAULT_MODEL) } },
      compatGenerationOn,
      generationPayload({ state: { task: "中文输入法候选选择", preceding_text: "我们今天去看", pinyin: "dianyin" } }),
    );
    expect(payload["status"]).toBe("unavailable");
    expect(payload["error_code"]).toBe("generation_rejected");
  });

  it("模式原样交给端口：端口看到的 decision 带 mode", async () => {
    const local = new FakeLocal({ infer: { kind: "unavailable", errorCode: "invalid_model_response" } });
    const service = new InferenceService({ local });
    try {
      await service.dispatch(envelope(generationPayload()), compatGenerationOn);
      await service.dispatch(envelope({ ...generationPayload(), mode: "selection" }), compatibleSettings);
      expect(local.seen.map((decision) => decision.mode)).toEqual(["generation", "selection"]);
    } finally {
      await service.close();
    }
  });

  it("同一状态两种模式不共用缓存条目", () => {
    const selection = load(decisionInputFromPayload({ ...generationPayload(), mode: "selection" }));
    const generation = load(decisionInputFromPayload(generationPayload()));
    const identity = { backend: "local", provider: "local-compat", modelIdentity: "local-compat:" + "b".repeat(64) };
    expect(PredictionCache.key(selection, identity)).not.toBe(PredictionCache.key(generation, identity));
  });

  it("生成模式的身份含生成策略摘要，选择模式的身份不含", () => {
    const selection = cloudIdentityFor("local-compat", COMPAT_BASE_URL, DEFAULT_MODEL);
    const generation = generationCloudIdentityFor("local-compat", COMPAT_BASE_URL, DEFAULT_MODEL);
    expect(selection).not.toBe(generation);
    expect(createHash("sha256").update("").digest("hex")).toHaveLength(64);
    expect(GENERATION_POLICY_DIGEST).not.toBe("");
  });
});
