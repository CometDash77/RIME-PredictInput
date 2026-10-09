/**
 * 双通道推理端口的行为锁定（spec #10，决策 09；YG 拍板 ①A/③A）。
 *
 * 锁的都是跨通道必须一致的外部行为：请求映射（URL/头/字节）、响应答案契约
 * （strict JSON、choice 1..N、越界即拒）、错误分类（凭据无效/超时/限流一律安全
 * 留空）、身份稳定性与跨通道缓存隔离。传输层全部注入假实现，不打真实 API。
 */

import { describe, expect, it } from "vitest";

import {
  MODEL_DIGEST,
  SYSTEM_PROMPT,
  VALIDATED_IDENTITY,
  chatRequestBody,
  cloudIdentityFor,
} from "../src/contracts/policy.js";
import { ANTHROPIC_ENDPOINT, OPENAI_CHAT_ENDPOINT, OPENAI_RESPONSES_ENDPOINT } from "../src/contracts/cloud-wire.js";
import { parseRequest, type RequestEnvelope } from "../src/contracts/envelope.js";
import { decisionInputFromPayload, type DecisionInput } from "../src/domain/decision.js";
import { DEFAULT_MODEL } from "../src/domain/model.js";
import { expectOk, err, ok, type Result } from "../src/domain/result.js";
import { DEFAULT_LOCAL_BASE_URL, settingsFromMapping, type CloudChannel, type Settings } from "../src/domain/settings.js";
import type { LocalBackendErrorCode, TransportFailureCode } from "../src/domain/error-codes.js";
import { InferenceService } from "../src/inference/service.js";
import type { CloudChannelPort, LocalBackendPort } from "../src/inference/ports.js";
import { PredictionCache } from "../src/inference/cache.js";
import { CloudBackend, type CloudBackendErrorCode, type CloudInferenceOutcome } from "../src/providers/cloud.js";
import {
  LocalBackend,
  type ConnectionStatus,
  type LocalInferenceOutcome,
  type ModelInventory,
  type PullStatus,
  type ResolvedModel,
} from "../src/providers/ollama.js";
import type { HttpRequestOptions, HttpResponse, HttpTransportLike } from "../src/providers/http.js";
import { basePayload } from "./support/oracle.js";

const load = <T, E>(result: Result<T, E>): T =>
  expectOk(result, (error) => "fixture must be valid: " + String(error));

const decision: DecisionInput = (() => {
  const parsed = decisionInputFromPayload(basePayload);
  if (!parsed.ok) throw new Error("base payload must be a valid decision");
  return parsed.value;
})();

const candidateCount = decision.candidates.length;

const chatChannel: CloudChannel = { kind: "openai-chat", model: "gpt-4o-mini", apiKey: "sk-test-123", baseUrl: null };
const responsesChannel: CloudChannel = { kind: "openai-responses", model: "gpt-4o-mini", apiKey: "sk-test-123", baseUrl: null };
const anthropicChannel: CloudChannel = { kind: "anthropic", model: "claude-sonnet-4-5", apiKey: "ak-test", baseUrl: null };
const customChannel: CloudChannel = { kind: "custom", model: "qwen3", apiKey: "", baseUrl: "http://127.0.0.1:8000/v1" };

// 设置走线格式（api_key/base_url）；域模型形状的 apiKey 键会被凭据扫描拦截——那正是②A 的防线。
const chatMapping = { kind: "openai-chat", model: "gpt-4o-mini", api_key: "sk-test-123", base_url: null };
const cloudSettings = (enabled = true): Settings =>
  load(settingsFromMapping({ enabled, cloud_enabled: true, cloud: chatMapping }));

interface Canned {
  readonly status?: number;
  readonly body?: unknown;
  readonly text?: string;
  readonly failure?: TransportFailureCode;
}

interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | undefined;
}

/** 记录调用并把响应决定权交给用例内注册的处理函数。 */
class FakeTransport implements HttpTransportLike {
  readonly calls: RecordedCall[] = [];
  #handler: ((method: string, url: string) => Canned) | null = null;

  handle(handler: (method: string, url: string) => Canned): this {
    this.#handler = handler;
    return this;
  }

