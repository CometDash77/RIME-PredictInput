/**
 * Ollama 适配器的行为锁定。
 *
 * 这些用例锁的是旧实现里最容易被重写弄丢的几条判断：探活失败不启动服务端、
 * 别人加载的模型不续租、摘要对不上就不答话、退出时只卸载自己加载的模型。
 * 传输层与子进程都注入假实现——真实 Ollama 不在单测范围内。
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_MODEL, MODEL_DIGEST } from "../src/domain/model.js";
import { decisionInputFromPayload } from "../src/domain/decision.js";
import { DEFAULT_SETTINGS } from "../src/domain/settings.js";
import type { Result } from "../src/domain/result.js";
import { err, ok } from "../src/domain/result.js";
import type { TransportFailureCode } from "../src/domain/error-codes.js";
import { sha256Hex } from "../src/json/digest.js";
import {
  FetchTransport,
  MAX_RESPONSE_BYTES,
  safeHttpError,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransportLike,
} from "../src/providers/http.js";
import {
  LocalBackend,
  OLLAMA_BASE_URL,
  PULL_MODEL_PATTERN,
  findOllamaCli,
} from "../src/providers/ollama.js";
import type { ChildHandle, ChildSpawner } from "../src/runtime/child-process.js";
import { OwnedChildProcess } from "../src/runtime/lifecycle.js";
import { identityFor } from "../src/contracts/policy.js";
import { basePayload, payloadWithoutField } from "./support/oracle.js";

const decision = (() => {
  const parsed = decisionInputFromPayload(basePayload);
  if (!parsed.ok) throw new Error("base payload must be a valid decision");
  return parsed.value;
})();

const settings = { ...DEFAULT_SETTINGS, enabled: true };

interface Canned {
  readonly status?: number;
  readonly body?: unknown;
  readonly text?: string;
  readonly failure?: TransportFailureCode;
}

interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly body: Uint8Array | undefined;
}

/** 按「方法 + 路径」排队返回预设响应的假传输层。 */
class FakeTransport implements HttpTransportLike {
  readonly calls: RecordedCall[] = [];
  readonly #routes: { readonly key: string; queue: Canned[]; index: number }[] = [];

  /** 同一个「方法 + 路径」再次登记即覆盖，方便用例改写某个端点的后续响应。 */
  route(method: string, path: string, ...queue: Canned[]): this {
    const key = method + " " + OLLAMA_BASE_URL + path;
    const existing = this.#routes.find((item) => item.key === key);
    if (existing === undefined) {
      this.#routes.push({ key, queue, index: 0 });
    } else {
      existing.queue = queue;
      existing.index = 0;
    }
    return this;
  }

  callsFor(method: string, path: string): RecordedCall[] {
    const url = OLLAMA_BASE_URL + path;
    return this.calls.filter((call) => call.method === method && call.url === url);
  }

  async request(
    method: string,
    url: string,
    options: HttpRequestOptions = {},
  ): Promise<Result<HttpResponse, TransportFailureCode>> {
    this.calls.push({ method, url, body: options.body });
    const route = this.#routes.find((item) => item.key === method + " " + url);
    if (route === undefined) return err("network_unavailable");
    const canned = route.queue[Math.min(route.index, route.queue.length - 1)];
    route.index += 1;
    if (canned === undefined) return err("network_unavailable");
    if (canned.failure !== undefined) return err(canned.failure);
    const text = canned.text ?? JSON.stringify(canned.body ?? null);
    return ok({ status: canned.status ?? 200, body: new TextEncoder().encode(text) });
  }
}

class FakeChild implements ChildHandle {
  readonly pid = 4242;
  code: number | null = null;
  terminated = false;
  killed = false;
  readonly stubborn: boolean;

  constructor(stubborn = false) {
    this.stubborn = stubborn;
  }

  running(): boolean {
    return this.code === null;
  }

  exitCode(): number | null {
    return this.code;
  }

  terminate(): void {
    this.terminated = true;
    if (!this.stubborn) this.code = 0;
  }

  kill(): void {
    this.killed = true;
    if (!this.stubborn) this.code = 0;
  }

  async waitForExit(): Promise<boolean> {
    return this.code !== null;
  }
}

