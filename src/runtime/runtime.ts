/**
 * 请求泵与空闲生命周期。
 *
 * 旧实现是 `SidecarRuntime`：轮询文件 IPC、把每个请求交给 dispatch、写响应与状态
 * 文件、空闲超时就自行退出。这里保持同样的时序与状态语义，只把「后台结果稍后写
 * 第二次响应」从 Future 回调换成等待 `completion` 承诺。
 */
import { renameSync, unlinkSync, writeFileSync } from "node:fs";

import type { RequestEnvelope } from "../contracts/envelope.js";
import { isOk, isErr, type Result } from "../domain/result.js";
import { DEFAULT_SETTINGS, settingsEqual, type Settings } from "../domain/settings.js";
import { normalizeSidecarState, type SidecarState } from "../domain/status.js";
import { isSafeMetadataCode } from "../domain/error-codes.js";
import { compact, type JsonValue } from "../json/canonical.js";
import { isJsonObject, type JsonObject } from "../json/guards.js";
import type { AppPaths } from "../ipc/app-paths.js";
import { FileIpc } from "../ipc/file-ipc.js";
import { SettingsStore, type SettingsStoreError } from "../settings/store.js";
import { ensurePrivateDirectory } from "../settings/private-directory.js";
import { monotonicSeconds, sleepSeconds } from "./clock.js";
import { unsupportedCompletionNotifier, type CompletionNotifier } from "./completion-notify.js";
import { unavailableDispatch, type DeferredReply, type Dispatch, type DispatchReply } from "./dispatch.js";
import { DEFAULT_IDLE_SECONDS, IdleTimer } from "./lifecycle.js";
import { MetadataLogger } from "./privacy-log.js";

export const DEFAULT_POLL_INTERVAL = 0.01;
/** 旧实现只清理 60 秒之前的传输文件：Lua 启动后可能立刻发请求。 */
export const TRANSIENT_GRACE_SECONDS = 60;

export interface SidecarRuntimeOptions {
  readonly paths: AppPaths;
  readonly dispatch?: Dispatch;
  readonly pollInterval?: number;
  readonly idleSeconds?: number;
  /** 单调时钟，用于空闲判断与耗时统计。 */
  readonly monotonic?: () => number;
  /** 墙钟秒数，用于状态文件时间戳与日志清理。 */
  readonly wallClock?: () => number;
  readonly sleep?: (seconds: number) => Promise<void>;
  readonly completionNotify?: CompletionNotifier;
  /** 旧实现用 `getattr(dispatch, "__self__", dispatch).close()` 关闭后端；这里显式注入。 */
  readonly closeDispatchOwner?: () => Promise<void> | void;
  readonly pid?: number;
  readonly settingsStore?: SettingsStore;
}

function removeIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // 文件本来就不在。
  }
}

/** 旧实现：缺 status 记成 "unknown"，不是字符串或不是短码记成 "error"。 */
function normalizeStatus(value: unknown): string {
  if (value === undefined) return "unknown";
  return typeof value === "string" && isSafeMetadataCode(value) ? value : "error";
}

/** 旧实现只接受 str/int 错误码，其它（含 bool 与浮点）记成 "invalid_error_code"。 */
function normalizeErrorCode(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || (typeof value === "number" && Number.isInteger(value))) {
    return isSafeMetadataCode(String(value)) ? value : "invalid_error_code";
  }
  return "invalid_error_code";
}

export class SidecarRuntime {
  readonly #paths: AppPaths;
  readonly #dispatch: Dispatch;
  readonly #pollInterval: number;
  readonly #monotonic: () => number;
  readonly #wallClock: () => number;
  readonly #sleep: (seconds: number) => Promise<void>;
  readonly #completionNotify: CompletionNotifier;
  readonly #closeOwner: (() => Promise<void> | void) | undefined;
  readonly #pid: number;
  readonly #store: SettingsStore;
  readonly #ipc: FileIpc;
  readonly #idle: IdleTimer;
  readonly #logs: MetadataLogger;
  #settings: Settings;
  #stopping = false;
  #lastState: SidecarState = "starting";
  #deferredPending = 0;

  constructor(options: SidecarRuntimeOptions) {
    const paths = options.paths;
    this.#paths = paths;
    this.#dispatch = options.dispatch ?? unavailableDispatch;
    this.#pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL;
    this.#monotonic = options.monotonic ?? monotonicSeconds;
    this.#wallClock = options.wallClock ?? ((): number => Date.now() / 1000);
    this.#sleep = options.sleep ?? sleepSeconds;
    this.#completionNotify = options.completionNotify ?? unsupportedCompletionNotifier;
    this.#closeOwner = options.closeDispatchOwner;
    this.#pid = options.pid ?? process.pid;

    ensurePrivateDirectory(paths.root);
    this.#store = options.settingsStore ?? new SettingsStore(paths.settings);
    const loaded = this.#store.load();
    // 旧实现在这里直接抛；读不了设置时按「关闭预测」处理更符合它自己的失败取向。
    this.#settings = isOk(loaded) ? loaded.value : DEFAULT_SETTINGS;

    this.#ipc = new FileIpc({ requests: paths.requests, responses: paths.responses });
    this.#ipc.cleanTransientFiles(this.#wallClock() - TRANSIENT_GRACE_SECONDS);
    removeIfExists(`${paths.status}.part`);
    this.#logs = new MetadataLogger(paths.log, { mode: this.#settings.logMode, now: this.#wallClock });
    this.#idle = new IdleTimer(options.idleSeconds ?? DEFAULT_IDLE_SECONDS, this.#monotonic);
    this.#writeStatus("ready");
  }

  get paths(): AppPaths {
    return this.#paths;
  }

  get settings(): Settings {
    return this.#settings;
  }