  callsFor(method: string, url: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method && call.url === url);
  }

  async request(
    method: string,
    url: string,
    options: HttpRequestOptions = {},
  ): Promise<Result<HttpResponse, TransportFailureCode>> {
    this.calls.push({ method, url, headers: options.headers ?? {}, body: options.body });
    const canned = this.#handler?.(method, url) ?? { failure: "network_unavailable" as const };
    if (canned.failure !== undefined) return err(canned.failure);
    const text = canned.text ?? JSON.stringify(canned.body ?? null);
    return ok({ status: canned.status ?? 200, body: new TextEncoder().encode(text) });
  }
}

function harness(): { backend: CloudBackend; transport: FakeTransport } {
  const transport = new FakeTransport();
  return { backend: new CloudBackend({ transport }), transport };
}

const decodedBody = (call: RecordedCall): Record<string, unknown> => {
  if (call.body === undefined) throw new Error("expected a request body");
  return JSON.parse(new TextDecoder().decode(call.body)) as Record<string, unknown>;
};

const chatCompletionsOk = (choice: string): Canned => ({
  body: { choices: [{ message: { content: `{"choice":${choice}}` }, finish_reason: "stop" }] },
});

/** 本地 Ollama 路径的用户消息字节：云端与它必须逐字一致。 */
const localUserContent = (() => {
  const body = load(chatRequestBody(decision, DEFAULT_MODEL));
  return body.messages[1]?.content ?? "";
})();

describe("openai-chat（custom 共用同一 wire）", () => {
  it("请求映射：URL、鉴权头与字段序", async () => {
    const { backend, transport } = harness();
    transport.handle((_m, url) => (url === OPENAI_CHAT_ENDPOINT + "/chat/completions" ? chatCompletionsOk("1") : { failure: "network_unavailable" }));
    expect((await backend.infer(decision, chatChannel)).kind).toBe("ok");
    const call = transport.callsFor("POST", OPENAI_CHAT_ENDPOINT + "/chat/completions")[0];
    if (call === undefined) throw new Error("expected a chat/completions call");
    expect(call.headers["Authorization"]).toBe("Bearer sk-test-123");
    expect(call.headers["Content-Type"]).toBe("application/json");
    const body = decodedBody(call);
    expect(Object.keys(body)).toEqual(["model", "messages", "temperature", "seed", "max_tokens", "response_format"]);
    expect(body["model"]).toBe("gpt-4o-mini");
    expect(body["temperature"]).toBe(0);
    expect(body["seed"]).toBe(19);
    expect(body["max_tokens"]).toBe(32);
    const messages = body["messages"] as { role: string; content: string }[];
    expect(messages[0]?.content).toBe(SYSTEM_PROMPT);
    expect(messages[1]?.content).toBe(localUserContent);
    const format = body["response_format"] as { json_schema: { schema: { properties: { choice: { enum: number[] } } } } };
    expect(format.json_schema.schema.properties.choice.enum).toEqual(
      Array.from({ length: candidateCount }, (_, index) => index + 1),
    );
  });

  it("成功回答压成与本地同构的 outcome", async () => {
    const { backend, transport } = harness();
    transport.handle(() => chatCompletionsOk("2"));
    expect(await backend.infer(decision, chatChannel)).toEqual({
      kind: "ok",
      backend: "cloud",
      provider: "openai-chat",
      model: "gpt-4o-mini",
      choice: "2",
      requestedModel: "gpt-4o-mini",
      modelIdentity: cloudIdentityFor("openai-chat", OPENAI_CHAT_ENDPOINT, "gpt-4o-mini"),
    });
  });

  it("finish_reason 不是 stop 一律拒绝", async () => {
    const { backend, transport } = harness();
    transport.handle(() => ({ body: { choices: [{ message: { content: '{"choice":1}' }, finish_reason: "length" }] } }));
    expect(await backend.infer(decision, chatChannel)).toEqual({ kind: "unavailable", errorCode: "invalid_model_response" });
  });
});

describe("custom 通道", () => {
  it("端点自由、无 response_format、空凭据不发鉴权头", async () => {
    const { backend, transport } = harness();
    transport.handle((_m, url) =>
      url === "http://127.0.0.1:8000/v1/chat/completions" ? chatCompletionsOk("3") : { failure: "network_unavailable" },
    );
    const outcome = await backend.infer(decision, customChannel);
    expect(outcome.kind === "ok" && outcome.choice).toBe("3");
    const call = transport.callsFor("POST", "http://127.0.0.1:8000/v1/chat/completions")[0];
    if (call === undefined) throw new Error("expected a custom endpoint call");
    expect("Authorization" in call.headers).toBe(false);
    expect("response_format" in decodedBody(call)).toBe(false);
  });
});