interface Harness {
  readonly backend: LocalBackend;
  readonly transport: FakeTransport;
  readonly children: FakeChild[];
  readonly commands: string[][];
  readonly env: Record<string, string | undefined>;
}

const temporaries: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "rime-providers-"));
  temporaries.push(path);
  return path;
}

afterEach(() => {
  while (temporaries.length > 0) {
    const path = temporaries.pop();
    if (path !== undefined) rmSync(path, { recursive: true, force: true });
  }
});

function harness(options: { readonly cli?: string; readonly stubborn?: boolean } = {}): Harness {
  const transport = new FakeTransport();
  const children: FakeChild[] = [];
  const commands: string[][] = [];
  const spawn: ChildSpawner = (command) => {
    commands.push([...command]);
    const child = new FakeChild(options.stubborn ?? false);
    children.push(child);
    return child;
  };
  const env: Record<string, string | undefined> = { USERPROFILE: "C:\\Users\\tester" };
  if (options.cli !== undefined) env["PATH"] = options.cli;
  // 假时钟必须会走：否则启动轮询会因为「永远没到截止时间」而空转。
  let clock = 0;
  const backend = new LocalBackend({
    transport,
    server: new OwnedChildProcess(spawn),
    spawn,
    env,
    sleep: async () => undefined,
    monotonic: () => {
      clock += 0.075;
      return clock;
    },
  });
  return { backend, transport, children, commands, env };
}

const tagsBody = (digest: string): unknown => ({
  models: [{ name: DEFAULT_MODEL, digest, details: { format: "gguf" } }],
});

const chatBody = (content: string, overrides: Record<string, unknown> = {}): unknown => ({
  model: DEFAULT_MODEL,
  done: true,
  done_reason: "stop",
  message: { role: "assistant", content },
  ...overrides,
});

function okChat(transport: FakeTransport, content = '{"choice": 2}'): void {
  transport
    .route("GET", "/", { status: 200 })
    .route("GET", "/api/tags", { status: 200, body: tagsBody(MODEL_DIGEST) })
    .route("GET", "/api/ps", { status: 200, body: { models: [] } })
    .route("POST", "/api/chat", { status: 200, body: chatBody(content) });
}

const chatPayload = (transport: FakeTransport): Record<string, unknown> => {
  const call = transport.callsFor("POST", "/api/chat")[0];
  if (call?.body === undefined) throw new Error("expected a chat request");
  return JSON.parse(new TextDecoder().decode(call.body)) as Record<string, unknown>;
};

describe("safeHttpError", () => {
  it("把服务端状态码映射成固定枚举", () => {
    expect(safeHttpError(401)).toBe("unauthorized");
    expect(safeHttpError(402)).toBe("payment_required");
    expect(safeHttpError(403)).toBe("forbidden");
    expect(safeHttpError(404)).toBe("model_unavailable");
    expect(safeHttpError(422)).toBe("invalid_request");
    expect(safeHttpError(429)).toBe("rate_limited");
    expect(safeHttpError(529)).toBe("provider_overloaded");
    expect(safeHttpError(301)).toBe("redirect_refused");
    expect(safeHttpError(308)).toBe("redirect_refused");
    expect(safeHttpError(500)).toBe("provider_unavailable");
    expect(safeHttpError(400)).toBe("provider_rejected");
    expect(safeHttpError(200)).toBe("provider_error");
  });

  it("响应体上限是 1 MiB", () => {
    expect(MAX_RESPONSE_BYTES).toBe(1024 * 1024);
  });

  it("导出可替换的传输实现", () => {
    expect(typeof new FetchTransport().request).toBe("function");
  });
});

describe("findOllamaCli", () => {
  it("优先在 PATH 里找，再退到已知安装目录", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "ollama.exe"), "");
    expect(findOllamaCli({ PATH: directory })).toBe(join(directory, "ollama.exe"));

    const local = temporaryDirectory();
    const nested = join(local, "Programs", "Ollama");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "ollama.exe"), "");
    expect(findOllamaCli({ LOCALAPPDATA: local })).toBe(join(nested, "ollama.exe"));
    expect(findOllamaCli({})).toBeNull();
  });
});

