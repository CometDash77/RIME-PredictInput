/**
 * 本地 Ollama 适配器。
 *
 * 这个模块只做一件事：把「用户选中了一个候选」翻译成对本机 Ollama 的一次调用，
 * 并把结果压成一个封闭的成功/失败判别联合。它不决定要不要调用（那是 inference 的事），
 * 也不知道候选页从哪来（那是 IPC 的事）。
 *
 * 与旧实现相比保留的行为，值得单独点出来的几条：
 * - 只有显式动作才会服务端启动或下载模型（`ensureServer` 只在真正需要时调用）。
 * - 引用的模型摘要每次调用都重新核对，摘要变了就报 invalid_model_response，而不是用错模型答话。
 * - 自己加载过的模型在退出时会尝试卸载，别人加载的不动。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { readdirSync } from "node:fs";
import { delimiter, join } from "node:path";

import {
  PsResponseSchema,
  TagsItemSchema,
  TagsResponseSchema,
  VersionResponseSchema,
  ChatResponseSchema,
  LoadedItemSchema,
  ManifestSchema,
} from "../contracts/ollama-wire.js";
import { chatRequestBody, chatRequestWire, identityFor } from "../contracts/policy.js";
import type { DecisionInput } from "../domain/decision.js";
import type { LocalBackendErrorCode } from "../domain/error-codes.js";
import { sha256Hex } from "../json/digest.js";
import { compact } from "../json/canonical.js";
import type { JsonObject } from "../json/guards.js";
import { parseStrictObject } from "../json/strict.js";
import { err, ok, type Result } from "../domain/result.js";
import type { Settings } from "../domain/settings.js";
import type { ChildHandle, ChildSpawner } from "../runtime/child-process.js";
import { spawnHidden } from "../runtime/child-process.js";
import { monotonicSeconds, sleepSeconds } from "../runtime/clock.js";
import { OwnedChildProcess } from "../runtime/lifecycle.js";
import { FetchTransport, decodeJsonBody, safeHttpError, type HttpTransportLike } from "./http.js";

export const OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const OLLAMA_KEEP_ALIVE = "60s";

/** 拉取动作只接受一个保守的模型名字符集（与旧实现同一正则）。 */
export const PULL_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,79}$/;

export interface ModelEntry {
  readonly name: string;
  readonly digest: string;
  readonly format: string;
}

export type ModelInventory =
  | { readonly status: "available"; readonly models: readonly ModelEntry[]; readonly source?: "manifests" }
  | { readonly status: "unavailable"; readonly errorCode: LocalBackendErrorCode; readonly models: readonly ModelEntry[] };

export interface ResolvedModel {
  readonly identity: string;
  readonly digest: string;
  readonly format: string;
}

export type ConnectionStatus =
  | { readonly status: "connected"; readonly provider: "local"; readonly version: string }
  | { readonly status: "unavailable"; readonly errorCode: LocalBackendErrorCode };

export type PullStatus =
  | { readonly status: "idle" }
  | { readonly status: "pulling"; readonly model: string | null }
  | { readonly status: "installed"; readonly model: string | null }
  | { readonly status: "cancelled"; readonly model: string | null }
  | { readonly status: "unavailable"; readonly errorCode: LocalBackendErrorCode; readonly model?: string | null };

export type LocalInferenceOutcome =
  | {
      readonly kind: "ok";
      readonly backend: "local";
      readonly provider: "ollama";
      readonly model: string;
      readonly choice: string;
      readonly requestedModel: string;
      readonly modelIdentity: string;
    }
  | { readonly kind: "unavailable"; readonly errorCode: LocalBackendErrorCode };

export interface LocalBackendOptions {
  readonly transport?: HttpTransportLike;
  readonly server?: OwnedChildProcess;
  readonly spawn?: ChildSpawner;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly monotonic?: () => number;
  readonly sleep?: (seconds: number) => Promise<void>;
  readonly startupTimeout?: number;
  readonly inferenceTimeout?: number;
}

