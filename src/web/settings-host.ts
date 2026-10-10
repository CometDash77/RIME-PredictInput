/**
 * 只有本机回环、且写操作必须带短时令牌的设置页主机。
 *
 * 旧实现是 `SettingsWebHost`：一个最小 HTTP 服务，页面本身从磁盘读同一个
 * `settings.html`（每次请求都换一个新的 CSP nonce），除 `/` 与 `/session` 之外的
 * 每个入口都要 `Authorization: Bearer <token>`。这里保留全部状态码、响应头与
 * 错误码字符串，因为这些是页面脚本实际读的契约。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { isErr, ok, err, type Result } from "../domain/result.js";
import { settingsFromMapping, toWire, type Settings } from "../domain/settings.js";
import type { InferenceStatusMetadata, SidecarState } from "../domain/status.js";
import { healthWire, type HealthReport } from "../inference/health.js";
import { settingsActionWire, type SettingsActionReply } from "../inference/actions.js";
import { compact, type JsonValue } from "../json/canonical.js";
import { isJsonObject, type JsonObject } from "../json/guards.js";
import type { UpdateCheckOutcome } from "../providers/update.js";
import type { SettingsStoreError } from "../settings/store.js";
import { safeError, safeMetadata } from "./safe-metadata.js";

export const HOST = "127.0.0.1";
export const PORT = 48371;
export const TOKEN_TTL_SECONDS = 15 * 60;
export const MAX_SESSIONS = 16;
export const MAX_BODY_BYTES = 8192;
/** 页面里唯一的替换点：内联样式与脚本的 CSP nonce 都来自它。 */
export const PAGE_NONCE_PLACEHOLDER = "__NONCE__";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,128}$/;
/** 旧实现把「内部故障」与「用户输入错误」分开：前者 503，后者 400 且只回白名单文案。 */
const UNAVAILABLE = "operation_unavailable";

export interface SettingsWebInference {
  readonly statusRevision: number;
  health(settings: Settings): Promise<HealthReport>;
  statusSince(revision: number): InferenceStatusMetadata;
  settingsAction(payload: JsonObject, settings: Settings): Promise<SettingsActionReply>;
}

export interface SettingsWebStore {
  save(settings: Settings, options?: { readonly overwrite?: boolean }): Result<Settings, SettingsStoreError>;
}

export interface SettingsWebRuntime {
  readonly lastState: SidecarState;
  readonly pid: number;
  readonly settings: Settings;
  readonly settingsStore: SettingsWebStore;
  readonly idle: { touch(): void };
  reloadSettings(): Result<Settings, SettingsStoreError>;
}

/** 更新检查入口：设置页会话读取时被询问；节流与静默由实现负责（spec #10）。 */
export interface SettingsWebUpdates {
  maybeCheck(): Promise<UpdateCheckOutcome>;
}

export interface SettingsWebHostOptions {
  readonly inference: SettingsWebInference;
  readonly runtime: SettingsWebRuntime;
  /** 缺省 = 不查更新，视图不带 update 字段（页面完全静默）。 */
  readonly updates?: SettingsWebUpdates;
  readonly host?: string;
  readonly port?: number;
  readonly initialToken?: string | null;
  /** 默认指向仓库根的 `assets/settings.html`；`src/` 与 `dist/` 解析结果相同。 */
  readonly pageUrl?: URL;
  readonly now?: () => number;
}