describe("testConnection", () => {
  it("探活成功时报告版本", async () => {
    const h = harness();
    h.transport.route("GET", "/", { status: 200 }).route("GET", "/api/version", { status: 200, body: { version: "0.5.1" } });
    expect(await h.backend.testConnection()).toEqual({ status: "connected", provider: "local", version: "0.5.1" });
  });

  it("服务端没有版本字段时退化成 unknown", async () => {
    const h = harness();
    h.transport.route("GET", "/", { status: 200 }).route("GET", "/api/version", { status: 200, body: {} });
    expect(await h.backend.testConnection()).toEqual({ status: "connected", provider: "local", version: "unknown" });
  });

  it("探活遇到 401 时报告本机鉴权，不尝试启动", async () => {
    const h = harness({ cli: "C:\\nowhere" });
    h.transport.route("GET", "/", { status: 401 });
    expect(await h.backend.testConnection()).toEqual({ status: "unavailable", errorCode: "local_auth_required" });
    expect(h.transport.callsFor("GET", "/api/version")).toHaveLength(0);
  });

  it("服务端不可达且找不到 CLI 时报告 ollama_missing", async () => {
    const h = harness();
    h.transport.route("GET", "/", { failure: "network_unavailable" });
    expect(await h.backend.testConnection()).toEqual({ status: "unavailable", errorCode: "ollama_missing" });
  });
});

describe("modelInventory", () => {
  it("从 /api/tags 读清单并小写化摘要", async () => {
    const h = harness();
    h.transport.route("GET", "/", { status: 200 }).route("GET", "/api/tags", {
      status: 200,
      body: {
        models: [
          { name: DEFAULT_MODEL, digest: MODEL_DIGEST.toUpperCase(), details: { format: "gguf" } },
          { name: "no-digest" },
          { name: 42 },
        ],
      },
    });
    const inventory = await h.backend.modelInventory();
    expect(inventory.status).toBe("available");
    expect(inventory.models).toEqual([
      { name: DEFAULT_MODEL, digest: MODEL_DIGEST, format: "gguf" },
      { name: "no-digest", digest: "unknown", format: "unknown" },
    ]);
  });

  it("服务端不可达时直接读 manifests 目录", async () => {
    const models = temporaryDirectory();
    const manifest = join(models, "manifests", "registry.ollama.ai", "library", "llama3", "latest");
    mkdirSync(join(models, "manifests", "registry.ollama.ai", "library", "llama3"), { recursive: true });
    writeFileSync(manifest, JSON.stringify({ config: { digest: "sha256:cfg" }, model_info: { "general.architecture": "router" } }));
    const deep = join(models, "manifests", "example.com", "team", "model", "1.0");
    mkdirSync(join(models, "manifests", "example.com", "team", "model"), { recursive: true });
    writeFileSync(deep, JSON.stringify({ config: { digest: "sha256:cfg" } }));

    const h = harness();
    h.env["OLLAMA_MODELS"] = models;
    h.transport.route("GET", "/", { failure: "network_unavailable" });
    const inventory = await h.backend.modelInventory();
    if (inventory.status !== "available") throw new Error("expected an available inventory");
    expect(inventory.source).toBe("manifests");
    expect(inventory.models).toEqual([
      { name: "example.com/team/model:1.0", digest: sha256Hex(readFileSync(deep)), format: "unknown" },
      { name: "llama3:latest", digest: sha256Hex(readFileSync(manifest)), format: "router" },
    ]);
    expect(h.backend.isRouter("llama3:latest")).toBe(true);
    expect(h.backend.digestOf("llama3:latest")).toBe(sha256Hex(readFileSync(manifest)));
  });

  it("开鉴权的服务端读不了清单时同样退到 manifests", async () => {
    const models = temporaryDirectory();
    mkdirSync(join(models, "manifests", "registry.ollama.ai", "library", "gemma"), { recursive: true });
    writeFileSync(
      join(models, "manifests", "registry.ollama.ai", "library", "gemma", "2b"),
      JSON.stringify({ config: { digest: "sha256:cfg" } }),
    );
    const h = harness();
    h.env["OLLAMA_MODELS"] = models;
    h.transport.route("GET", "/", { status: 200 }).route("GET", "/api/tags", { status: 401 });
    const inventory = await h.backend.modelInventory();
    expect(inventory.status).toBe("available");
    expect(inventory.models.map((model) => model.name)).toEqual(["gemma:2b"]);
  });

  it("没有模型目录时报告不可用而不是崩掉", async () => {
    const h = harness();
    h.transport.route("GET", "/", { failure: "timeout" });
    const inventory = await h.backend.modelInventory();
    if (inventory.status !== "unavailable") throw new Error("expected an unavailable inventory");
    expect(inventory.errorCode).toBe("timeout");
    expect(inventory.models).toEqual([]);
  });

  it("清单解析失败时报告 invalid_model_list", async () => {
    const h = harness();
    h.transport.route("GET", "/", { status: 200 }).route("GET", "/api/tags", { status: 200, text: "not json" });
    expect(await h.backend.modelInventory()).toEqual({ status: "unavailable", errorCode: "invalid_model_list", models: [] });
  });
});