describe("openai-responses", () => {
  it("请求映射与 output_text 提取", async () => {
    const { backend, transport } = harness();
    transport.handle((_m, url) =>
      url === OPENAI_RESPONSES_ENDPOINT + "/responses"
        ? {
            body: {
              status: "completed",
              output: [
                { type: "reasoning", content: [{ type: "reasoning_text", text: "..." }] },
                { type: "message", content: [{ type: "output_text", text: '{"choice":2}' }] },
              ],
            },
          }
        : { failure: "network_unavailable" },
    );
    const outcome = await backend.infer(decision, responsesChannel);
    expect(outcome.kind === "ok" && outcome.choice).toBe("2");
    const call = transport.callsFor("POST", OPENAI_RESPONSES_ENDPOINT + "/responses")[0];
    if (call === undefined) throw new Error("expected a responses call");
    const body = decodedBody(call);
    expect(Object.keys(body)).toEqual(["model", "instructions", "input", "max_output_tokens", "temperature", "text"]);
    expect(body["instructions"]).toBe(SYSTEM_PROMPT);
    expect(body["input"]).toBe(localUserContent);
  });

  it("status 不是 completed 拒绝", async () => {
    const { backend, transport } = harness();
    transport.handle(() => ({
      body: { status: "in_progress", output: [{ type: "message", content: [{ type: "output_text", text: '{"choice":1}' }] }] },
    }));
    expect(await backend.infer(decision, responsesChannel)).toEqual({ kind: "unavailable", errorCode: "invalid_model_response" });
  });
});

describe("anthropic", () => {
  it("请求映射：x-api-key、anthropic-version 与字段序", async () => {
    const { backend, transport } = harness();
    transport.handle((_m, url) =>
      url === ANTHROPIC_ENDPOINT + "/messages"
        ? { body: { stop_reason: "end_turn", content: [{ type: "text", text: '{"choice":1}' }] } }
        : { failure: "network_unavailable" },
    );
    const outcome = await backend.infer(decision, anthropicChannel);
    expect(outcome.kind === "ok" && outcome.choice).toBe("1");
    const call = transport.callsFor("POST", ANTHROPIC_ENDPOINT + "/messages")[0];
    if (call === undefined) throw new Error("expected a messages call");
    expect(Object.keys(call.headers)).toEqual(["Content-Type", "x-api-key", "anthropic-version"]);
    expect(call.headers["x-api-key"]).toBe("ak-test");
    const body = decodedBody(call);
    expect(Object.keys(body)).toEqual(["model", "max_tokens", "temperature", "system", "messages"]);
    expect(body["system"]).toBe(SYSTEM_PROMPT);
    const messages = body["messages"] as { role: string; content: string }[];
    expect(messages[0]?.content).toBe(localUserContent);
  });

  it("stop_reason 不是 end_turn 拒绝", async () => {
    const { backend, transport } = harness();
    transport.handle(() => ({ body: { stop_reason: "max_tokens", content: [{ type: "text", text: '{"choice":1}' }] } }));
    expect(await backend.infer(decision, anthropicChannel)).toEqual({ kind: "unavailable", errorCode: "invalid_model_response" });
  });
});

describe("答案契约跨通道一致（①A）", () => {
  const cases: readonly (readonly [string, unknown])[] = [
    ["编号越界", { choices: [{ message: { content: `{"choice":${candidateCount + 1}}` }, finish_reason: "stop" }] }],
    ["编号为零", { choices: [{ message: { content: '{"choice":0}' }, finish_reason: "stop" }] }],
    ["编号非整数", { choices: [{ message: { content: '{"choice":1.5}' }, finish_reason: "stop" }] }],
    ["多出字段", { choices: [{ message: { content: '{"choice":1,"note":"x"}' }, finish_reason: "stop" }] }],
    ["重复键", { choices: [{ message: { content: '{"choice":1,"choice":2}' }, finish_reason: "stop" }] }],
    ["不是 JSON", { choices: [{ message: { content: "第二个" }, finish_reason: "stop" }] }],
    ["空内容", { choices: [{ message: { content: "" }, finish_reason: "stop" }] }],
    ["缺 choices", { output: [] }],
  ];
  it.each(cases)("%s → invalid_model_response", async (_name, body) => {
    const { backend, transport } = harness();
    transport.handle(() => ({ body }));
    expect(await backend.infer(decision, chatChannel)).toEqual({ kind: "unavailable", errorCode: "invalid_model_response" });
  });
});