  get settingsStore(): SettingsStore {
    return this.#store;
  }

  get ipc(): FileIpc {
    return this.#ipc;
  }

  get logger(): MetadataLogger {
    return this.#logs;
  }

  get lastState(): SidecarState {
    return this.#lastState;
  }

  get deferredPending(): number {
    return this.#deferredPending;
  }

  /** 设置页与外部主机用它把空闲计时器往后推。 */
  get idle(): IdleTimer {
    return this.#idle;
  }

  get pid(): number {
    return this.#pid;
  }

  /** 重新读取设置文件；失败时调用方决定怎么降级。 */
  reloadSettings(): Result<Settings, SettingsStoreError> {
    const loaded = this.#store.load();
    if (isErr(loaded)) return loaded;
    this.#settings = loaded.value;
    this.#logs.mode = this.#settings.logMode;
    this.#idle.touch();
    return loaded;
  }

  stop(): void {
    this.#stopping = true;
  }

  /** 旧入口在 finally 里再写一次 "stopped"：`run()` 正常收尾与异常收尾都需要它。 */
  markStopped(): void {
    this.#writeStatus("stopped");
  }

  /** 处理完当前队列里的请求，返回处理了多少个。 */
  async pumpOnce(): Promise<number> {
    const requests = this.#ipc.takeRequests();
    for (const request of requests) {
      this.#idle.touch();
      this.#writeStatus("busy");
      const started = this.#monotonic();
      let deferred: DeferredReply | null = null;
      let payload: JsonObject;
      try {
        const settings = request.kind === "predict" ? this.#reloadOrDisable() : this.#settings;
        const reply: DispatchReply = await this.#dispatch(request, settings);
        if (reply.kind === "deferred") {
          deferred = reply;
          payload = reply.initial;
        } else {
          payload = reply.payload;
        }
        // dispatch 是可注入端口；外部实现可能在运行期给出非对象结果。
        if (!isJsonObject(payload)) {
          payload = { status: "error", error_code: "invalid_handler_result" };
        }
      } catch {
        payload = { status: "error", error_code: "handler_failed" };
      }

      const published = this.#ipc.publishResponse(request, payload);
      if (isErr(published)) {
        this.#logs.write("ipc_response", "error", null, "publish_failed");
      }
      if (deferred !== null) {
        this.#deferredPending += 1;
        void this.#finishDeferred(request, deferred);
      }

      const elapsed = Math.max(0, (this.#monotonic() - started) * 1000);
      const errorCode = normalizeErrorCode(payload["error_code"]);
      this.#logs.write("request", normalizeStatus(payload["status"]), elapsed, errorCode);
      this.#writeStatus("ready", typeof errorCode === "string" ? errorCode : null);
    }
    return requests.length;
  }

  async run(): Promise<void> {
    this.#idle.touch();
    while (!this.#stopping) {
      const handled = await this.pumpOnce();
      if (handled === 0 && this.#deferredPending === 0 && this.#idle.expired(this.#monotonic())) {
        break;
      }
      if (handled === 0) await this.#sleep(this.#pollInterval);
    }
    if (this.#closeOwner !== undefined) {
      try {
        await this.#closeOwner();
      } catch {
        // 关闭后端失败不该阻止侧车退出。
      }
    }
    this.#writeStatus("stopped");
  }

  /** 写第二次响应：后台结果落定后再发一次，并只在成功且合格时通知前端刷新。 */
  async #finishDeferred(request: RequestEnvelope, deferred: DeferredReply): Promise<void> {
    try {
      const resolved = await deferred.completion;
      if (resolved !== null) {
        const current = this.#store.load();
        if (isErr(current)) {
          // 与旧实现一致：读设置失败走下面的 handler_failed 分支。
          throw new Error(current.error);
        }
        const payload: JsonObject = settingsEqual(current.value, deferred.settings)
          ? resolved
          : { status: "unavailable", error_code: "settings_changed" };
        const published = this.#ipc.publishResponse(request, payload);
        this.#idle.touch();
        if (isOk(published) && published.value && payload["status"] === "ok" && payload["eligible"] === true) {
          try {
            this.#completionNotify({
              engineId: request.engineId,
              requestId: request.requestId,
              sequence: request.seq,
            });
          } catch {
            // 通知失败只影响刷新时延，不影响已经写好的响应。
          }
        }
      }
    } catch {
      // 不回传异常文本：里面可能夹带提供方响应内容。
      this.#ipc.publishResponse(request, { status: "unavailable", error_code: "handler_failed" });
    } finally {
      this.#deferredPending = Math.max(0, this.#deferredPending - 1);
    }
  }

  /** predict 前重读设置；文件不可用时退回默认设置（即停用预测），不沿用旧文件的启用状态。 */
  #reloadOrDisable(): Settings {
    const loaded = this.#store.load();
    if (isErr(loaded)) {
      this.#settings = DEFAULT_SETTINGS;
      this.#logs.mode = this.#settings.logMode;
      return this.#settings;
    }
    this.#settings = loaded.value;
    this.#logs.mode = this.#settings.logMode;
    this.#idle.touch();
    return this.#settings;
  }

  #writeStatus(state: SidecarState | string, errorCode: string | null = null): void {
    const normalized = normalizeSidecarState(state);
    this.#lastState = normalized;
    const value: Record<string, JsonValue> = { state: normalized, pid: this.#pid, updated_at: this.#wallClock() };
    if (errorCode !== null && isSafeMetadataCode(errorCode)) value["error_code"] = errorCode;
    const temporary = `${this.#paths.status}.part`;
    try {
      writeFileSync(temporary, compact(value));
      renameSync(temporary, this.#paths.status);
    } catch {
      // 状态文件只是诊断输出，写不进去也不该影响请求处理。
    }
  }
}