describe("ensureServer", () => {
  it("探活成功时不启动任何进程", async () => {
    const h = harness({ cli: "C:\\nowhere" });
    h.transport.route("GET", "/", { status: 200 });
    expect(await h.backend.ensureServer()).toEqual(ok(true));
    expect(h.commands).toEqual([]);
  });

  it("需要时启动 ollama serve 并带上本地环境", async () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "ollama.exe"), "");
    const h = harness({ cli: directory });
    h.transport.route("GET", "/", { failure: "network_unavailable" }, { status: 200 });
    expect(await h.backend.ensureServer()).toEqual(ok(true));
    expect(h.commands).toEqual([[join(directory, "ollama.exe"), "serve"]]);
  });

  it("找不到 CLI 时报告 ollama_missing", async () => {
    const h = harness();
    h.transport.route("GET", "/", { failure: "network_unavailable" });
    expect(await h.backend.ensureServer()).toEqual(err("ollama_missing"));
  });

  it("启动后仍探活失败时停掉自己拉起的进程", async () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "ollama.exe"), "");
    const h = harness({ cli: directory });
    h.transport.route("GET", "/", { failure: "network_unavailable" });
    expect(await h.backend.ensureServer()).toEqual(err("ollama_start_failed"));
    expect(h.children).toHaveLength(1);
    expect(h.children[0]?.terminated).toBe(true);
  });
});

describe("resolveModel", () => {
  it("摘要缺失与 unknown 是两个不同的错误", async () => {
    const h = harness();
    h.transport.route("GET", "/", { status: 200 }).route("GET", "/api/tags", { status: 200, body: { models: [] } });
    expect((await h.backend.resolveModel(DEFAULT_MODEL)).ok).toBe(false);

    const g = harness();
    g.transport.route("GET", "/", { status: 200 }).route("GET", "/api/tags", {
      status: 200,
      body: { models: [{ name: DEFAULT_MODEL }] },
    });
    expect(await g.backend.resolveModel(DEFAULT_MODEL)).toEqual(err("model_version_unavailable"));
  });

  it("命中摘要时给出身份", async () => {
    const h = harness();
    h.transport.route("GET", "/", { status: 200 }).route("GET", "/api/tags", { status: 200, body: tagsBody(MODEL_DIGEST) });
    const resolved = await h.backend.resolveModel(DEFAULT_MODEL);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.identity).toBe(identityFor(MODEL_DIGEST));
    expect(resolved.value.digest).toBe(MODEL_DIGEST);
  });
});