function digestOf(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function pathnameOf(target: string): string {
  try {
    return new URL(target, `http://${HOST}`).pathname;
  } catch {
    return target;
  }
}

/** 只保留 JSON 标量/容器，键一律是字符串：给响应体用的最小构造器。 */
function jsonRecord(entries: Record<string, JsonValue>): JsonObject {
  return entries;
}

/** `safeMetadata` 的输出一定还能收窄成对象：输入本来就是对象。 */
function filteredObject(value: unknown): JsonObject {
  const filtered = safeMetadata(value);
  return isJsonObject(filtered) ? filtered : {};
}

export class SettingsWebHost {
  readonly #inference: SettingsWebInference;
  readonly #runtime: SettingsWebRuntime;
  readonly #updates: SettingsWebUpdates | undefined;
  readonly #host: string;
  readonly #pageUrl: URL;
  readonly #now: () => number;
  readonly #tokens = new Map<string, number>();
  readonly #revisions = new Map<string, number>();
  #port: number;
  #server: Server | null = null;

  constructor(options: SettingsWebHostOptions) {
    const host = options.host ?? HOST;
    if (host !== HOST) throw new Error("settings host must bind to IPv4 loopback");
    this.#inference = options.inference;
    this.#runtime = options.runtime;
    this.#updates = options.updates;
    this.#host = host;
    this.#port = options.port ?? PORT;
    this.#now = options.now ?? ((): number => Date.now() / 1000);
    this.#pageUrl = options.pageUrl ?? new URL("../../assets/settings.html", import.meta.url);
    const initial = options.initialToken;
    if (initial !== undefined && initial !== null) this.registerToken(initial);
  }

  get port(): number {
    return this.#port;
  }

  get host(): string {
    return this.#host;
  }

  /** 旧实现要求 40..128 个 URL 安全字符，并以 SHA-256 摘要保存。 */
  registerToken(token: unknown): boolean {
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return false;
    const digest = digestOf(token);
    const now = this.#now();
    this.#prune(now);
    if (!this.#tokens.has(digest)) {
      if (this.#tokens.size >= MAX_SESSIONS) return false;
      this.#revisions.set(digest, this.#inference.statusRevision);
    }
    this.#tokens.set(digest, now + TOKEN_TTL_SECONDS);
    return true;
  }

  async start(): Promise<void> {
    if (this.#server !== null) return;
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: this.#host, port: this.#port });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("settings host did not bind to a TCP port");
    }
    this.#port = address.port;
    this.#server = server;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (server !== null) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    }
    this.#tokens.clear();
    this.#revisions.clear();
  }

  #prune(now: number): void {
    for (const [key, expires] of [...this.#tokens]) {
      if (expires <= now) {
        this.#tokens.delete(key);
        this.#revisions.delete(key);
      }
    }
  }

  /** 命中即续期；比较用定长摘要，避免把存在的令牌长度暴露给调用方。 */
  #checkToken(token: unknown): string | null {
    if (typeof token !== "string") return null;
    const digest = digestOf(token);
    const now = this.#now();
    this.#prune(now);
    const wanted = Buffer.from(digest, "hex");
    for (const [key, expires] of this.#tokens) {
      if (timingSafeEqual(Buffer.from(key, "hex"), wanted) && expires > now) {
        this.#tokens.set(key, now + TOKEN_TTL_SECONDS);
        return key;
      }
    }
    return null;
  }

  #authorize(request: IncomingMessage): string | null {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    return this.#checkToken(header.slice(7));
  }

  /** 旧实现要求 Host 头正好是回环地址加实际端口，防止 DNS 重绑定类访问。 */
  #hostOk(request: IncomingMessage): boolean {
    const header = request.headers.host ?? "";
    return header.toLowerCase() === `${this.#host}:${this.#port}`.toLowerCase();
  }

  #baseHeaders(nonce: string): Record<string, string> {
    const scriptPolicy = nonce === "" ? "'none'" : `'nonce-${nonce}'`;
    return {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": [
        "default-src 'self'",
        "connect-src 'self'",
        `style-src 'nonce-${nonce}'`,
        `script-src ${scriptPolicy}`,
        "img-src 'self' data:",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
      "X-Frame-Options": "DENY",
    };
  }

  #send(response: ServerResponse, status: number, body: Uint8Array, contentType: string, nonce: string): void {
    response.writeHead(status, {
      "Content-Type": contentType,
      "Content-Length": String(body.byteLength),
      ...this.#baseHeaders(nonce),
    });
    response.end(body);
  }

  #sendJson(response: ServerResponse, status: number, value: Record<string, JsonValue>): void {
    const body = Buffer.from(compact(value), "utf8");
    this.#send(response, status, body, "application/json; charset=utf-8", "");
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const method = request.method ?? "GET";
      if (method === "OPTIONS") {
        this.#sendJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      if (method !== "GET" && method !== "POST") {
        this.#sendJson(response, 404, { error: "not_found" });
        return;
      }
      if (!this.#hostOk(request)) {
        this.#sendJson(response, 400, { error: "invalid_host" });
        return;
      }
      const path = pathnameOf(request.url ?? "/");
      if (method === "GET") {
        await this.#handleGet(request, response, path);
        return;
      }
      await this.#handlePost(request, response, path);
    } catch {
      // 未预料的异常一律折成 503；路径、头部与正文都不进日志、也不回给页面。
      if (!response.headersSent) this.#sendJson(response, 503, { error: UNAVAILABLE });
      else response.end();
    }
  }

  async #handleGet(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    if (path === "/") {
      const nonce = randomBytes(18).toString("base64url");
      let page: string;
      try {
        page = readFileSync(this.#pageUrl, "utf8");
      } catch {
        this.#sendJson(response, 503, { error: "ui_unavailable" });
        return;
      }
      const body = Buffer.from(page.replaceAll(PAGE_NONCE_PLACEHOLDER, nonce), "utf8");
      this.#send(response, 200, body, "text/html; charset=utf-8", nonce);
      return;
    }
    if (path !== "/api/settings") {
      this.#sendJson(response, 404, { error: "not_found" });
      return;
    }
    const key = this.#authorize(request);
    if (key === null) {
      this.#sendJson(response, 401, { error: "session_expired" });
      return;
    }
    this.#runtime.idle.touch();
    const view = await this.#settingsView(key);
    if (isErr(view)) {
      this.#sendJson(response, 400, { error: safeError(view.error) });
      return;
    }
    this.#sendJson(response, 200, view.value);
  }

  async #handlePost(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    if (path === "/session") {
      const origin = request.headers.origin;
      if (typeof origin === "string" && origin.toLowerCase() !== `http://${this.#host}:${this.#port}`.toLowerCase()) {
        this.#sendJson(response, 403, { error: "origin_rejected" });
        return;
      }
      const body = await this.#readJson(request, response);
      if (isErr(body) || !this.registerToken(body.value["token"])) {
        this.#sendJson(response, 400, { error: "invalid_session" });
        return;
      }
      this.#runtime.idle.touch();
      this.#sendJson(response, 200, { status: "session_ready" });
      return;
    }

    const key = this.#authorize(request);
    if (key === null) {
      this.#sendJson(response, 401, { error: "session_expired" });
      return;
    }
    this.#runtime.idle.touch();
    if (path === "/api/session/end") {
      this.#tokens.delete(key);
      this.#revisions.delete(key);
      this.#sendJson(response, 200, { status: "ended" });
      return;
    }
    const body = await this.#readJson(request, response);
    if (isErr(body)) {
      this.#sendJson(response, 400, { error: "invalid_json" });
      return;
    }
    if (path === "/api/settings") {
      const saved = this.#saveSettings(body.value);
      if (isErr(saved)) {
        if (saved.error === UNAVAILABLE) this.#sendJson(response, 503, { error: UNAVAILABLE });
        else this.#sendJson(response, 400, { error: safeError(saved.error) });
        return;
      }
      this.#sendJson(response, 200, saved.value);
      return;
    }
    if (path === "/api/action") {
      const acted = await this.#action(body.value);
      if (isErr(acted)) {
        if (acted.error === UNAVAILABLE) this.#sendJson(response, 503, { error: UNAVAILABLE });
        else this.#sendJson(response, 400, { error: safeError(acted.error) });
        return;
      }
      this.#sendJson(response, 200, acted.value);
      return;
    }
    this.#sendJson(response, 404, { error: "not_found" });
  }

  /**
   * 读正文：长度必须由 `Content-Length` 给出且不超过 8192，媒体类型必须是 JSON。
   * 任一不满足都按旧实现「不再复用这条连接」处理，并让调用方回 400。
   */
  async #readJson(request: IncomingMessage, response: ServerResponse): Promise<Result<JsonObject, "invalid_json">> {
    const rawLength = request.headers["content-length"];
    const length = typeof rawLength === "string" && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
    const contentType = request.headers["content-type"] ?? "";
    if (length === null || length > MAX_BODY_BYTES || contentType.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      response.shouldKeepAlive = false;
      return err("invalid_json");
    }
    const raw = await this.#readBody(request, length);
    if (raw === null) return err("invalid_json");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      return err("invalid_json");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return err("invalid_json");
    }
    return isJsonObject(parsed) ? ok(parsed) : err("invalid_json");
  }

  #readBody(request: IncomingMessage, length: number): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let received = 0;
      let overflow = false;
      let done = false;
      const finish = (value: Uint8Array | null): void => {
        if (done) return;
        done = true;
        resolve(value);
      };
      request.on("data", (chunk: Buffer) => {
        received += chunk.byteLength;
        if (received > length || received > MAX_BODY_BYTES) {
          // 声明长度与实际不符：读完就丢，交给调用方回 400 并断开连接。
          overflow = true;
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        finish(overflow ? null : Buffer.concat(chunks));
      });
      request.on("error", () => {
        finish(null);
      });
      request.on("aborted", () => {
        finish(null);
      });
    });
  }

  /** 页面拿到的是设置本体、经过裁剪的健康快照、更新检查结果，以及伴随进程状态。 */
  async #settingsView(key: string): Promise<Result<JsonObject, string>> {
    const settings = this.#runtime.reloadSettings();
    if (isErr(settings)) return err(settings.error);
    // health 与更新检查并行：更新检查自带超时上限（FetchTransport 缺省 3 秒），
    // 不叠加到页面加载，也不会阻塞预测链路——只有设置页会话读取才会触发。
    const [health, update] = await Promise.all([
      this.#health(settings.value),
      this.#updateView(settings.value.updateCheckEnabled),
    ]);
    const revision = this.#revisions.get(key) ?? this.#inference.statusRevision;
    const view: Record<string, JsonValue> = { ...health, last_inference: this.#inference.statusSince(revision) };
    return ok({
      settings: toWire(settings.value),
      health: jsonRecord(view),
      ...(update === null ? {} : { update }),
      sidecar: jsonRecord({ state: this.#runtime.lastState, pid: this.#runtime.pid }),
    });
  }

  async #health(settings: Settings): Promise<JsonObject> {
    try {
      return filteredObject(healthWire(await this.#inference.health(settings)));
    } catch {
      return jsonRecord({ status: "unavailable", error_code: "status_unavailable" });
    }
  }

  /**
   * 更新检查视图：开关关闭或未接线时不下场；unavailable 也折叠成不下场——
   * 页面只对 update-available / up-to-date 有反应，失败与关闭都完全静默
   * （spec #10 用户故事 23/24）。产出只透传 tag 与 github.com 跳转链接。
   */
  async #updateView(enabled: boolean): Promise<JsonObject | null> {
    const checker = this.#updates;
    if (checker === undefined || !enabled) return null;
    let outcome: UpdateCheckOutcome;
    try {
      outcome = await checker.maybeCheck();
    } catch {
      return null;
    }
    if (outcome.kind === "update-available") {
      return jsonRecord({ kind: "update-available", tag: outcome.latest.tag, url: outcome.latest.url });
    }
    if (outcome.kind === "up-to-date") return jsonRecord({ kind: "up-to-date" });
    return null;
  }

  #saveSettings(raw: JsonObject): Result<JsonObject, string> {
    const parsed = settingsFromMapping(raw);
    if (isErr(parsed)) return err(parsed.error);
    const saved = this.#runtime.settingsStore.save(parsed.value);
    if (isErr(saved)) return err(UNAVAILABLE);
    const reloaded = this.#runtime.reloadSettings();
    if (isErr(reloaded)) return err(reloaded.error);
    return ok(jsonRecord({ status: "ok" }));
  }

  async #action(raw: JsonObject): Promise<Result<JsonObject, string>> {
    if (raw["action"] === "clear_cache") {
      const cleared = await this.#inference.settingsAction(jsonRecord({ action: "clear_cache" }), this.#runtime.settings);
      return ok(filteredObject(settingsActionWire(cleared)));
    }
    const settings = this.#runtime.reloadSettings();
    if (isErr(settings)) return err(settings.error);
    const reply = await this.#inference.settingsAction(raw, settings.value);
    return ok(filteredObject(settingsActionWire(reply)));
  }
}