describe("错误分类：一律安全留空", () => {
  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rate_limited"],
    [500, "provider_unavailable"],
    [400, "provider_rejected"],
  ])("HTTP %i → %s", async (status, expected) => {
    const { backend, transport } = harness();
    transport.handle(() => ({ status, text: "internal details that must never leak" }));
    expect(await backend.infer(decision, chatChannel)).toEqual({ kind: "unavailable", errorCode: expected });
  });

  it("传输失败原样透传固定码", async () => {
    const { backend, transport } = harness();
    transport.handle(() => ({ failure: "timeout" }));
    expect(await backend.infer(decision, chatChannel)).toEqual({ kind: "unavailable", errorCode: "timeout" });
  });

  it("响应体不是 JSON 归为模型错误", async () => {
    const { backend, transport } = harness();
    transport.handle(() => ({ status: 200, text: "<html>bad</html>" }));
    expect(await backend.infer(decision, chatChannel)).toEqual({ kind: "unavailable", errorCode: "invalid_model_response" });
  });
});

describe("连接探测", () => {
  it("GET /models、200 = connected、401 = unauthorized", async () => {
    const { backend, transport } = harness();
    transport.handle((method, url) =>
      method === "GET" && url === OPENAI_CHAT_ENDPOINT + "/models" ? { status: 200, body: { data: [] } } : { failure: "network_unavailable" },
    );
    expect(await backend.testConnection(chatChannel)).toEqual({ status: "connected", provider: "cloud", version: "openai-chat" });

    const g = harness();
    g.transport.handle((method, url) =>
      method === "GET" && url === ANTHROPIC_ENDPOINT + "/models" ? { status: 401 } : { failure: "network_unavailable" },
    );
    expect(await g.backend.testConnection(anthropicChannel)).toEqual({ status: "unavailable", errorCode: "unauthorized" });
    const call = g.transport.calls[0];
    if (call === undefined) throw new Error("expected a probe call");
    expect(call.headers["x-api-key"]).toBe("ak-test");
    expect(call.headers["anthropic-version"]).toBeDefined();
  });
});

describe("契约验收身份", () => {
  it("通道/端点/模型任一变化都换身份", () => {
    const base = cloudIdentityFor("openai-chat", OPENAI_CHAT_ENDPOINT, "gpt-4o-mini");
    expect(cloudIdentityFor("openai-chat", OPENAI_CHAT_ENDPOINT, "gpt-4o-mini")).toBe(base);
    expect(cloudIdentityFor("openai-chat", OPENAI_CHAT_ENDPOINT, "gpt-4o")).not.toBe(base);
    expect(cloudIdentityFor("anthropic", ANTHROPIC_ENDPOINT, "gpt-4o-mini")).not.toBe(base);
    expect(cloudIdentityFor("custom", "http://127.0.0.1:8000/v1", "gpt-4o-mini")).not.toBe(base);
  });

  it("身份形状 = 前缀 + 64 位十六进制；前缀在契约验收集内", () => {
    const identity = cloudIdentityFor("anthropic", ANTHROPIC_ENDPOINT, "claude-sonnet-4-5");
    expect(identity).toMatch(/^anthropic:[0-9a-f]{64}$/);
    expect(cloudIdentityFor("local-compat", "http://192.168.1.5:1234/v1", DEFAULT_MODEL)).toMatch(/^local-compat:[0-9a-f]{64}$/);
  });
});