describe("infer", () => {
  it("正常路径把候选页发给本地模型并返回编号字符串", async () => {
    const h = harness();
    okChat(h.transport, '{"choice": 2}');
    const outcome = await h.backend.infer(decision, settings);
    expect(outcome).toEqual({
      kind: "ok",
      backend: "local",
      provider: "ollama",
      model: DEFAULT_MODEL,
      choice: "2",
      requestedModel: DEFAULT_MODEL,
      modelIdentity: identityFor(MODEL_DIGEST),
    });
    const payload = chatPayload(h.transport);
    expect(payload["model"]).toBe(DEFAULT_MODEL);
    expect(payload["stream"]).toBe(false);
    expect(payload["think"]).toBe(false);
    expect(payload["keep_alive"]).toBe("60s");
    expect(Object.keys(payload)).toEqual([
      "model",
      "stream",
      "think",
      "keep_alive",
      "messages",
      "format",
      "options",
    ]);
  });

  it("模型已由别人加载时不续租", async () => {
    const h = harness();
    okChat(h.transport);
    h.transport.route("GET", "/api/ps", { status: 200, body: { models: [{ name: DEFAULT_MODEL, digest: MODEL_DIGEST }] } });
    h.transport.calls.length = 0;
    expect((await h.backend.infer(decision, settings)).kind).toBe("ok");
    const payload = chatPayload(h.transport);
    expect("keep_alive" in payload).toBe(false);
    expect(Object.keys(payload)).toEqual(["model", "stream", "think", "messages", "format", "options"]);
  });

  it("读不到模型归属时拒答", async () => {
    const h = harness();
    okChat(h.transport);
    h.transport.route("GET", "/api/ps", { status: 500 });
    expect(await h.backend.infer(decision, settings)).toEqual({
      kind: "unavailable",
      errorCode: "model_ownership_unavailable",
    });
  });

  it("摘要与身份对不上时拒答", async () => {
    const h = harness();
    okChat(h.transport);
    const outcome = await h.backend.infer(decision, settings, { modelIdentity: "ollama:" + "0".repeat(64) });
    expect(outcome).toEqual({ kind: "unavailable", errorCode: "invalid_model_response" });
  });

  it("模型答非所问一律归为 invalid_model_response", async () => {
    const cases: readonly (readonly [string, string, Record<string, unknown>])[] = [
      ["编号越界", '{"choice": 9}', {}],
      ["编号为零", '{"choice": 0}', {}],
      ["编号非整数", '{"choice": 1.5}', {}],
      ["多出字段", '{"choice": 1, "note": "x"}', {}],
      ["重复键", '{"choice": 1, "choice": 2}', {}],
      ["不是 JSON", "第二个", {}],
      ["思考内容", '{"choice": 1}', { message: { role: "assistant", content: '{"choice": 1}', thinking: true } }],
      ["未跑完", '{"choice": 1}', { done: false }],
      ["停止原因不对", '{"choice": 1}', { done_reason: "length" }],
      ["不是要的模型", '{"choice": 1}', { model: "other:1b" }],
      ["角色不对", '{"choice": 1}', { message: { role: "user", content: '{"choice": 1}' } }],
    ];
    for (const [name, content, overrides] of cases) {
      const h = harness();
      h.transport
        .route("GET", "/", { status: 200 })
        .route("GET", "/api/tags", { status: 200, body: tagsBody(MODEL_DIGEST) })
        .route("GET", "/api/ps", { status: 200, body: { models: [] } })
        .route("POST", "/api/chat", { status: 200, body: chatBody(content, overrides) });
      expect(await h.backend.infer(decision, settings), name).toEqual({
        kind: "unavailable",
        errorCode: "invalid_model_response",
      });
    }
  });

  it("HTTP 失败按状态码映射，而不是一律归为模型错误", async () => {
    const h = harness();
    okChat(h.transport);
    h.transport.route("POST", "/api/chat", { status: 404 });
    expect(await h.backend.infer(decision, settings)).toEqual({ kind: "unavailable", errorCode: "model_unavailable" });

    const g = harness();
    okChat(g.transport);
    g.transport.route("POST", "/api/chat", { failure: "timeout" });
    expect(await g.backend.infer(decision, settings)).toEqual({ kind: "unavailable", errorCode: "timeout" });
  });

  it("缺候选字段时按旧实现归为 invalid_model_response", async () => {
    const h = harness();
    okChat(h.transport);
    const withoutFields = decisionInputFromPayload(payloadWithoutField("candidate_fields"));
    if (!withoutFields.ok) throw new Error("expected a valid decision");
    expect(await h.backend.infer(withoutFields.value, settings)).toEqual({
      kind: "unavailable",
      errorCode: "invalid_model_response",
    });
    expect(h.transport.callsFor("POST", "/api/chat")).toHaveLength(0);
  });
});