/** Python 的真值判断，`[]` 与 `{}` 在这里也是假，和 JS 不同。 */
function pythonTruthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function environment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** `shutil.which("ollama", path=...)` 加一处已知安装位置。 */
export function findOllamaCli(env: Readonly<Record<string, string | undefined>>): string | null {
  for (const directory of (env["PATH"] ?? "").split(delimiter)) {
    if (directory === "") continue;
    for (const candidate of ["ollama.exe", "ollama"]) {
      const path = join(directory, candidate);
      if (existsSync(path) && statSync(path).isFile()) return path;
    }
  }
  const local = env["LOCALAPPDATA"];
  if (local !== undefined && local !== "") {
    const path = join(local, "Programs", "Ollama", "ollama.exe");
    if (existsSync(path) && statSync(path).isFile()) return path;
  }
  return null;
}

function expandUser(path: string, env: Readonly<Record<string, string | undefined>>): string {
  if (!path.startsWith("~/") && !path.startsWith("~\\")) return path;
  const profile = env["USERPROFILE"];
  return profile === undefined ? path : join(profile, path.slice(2));
}

export class LocalBackend {
  readonly #transport: HttpTransportLike;
  readonly #server: OwnedChildProcess;
  readonly #spawn: ChildSpawner;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #monotonic: () => number;
  readonly #sleep: (seconds: number) => Promise<void>;
  readonly #startupTimeout: number;
  readonly #inferenceTimeout: number;

  #ownsServer = false;
  readonly #loadedByUs = new Map<string, string>();
  #digests = new Map<string, string>();
  #formats = new Map<string, string>();
  #lastError: LocalBackendErrorCode | null = null;
  #pullHandle: ChildHandle | null = null;
  #pullModel: string | null = null;
  #pullResult: PullStatus = { status: "idle" };

  constructor(options: LocalBackendOptions = {}) {
    this.#transport = options.transport ?? new FetchTransport();
    this.#server = options.server ?? new OwnedChildProcess();
    this.#spawn = options.spawn ?? spawnHidden;
    this.#env = options.env ?? process.env;
    this.#monotonic = options.monotonic ?? monotonicSeconds;
    this.#sleep = options.sleep ?? sleepSeconds;
    this.#startupTimeout = options.startupTimeout ?? 2;
    this.#inferenceTimeout = options.inferenceTimeout ?? 30;
  }

  static get keepAlive(): string {
    return OLLAMA_KEEP_ALIVE;
  }