describe("本地兼容端点（YG 拍板 ③A）", () => {
  function compatHarness(): { backend: LocalBackend; transport: FakeTransport } {
    const transport = new FakeTransport();
    return { backend: new LocalBackend({ transport, env: { USERPROFILE: "C:\\Users\\tester" } }), transport };
  }

  const compatSettings = (localBaseUrl: string): Settings =>
    load(settingsFromMapping({ enabled: true, local_base_url: localBaseUrl }));

  it("改写端点 → POST <base>/chat/completions，不触碰 Ollama 原生端点", async () => {
    const { backend, transport } = compatHarness();
    transport.handle((_m, url) =>
      url === "http://192.168.1.5:1234/v1/chat/completions" ? chatCompletionsOk("2") : { failure: "network_unavailable" },
    );
    const outcome = await backend.infer(decision, compatSettings("http://192.168.1.5:1234/v1"));
    expect(outcome).toEqual({
      kind: "ok",
      backend: "local",
      provider: "local-compat",
      model: DEFAULT_MODEL,
      choice: "2",
      requestedModel: DEFAULT_MODEL,
      modelIdentity: cloudIdentityFor("local-compat", "http://192.168.1.5:1234/v1", DEFAULT_MODEL),
    });
    expect(transport.calls.filter((call) => call.url.includes("/api/"))).toEqual([]);
    const call = transport.callsFor("POST", "http://192.168.1.5:1234/v1/chat/completions")[0];
    if (call === undefined) throw new Error("expected a compat call");
    expect(Object.keys(decodedBody(call))).toEqual(["model", "messages", "temperature", "seed", "max_tokens"]);
  });

  it("缺省端点保持 Ollama 原生路径（冻结字节）", async () => {
    const { backend, transport } = compatHarness();
    transport.handle((_m, url) => {
      if (url === DEFAULT_LOCAL_BASE_URL + "/api/chat") {
        return { body: { model: DEFAULT_MODEL, done: true, done_reason: "stop", message: { role: "assistant", content: '{"choice":1}' } } };
      }
      if (url === DEFAULT_LOCAL_BASE_URL + "/api/tags") {
        return { body: { models: [{ name: DEFAULT_MODEL, digest: MODEL_DIGEST, details: { format: "gguf" } }] } };
      }
      if (url === DEFAULT_LOCAL_BASE_URL + "/api/ps") return { body: { models: [] } };
      return { status: 200 };
    });
    const settings = load(settingsFromMapping({ enabled: true }));
    const outcome = await backend.infer(decision, settings);
    expect(outcome.kind === "ok" && outcome.provider).toBe("ollama");
    expect(outcome.kind === "ok" && outcome.modelIdentity).toBe(VALIDATED_IDENTITY);
    expect(transport.callsFor("POST", DEFAULT_LOCAL_BASE_URL + "/api/chat")).toHaveLength(1);
    expect(transport.calls.filter((call) => call.url.endsWith("/chat/completions"))).toEqual([]);
  });
});

// ---- service 通道分派 ----

const INFERENCE_ENGINE = "a".repeat(40);
const INFERENCE_REQUEST_ID = "1".repeat(32);

function makeRequest(kind: string, payload: unknown): RequestEnvelope {
  const raw = JSON.stringify({
    version: 1,
    contract_version: 1,
    engine_id: INFERENCE_ENGINE,
    seq: 1,
    request_id: INFERENCE_REQUEST_ID,
    kind,
    sent_at: 1000.25,
    payload,
  });
  return load(parseRequest(new TextEncoder().encode(raw)));
}

class FakeLocal implements LocalBackendPort {
  async resolveModel(): Promise<Result<ResolvedModel, LocalBackendErrorCode>> {
    return err("model_missing");
  }
  isRouter(): boolean {
    return false;
  }
  async infer(): Promise<LocalInferenceOutcome> {
    return { kind: "unavailable", errorCode: "ollama_missing" };
  }
  async testConnection(): Promise<ConnectionStatus> {
    return { status: "unavailable", errorCode: "ollama_missing" };
  }
  async modelInventory(): Promise<ModelInventory> {
    return { status: "unavailable", errorCode: "model_store_unavailable", models: [] };
  }
  async startModelPull(): Promise<PullStatus> {
    return { status: "unavailable", errorCode: "ollama_missing" };
  }
  modelPullStatus(): PullStatus {
    return { status: "idle" };
  }
  async cancelModelPull(): Promise<PullStatus> {
    return { status: "idle" };
  }
  async close(): Promise<void> {}
}

class FakeCloud implements CloudChannelPort {
  #fail: CloudBackendErrorCode | null = null;
  readonly inferCalls: CloudChannel[] = [];

  failWith(code: CloudBackendErrorCode): this {
    this.#fail = code;
    return this;
  }

  resolveIdentity(cloud: CloudChannel): Result<string, CloudBackendErrorCode> {
    return ok(cloudIdentityFor(cloud.kind, cloudEndpointOf(cloud), cloud.model));
  }