describe("退出清理", () => {
  it("只卸载自己加载过的模型", async () => {
    const h = harness();
    okChat(h.transport);
    expect((await h.backend.infer(decision, settings)).kind).toBe("ok");
    h.transport.route("GET", "/api/ps", {
      status: 200,
      body: {
        models: [
          { name: DEFAULT_MODEL, digest: MODEL_DIGEST },
          { name: "someone-else:1b", digest: "a".repeat(64) },
        ],
      },
    });
    await h.backend.close();
    const unloads = h.transport.callsFor("POST", "/api/generate");
    expect(unloads).toHaveLength(1);
    const body = unloads[0]?.body;
    if (body === undefined) throw new Error("expected an unload request body");
    expect(JSON.parse(new TextDecoder().decode(body))).toEqual({ model: DEFAULT_MODEL, keep_alive: 0 });
  });

  it("停掉自己启动的服务端", async () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "ollama.exe"), "");
    const h = harness({ cli: directory });
    h.transport.route("GET", "/", { failure: "network_unavailable" }, { status: 200 });
    expect((await h.backend.ensureServer()).ok).toBe(true);
    await h.backend.close();
    expect(h.children[0]?.terminated).toBe(true);
  });
});

describe("模型下载", () => {
  it("名字不合规时拒绝，不启动任何进程", async () => {
    const h = harness();
    expect(PULL_MODEL_PATTERN.test("-bad name")).toBe(false);
    expect(await h.backend.startModelPull("-bad name")).toEqual({
      status: "unavailable",
      errorCode: "invalid_model_name",
    });
    expect(h.commands).toEqual([]);
  });

  it("下载中再次请求报告 pull_in_progress", async () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "ollama.exe"), "");
    const h = harness({ cli: directory });
    h.transport.route("GET", "/", { status: 200 });
    expect(await h.backend.startModelPull("  llama3:latest  ")).toEqual({ status: "pulling", model: "llama3:latest" });
    expect(h.commands).toEqual([[join(directory, "ollama.exe"), "pull", "llama3:latest"]]);
    expect(await h.backend.startModelPull("llama3:latest")).toEqual({
      status: "unavailable",
      errorCode: "pull_in_progress",
    });
    expect(h.backend.modelPullStatus()).toEqual({ status: "pulling", model: "llama3:latest" });
  });

  it("退出码决定安装结果", async () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "ollama.exe"), "");
    const h = harness({ cli: directory });
    h.transport.route("GET", "/", { status: 200 });
    await h.backend.startModelPull("llama3:latest");
    const child = h.children[0];
    if (child === undefined) throw new Error("expected a pull child");
    child.code = 0;
    expect(h.backend.modelPullStatus()).toEqual({ status: "installed", model: "llama3:latest" });
    expect(h.backend.modelPullStatus()).toEqual({ status: "installed", model: "llama3:latest" });

    const g = harness({ cli: directory });
    g.transport.route("GET", "/", { status: 200 });
    await g.backend.startModelPull("llama3:latest");
    const failed = g.children[0];
    if (failed === undefined) throw new Error("expected a pull child");
    failed.code = 1;
    expect(g.backend.modelPullStatus()).toEqual({
      status: "unavailable",
      errorCode: "pull_failed",
      model: "llama3:latest",
    });
  });

  it("取消下载，杀不掉时如实报告", async () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "ollama.exe"), "");
    const h = harness({ cli: directory });
    h.transport.route("GET", "/", { status: 200 });
    await h.backend.startModelPull("llama3:latest");
    expect(await h.backend.cancelModelPull()).toEqual({ status: "cancelled", model: "llama3:latest" });
    expect(h.children[0]?.terminated).toBe(true);

    const g = harness({ cli: directory, stubborn: true });
    g.transport.route("GET", "/", { status: 200 });
    await g.backend.startModelPull("llama3:latest");
    expect(await g.backend.cancelModelPull()).toEqual({
      status: "unavailable",
      errorCode: "pull_cancel_failed",
      model: "llama3:latest",
    });
    expect(g.children[0]?.killed).toBe(true);
  });
});