  async #request(
    method: string,
    path: string,
    options: { readonly payload?: JsonObject; readonly timeout?: number } = {},
  ): Promise<Result<{ readonly status: number; readonly body: Uint8Array }, LocalBackendErrorCode>> {
    const body = options.payload === undefined ? undefined : Buffer.from(compact(options.payload), "utf8");
    return await this.#transport.request(method, OLLAMA_BASE_URL + path, {
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body }),
      timeoutSeconds: options.timeout ?? 1,
    });
  }

  async #probe(): Promise<boolean> {
    const response = await this.#request("GET", "/", { timeout: 0.35 });
    if (!response.ok) {
      this.#lastError = response.error;
      return false;
    }
    if (response.value.status === 200) {
      this.#lastError = null;
      return true;
    }
    this.#lastError = response.value.status === 401 ? "local_auth_required" : safeHttpError(response.value.status);
    return false;
  }

  /** 需要服务端时才启动它；启动失败会把刚拉起来的进程收掉。 */
  async ensureServer(): Promise<Result<true, LocalBackendErrorCode>> {
    if (await this.#probe()) return ok(true);
    if (this.#lastError === "local_auth_required") return err("local_auth_required");
    const cli = findOllamaCli(this.#env);
    if (cli === null) return err("ollama_missing");
    const childEnv = {
      ...environment(this.#env),
      OLLAMA_HOST: "127.0.0.1:11434",
      OLLAMA_KEEP_ALIVE: OLLAMA_KEEP_ALIVE,
    };
    try {
      this.#server.start([cli, "serve"], { env: childEnv });
      this.#ownsServer = true;
    } catch {
      return err("ollama_start_failed");
    }
    const deadline = this.#monotonic() + this.#startupTimeout;
    while (this.#monotonic() < deadline) {
      if (await this.#probe()) return ok(true);
      if (!this.#server.running) break;
      await this.#sleep(Math.min(0.05, Math.max(0, deadline - this.#monotonic())));
    }
    if (this.#ownsServer) {
      await this.#server.stop();
      this.#ownsServer = false;
    }
    return err("ollama_start_failed");
  }

  async modelInventory(options: { readonly startServer?: boolean } = {}): Promise<ModelInventory> {
    if (options.startServer === true) {
      const ready = await this.ensureServer();
      if (!ready.ok) return { status: "unavailable", errorCode: ready.error, models: [] };
    } else if (!(await this.#probe())) {
      return this.#manifestInventory();
    }
    try {
      const response = await this.#request("GET", "/api/tags", { timeout: 1 });
      if (!response.ok) return { status: "unavailable", errorCode: response.error, models: [] };
      if (response.value.status !== 200) {
        // 开了鉴权的本机服务读不了清单，但 manifests 目录仍然能读出已装的模型。
        if (response.value.status === 401) return this.#manifestInventory();
        return { status: "unavailable", errorCode: safeHttpError(response.value.status), models: [] };
      }
      const decoded = decodeJsonBody(response.value.body);
      if (!decoded.ok) return { status: "unavailable", errorCode: "invalid_model_list", models: [] };
      const parsed = TagsResponseSchema.safeParse(decoded.value);
      if (!parsed.success) return { status: "unavailable", errorCode: "invalid_model_list", models: [] };
      const models: ModelEntry[] = [];
      this.#digests = new Map();
      this.#formats = new Map();
      for (const raw of parsed.data.models) {
        const item = TagsItemSchema.safeParse(raw);
        if (!item.success) continue;
        const name = item.data.name;
        const digest = (item.data.digest ?? "unknown").toLowerCase();
        const format = item.data.details?.format ?? "unknown";
        this.#digests.set(name, digest);
        this.#formats.set(name, format);
        models.push({ name, digest, format });
      }
      return { status: "available", models };
    } catch {
      return { status: "unavailable", errorCode: "invalid_model_list", models: [] };
    }
  }

  async testConnection(): Promise<ConnectionStatus> {
    if (!(await this.#probe())) {
      let error: LocalBackendErrorCode = this.#lastError ?? "local_unavailable";
      if (error === "network_unavailable" && findOllamaCli(this.#env) === null) error = "ollama_missing";
      return { status: "unavailable", errorCode: error };
    }
    const response = await this.#request("GET", "/api/version", { timeout: 1 });
    if (!response.ok) return { status: "unavailable", errorCode: response.error };
    if (response.value.status === 401) return { status: "unavailable", errorCode: "local_auth_required" };
    if (response.value.status !== 200) {
      return { status: "unavailable", errorCode: safeHttpError(response.value.status) };
    }
    const decoded = decodeJsonBody(response.value.body);
    if (!decoded.ok) return { status: "connected", provider: "local", version: "unknown" };
    const parsed = VersionResponseSchema.safeParse(decoded.value);
    const version = parsed.success ? parsed.data.version : undefined;
    return { status: "connected", provider: "local", version: version ?? "unknown" };
  }

  async resolveModel(model: string): Promise<Result<ResolvedModel, LocalBackendErrorCode>> {
    const ready = await this.ensureServer();
    if (!ready.ok) return err(ready.error);
    const inventory = await this.modelInventory();
    if (inventory.status !== "available") return err(inventory.errorCode);
    const digest = this.#digests.get(model);
    if (digest === undefined) return err("model_missing");
    if (digest === "unknown") return err("model_version_unavailable");
    return ok({ identity: identityFor(digest), digest, format: this.#formats.get(model) ?? "unknown" });
  }

  isRouter(model: string): boolean {
    return this.#formats.get(model) === "router";
  }

  digestOf(model: string): string | null {
    return this.#digests.get(model) ?? null;
  }

  async infer(
    decision: DecisionInput,
    settings: Settings,
    options: { readonly modelIdentity?: string } = {},
  ): Promise<LocalInferenceOutcome> {
    let identity = options.modelIdentity;
    if (identity === undefined) {
      const resolved = await this.resolveModel(settings.localModel);
      if (!resolved.ok) return { kind: "unavailable", errorCode: resolved.error };
      identity = resolved.value.identity;
    }
    try {
      const body = chatRequestBody(decision, settings.localModel);
      // 旧实现里缺候选字段会在这一步抛 ValueError，并被归入 invalid_model_response。
      if (!body.ok) return { kind: "unavailable", errorCode: "invalid_model_response" };
      const loaded = await this.#request("GET", "/api/ps", { timeout: 1 });
      if (!loaded.ok) return { kind: "unavailable", errorCode: loaded.error };
      // 读不到「谁加载了模型」就不能断言归属，宁可不答。
      if (loaded.value.status !== 200) return { kind: "unavailable", errorCode: "model_ownership_unavailable" };
      const loadedBody = decodeJsonBody(loaded.value.body);
      if (!loadedBody.ok) throw new Error("invalid_loaded_models");
      const loadedModels = PsResponseSchema.safeParse(loadedBody.value);
      if (!loadedModels.success) throw new Error("invalid_loaded_models");
      const preexisting = loadedModels.data.models.some((raw) => {
        const item = LoadedItemSchema.safeParse(raw);
        if (!item.success) return false;
        return (item.data.name ?? item.data.model) === settings.localModel;
      });
      const digest = this.#digests.get(settings.localModel);
      if (digest === undefined || digest === "unknown" || identityFor(digest) !== identity) {
        throw new Error("model_identity_changed");
      }
      if (!preexisting) {
        // 先记账再发请求：超时也可能已经把模型加载进来了。
        this.#loadedByUs.set(settings.localModel, digest);
      }
      const keepAlive = preexisting && !this.#loadedByUs.has(settings.localModel) ? false : true;
      const wire = chatRequestWire(body.value, { keepAlive });
      const response = await this.#request("POST", "/api/chat", { payload: wire, timeout: this.#inferenceTimeout });
      if (!response.ok) return { kind: "unavailable", errorCode: response.error };
      if (response.value.status !== 200) {
        return { kind: "unavailable", errorCode: safeHttpError(response.value.status) };
      }
      const decoded = decodeJsonBody(response.value.body);
      if (!decoded.ok) throw new Error("invalid_response_json");
      const chat = ChatResponseSchema.safeParse(decoded.value);
      if (!chat.success || chat.data.model !== settings.localModel) throw new Error("invalid_response_identity");
      if (pythonTruthy(chat.data.message.thinking)) throw new Error("thinking_not_allowed");
      const answer = parseStrictObject(chat.data.message.content);
      if (!answer.ok) throw new Error("invalid_response_choice");
      const keys = Object.keys(answer.value);
      if (keys.length !== 1 || keys[0] !== "choice") throw new Error("invalid_response_choice");
      const choice = answer.value["choice"];
      if (typeof choice !== "number" || !Number.isInteger(choice)) throw new Error("invalid_response_choice");
      if (choice < 1 || choice > decision.candidates.length) throw new Error("choice_out_of_range");
      return {
        kind: "ok",
        backend: "local",
        provider: "ollama",
        model: settings.localModel,
        choice: String(choice),
        requestedModel: settings.localModel,
        modelIdentity: identity,
      };
    } catch {
      return { kind: "unavailable", errorCode: "invalid_model_response" };
    }
  }

  /** 只由用户点按钮触发的下载；不弹控制台、不自动开始。 */
  async startModelPull(model: unknown): Promise<PullStatus> {
    const trimmed = typeof model === "string" ? model.trim() : "";
    if (!PULL_MODEL_PATTERN.test(trimmed)) return { status: "unavailable", errorCode: "invalid_model_name" };
    if (this.#pullHandle !== null && this.#pullHandle.exitCode() === null) {
      return { status: "unavailable", errorCode: "pull_in_progress" };
    }
    const ready = await this.ensureServer();
    if (!ready.ok) return { status: "unavailable", errorCode: ready.error };
    const cli = findOllamaCli(this.#env);
    if (cli === null) return { status: "unavailable", errorCode: "ollama_missing" };
    const childEnv = { ...environment(this.#env), OLLAMA_HOST: "127.0.0.1:11434" };
    try {
      this.#pullHandle = this.#spawn([cli, "pull", trimmed], { env: childEnv });
    } catch {
      this.#pullHandle = null;
      this.#pullResult = { status: "unavailable", errorCode: "pull_start_failed" };
      return this.#pullResult;
    }
    this.#pullModel = trimmed;
    this.#pullResult = { status: "pulling", model: trimmed };
    return this.#pullResult;
  }

  modelPullStatus(): PullStatus {
    const handle = this.#pullHandle;
    if (handle === null) return this.#pullResult;
    const code = handle.exitCode();
    if (code === null) return { status: "pulling", model: this.#pullModel };
    this.#pullHandle = null;
    this.#pullResult =
      code === 0
        ? { status: "installed", model: this.#pullModel }
        : { status: "unavailable", model: this.#pullModel, errorCode: "pull_failed" };
    return this.#pullResult;
  }

  /** 只取消本进程启动的那个下载客户端。 */
  async cancelModelPull(): Promise<PullStatus> {
    const handle = this.#pullHandle;
    if (handle === null || handle.exitCode() !== null) return this.modelPullStatus();
    handle.terminate();
    if (!(await handle.waitForExit(2000))) {
      handle.kill();
      if (!(await handle.waitForExit(2000))) {
        return { status: "unavailable", errorCode: "pull_cancel_failed", model: this.#pullModel };
      }
    }
    this.#pullHandle = null;
    this.#pullResult = { status: "cancelled", model: this.#pullModel };
    return this.#pullResult;
  }

  /** 服务端不可达时直接读 manifests 目录，免得设置页在 Ollama 没起来时一片空白。 */
  #manifestInventory(): ModelInventory {
    const fromEnv = this.#env["OLLAMA_MODELS"];
    const profile = this.#env["USERPROFILE"];
    const base = fromEnv !== undefined && fromEnv !== "" ? fromEnv : profile !== undefined && profile !== "" ? join(profile, ".ollama", "models") : null;
    if (base === null) {
      return { status: "unavailable", errorCode: this.#lastError ?? "model_store_unavailable", models: [] };
    }
    const manifestRoot = join(expandUser(base, this.#env), "manifests");
    if (!existsSync(manifestRoot) || !statSync(manifestRoot).isDirectory()) {
      return { status: "unavailable", errorCode: this.#lastError ?? "model_store_unavailable", models: [] };
    }
    const models: ModelEntry[] = [];
    this.#digests = new Map();
    this.#formats = new Map();
    for (const entry of readdirSync(manifestRoot, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      const parts = path.slice(manifestRoot.length + 1).split(/[\\/]/);
      if (parts.length < 3) continue;
      const name =
        parts[0] === "registry.ollama.ai" && parts[1] === "library"
          ? parts.slice(-2).join(":")
          : parts.slice(0, -1).join("/") + ":" + parts.slice(-1)[0];
      let raw: Uint8Array;
      try {
        raw = readFileSync(path);
      } catch {
        continue;
      }
      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
      } catch {
        continue;
      }
      const manifest = ManifestSchema.safeParse(parsedValue);
      if (!manifest.success) continue;
      const digest = sha256Hex(raw);
      this.#digests.set(name, digest);
      const modelFormat = manifest.data.model_info?.["general.architecture"] === "router" ? "router" : "unknown";
      this.#formats.set(name, modelFormat);
      models.push({ name, digest, format: modelFormat });
    }
    models.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    return { status: "available", source: "manifests", models };
  }

  /** 退出时释放自己加载过的模型，并停掉自己启动的服务端。 */
  async close(): Promise<void> {
    await this.cancelModelPull();
    if (this.#loadedByUs.size > 0) {
      try {
        const response = await this.#request("GET", "/api/ps", { timeout: 2 });
        if (response.ok && response.value.status === 200) {
          const body = decodeJsonBody(response.value.body);
          const models = body.ok ? PsResponseSchema.safeParse(body.value) : null;
          if (models !== null && models.success) {
            for (const raw of models.data.models) {
              const item = LoadedItemSchema.safeParse(raw);
              if (!item.success) continue;
              const name = item.data.name ?? item.data.model;
              if (name === undefined) continue;
              if (this.#loadedByUs.get(name) !== item.data.digest) continue;
              await this.#request("POST", "/api/generate", {
                payload: { model: name, keep_alive: 0 },
                timeout: 2,
              });
            }
          }
        }
      } catch {
        // 关闭流程尽力而为：自有服务端坏掉时不能卡住退出。
      }
    }
    this.#loadedByUs.clear();
    if (this.#ownsServer) {
      await this.#server.stop();
      this.#ownsServer = false;
    }
  }
}