  #identity(cloud: CloudChannel): string {
    const identity = this.resolveIdentity(cloud);
    if (!identity.ok) throw new Error("fake cloud identity must resolve");
    return identity.value;
  }

  async infer(_decision: DecisionInput, cloud: CloudChannel): Promise<CloudInferenceOutcome> {
    this.inferCalls.push(cloud);
    if (this.#fail !== null) return { kind: "unavailable", errorCode: this.#fail };
    return {
      kind: "ok",
      backend: "cloud",
      provider: cloud.kind,
      model: cloud.model,
      choice: "2",
      requestedModel: cloud.model,
      modelIdentity: this.#identity(cloud),
    };
  }

  async testConnection(): Promise<ConnectionStatus> {
    return { status: "connected", provider: "cloud", version: "fake" };
  }

  async close(): Promise<void> {}
}

function cloudEndpointOf(cloud: CloudChannel): string {
  switch (cloud.kind) {
    case "openai-responses":
    case "openai-chat":
      return OPENAI_CHAT_ENDPOINT;
    case "anthropic":
      return ANTHROPIC_ENDPOINT;
    case "custom":
      return cloud.baseUrl ?? "";
  }
}

describe("InferenceService 通道分派", () => {
  it("云端开启 → 走云端端口，结果 eligible 进第 5 位", async () => {
    const cloud = new FakeCloud();
    const service = new InferenceService({ local: new FakeLocal(), cloud });
    try {
      const payload = await service.dispatch(makeRequest("predict", basePayload), cloudSettings());
      expect(payload["status"]).toBe("ok");
      expect(payload["backend"]).toBe("cloud");
      expect(payload["provider"]).toBe("openai-chat");
      expect(payload["eligible"]).toBe(true);
      expect(payload["model_identity"]).toBe(cloudIdentityFor("openai-chat", OPENAI_CHAT_ENDPOINT, "gpt-4o-mini"));
      expect(cloud.inferCalls).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  it("云端开关未开 → 走本地（即使配置在场）", async () => {
    const cloud = new FakeCloud();
    const service = new InferenceService({ local: new FakeLocal(), cloud });
    try {
      const off = load(
        settingsFromMapping({ enabled: true, cloud: { kind: "openai-chat", model: "gpt-4o-mini", api_key: "sk-x", base_url: null } }),
      );
      const payload = await service.dispatch(makeRequest("predict", basePayload), off);
      expect(payload["backend"]).toBe("local");
      expect(cloud.inferCalls).toHaveLength(0);
    } finally {
      await service.close();
    }
  });

  it("云端失败原样透传错误码，backend 标 cloud", async () => {
    const cloud = new FakeCloud().failWith("unauthorized");
    const service = new InferenceService({ local: new FakeLocal(), cloud });
    try {
      const payload = await service.dispatch(makeRequest("predict", basePayload), cloudSettings());
      expect(payload).toEqual({ status: "unavailable", backend: "cloud", error_code: "unauthorized" });
    } finally {
      await service.close();
    }
  });

  it("云端健康检查与 test_connection 走云端探测", async () => {
    const cloud = new FakeCloud();
    const service = new InferenceService({ local: new FakeLocal(), cloud });
    try {
      const settings = cloudSettings();
      const payload = await service.dispatch(makeRequest("settings", { action: "test_connection" }), settings);
      expect(payload).toEqual({ status: "connected", provider: "cloud", version: "fake" });
      const report = await service.health(settings);
      expect(report.backend).toBe("cloud");
      expect(report.connection).toEqual({ status: "connected", provider: "cloud", version: "fake" });
    } finally {
      await service.close();
    }
  });

  it("跨通道缓存隔离：同一决策输入在不同通道下键不同", async () => {
    const localKey = PredictionCache.key(decision, { backend: "local", provider: "ollama", modelIdentity: VALIDATED_IDENTITY });
    const cloudKey = PredictionCache.key(decision, {
      backend: "cloud",
      provider: "openai-chat",
      modelIdentity: cloudIdentityFor("openai-chat", OPENAI_CHAT_ENDPOINT, "gpt-4o-mini"),
    });
    const compatKey = PredictionCache.key(decision, {
      backend: "local",
      provider: "local-compat",
      modelIdentity: cloudIdentityFor("local-compat", "http://192.168.1.5:1234/v1", DEFAULT_MODEL),
    });
    expect(localKey).not.toBe(cloudKey);
    expect(localKey).not.toBe(compatKey);
    expect(cloudKey).not.toBe(compatKey);
  });
});
