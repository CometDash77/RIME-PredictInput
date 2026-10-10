import { VALIDATION, cloudIdentityFor, isEligibleIdentity } from "../contracts/policy.js";
import type { RequestEnvelope } from "../contracts/envelope.js";
import { decisionInputFromPayload, type DecisionInput } from "../domain/decision.js";
import { ENGINE_ID_PATTERN } from "../domain/ids.js";
import type { LocalBackendErrorCode } from "../domain/error-codes.js";
import { DEFAULT_LOCAL_BASE_URL, type CloudChannel, type Settings } from "../domain/settings.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  STATUS_METADATA_KEYS,
  type InferenceStatusMetadata,
  type InferenceStatusMetadataDraft,
} from "../domain/status.js";
import { MAX_QUEUED_PREDICTIONS } from "../domain/cache-limits.js";
import { HEX_32 } from "../json/digest.js";
import type { JsonValue } from "../json/canonical.js";
import type { JsonObject } from "../json/guards.js";
import { CloudBackend } from "../providers/cloud.js";
import { settingsActionWire, type SettingsActionReply } from "./actions.js";
import { PredictionCache } from "./cache.js";
import { healthWire, type HealthReport } from "./health.js";
import { describeModel, type ModelStatus } from "./model-status.js";
import { failedCloudOutcome, failedLocalOutcome, failedOutcome, pendingOutcome, predictionWire, type PredictionOk, type PredictionOutcome } from "./outcome.js";
import type { CloudChannelPort, LocalBackendPort } from "./ports.js";
import { CancelledTask, SerialQueue, type QueuedTask } from "./queue.js";
import type { DispatchReply } from "../runtime/dispatch.js";

/**
 * dispatch 的结果契约属于 runner 一侧（`runtime/dispatch.ts`）。
 *
 * 「先回 pending、稍后补一次」的形状由 runtime 负责兑现，这里原样转发类型，
 * 避免两个模块各写一份而慢慢漂移。
 */
export type { DispatchReply };

export interface InferenceServiceOptions {
  readonly local: LocalBackendPort;
  /** 云端通道端口；缺省用真实 CloudBackend（未启用云端时不会出网）。 */
  readonly cloud?: CloudChannelPort;
  readonly cache?: PredictionCache;
  readonly sleep?: (seconds: number) => Promise<void>;
  readonly monotonic?: () => number;
}

async function defaultSleep(seconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, seconds) * 1000);
  });
}

function defaultMonotonic(): number {
  return performance.now() / 1000;
}

/** 把「未验收/未安装」等分支统一交给 `describeModel`，这里只负责取清单。 */
export class InferenceService {
  readonly #local: LocalBackendPort;
  readonly #cloud: CloudChannelPort;
  readonly #cache: PredictionCache;
  readonly #sleep: (seconds: number) => Promise<void>;
  readonly #monotonic: () => number;
  readonly #queue = new SerialQueue();
  // 引擎标识在这里只当不透明键用，用 string 免得每次从载荷里取出来都要断言。
  readonly #queued = new Map<string, QueuedTask<PredictionOutcome | null>>();
  readonly #latestSeq = new Map<string, number>();
  #lastStatus: InferenceStatusMetadata = { status: "idle" };
  #statusRevision = 0;
  #lastRequestIdentity: { readonly requestId: string; readonly seq: number } | null = null;
  #closed = false;

  constructor(options: InferenceServiceOptions) {
    this.#local = options.local;
    this.#cloud = options.cloud ?? new CloudBackend();
    this.#cache = options.cache ?? new PredictionCache();
    this.#sleep = options.sleep ?? defaultSleep;
    this.#monotonic = options.monotonic ?? defaultMonotonic;
  }

  get cacheEntries(): number {
    return this.#cache.size;
  }

  get statusRevision(): number {
    return this.#statusRevision;
  }

  statusSince(revision: number): InferenceStatusMetadata {
    return this.#statusRevision > revision ? { ...this.#lastStatus } : { status: "idle" };
  }

  /** predict 走延迟路径，其余 kind 与「未启用」直接同步回答。 */
  async submit(request: RequestEnvelope, settings: Settings): Promise<DispatchReply> {
    if (request.kind !== "predict" || !settings.enabled) {
      return { kind: "immediate", payload: await this.dispatch(request, settings) };
    }
    const decision = decisionInputFromPayload(request.payload);
    if (!decision.ok) {
      return { kind: "immediate", payload: predictionWire(failedOutcome(decision.error)) };
    }
    if (this.#closed) {
      return { kind: "immediate", payload: predictionWire(failedOutcome("sidecar_stopping")) };
    }
    const previous = this.#queued.get(request.engineId);
    if (previous !== undefined && !previous.settled) previous.cancel();
    this.#latestSeq.set(request.engineId, request.seq);
    for (const [engine, task] of this.#queued) {
      if (task.settled) this.#queued.delete(engine);
    }
    if (this.#queued.size >= MAX_QUEUED_PREDICTIONS && !this.#queued.has(request.engineId)) {
      return { kind: "immediate", payload: predictionWire(failedOutcome("prediction_busy")) };
    }
    // 复用停手延迟：等待期间若又来了一次预测，这一条会被下面的 seq 校验丢掉。
    const notBefore = this.#monotonic() + settings.localWaitMs / 1000;
    const engineId = request.engineId;
    const seq = request.seq;
    const task = this.#queue.run<PredictionOutcome | null>(async () => {
      await this.#sleep(Math.max(0, notBefore - this.#monotonic()));
      if (this.#closed || this.#latestSeq.get(engineId) !== seq) return null;
      const outcome = await this.#predict(decision.value, settings, request);
      if (this.#closed || this.#latestSeq.get(engineId) !== seq) return null;
      return outcome;
    });
    this.#queued.set(engineId, task);
    return {
      kind: "deferred",
      initial: predictionWire(pendingOutcome()),
      settings,
      completion: task.result.then((outcome) => (outcome === null ? null : predictionWire(outcome))),
    };
  }

  /** 旧 `__call__`：同步路径的完整分发。 */
  async dispatch(request: RequestEnvelope, settings: Settings): Promise<JsonObject> {
    if (request.kind === "health") return healthWire(await this.health(settings));
    if (request.kind === "settings") return settingsActionWire(await this.settingsAction(request.payload, settings));
    if (request.kind !== "predict") return predictionWire(failedOutcome("invalid_request"));
    const decision = decisionInputFromPayload(request.payload);
    if (!decision.ok) return predictionWire(failedOutcome(decision.error));
    if (this.#closed) return predictionWire(failedOutcome("sidecar_stopping"));
    this.#latestSeq.set(request.engineId, request.seq);
    if (!settings.enabled) return predictionWire(failedLocalOutcome("disabled"));
    return predictionWire(await this.#predict(decision.value, settings, request));
  }

  /** 通道选择：云端开关打开且配置在场 → 云端；其余一律本地（含兼容端点）。 */
  #activeCloud(settings: Settings): CloudChannel | null {
    return settings.cloudEnabled && settings.cloud !== null ? settings.cloud : null;
  }

  async #predict(decision: DecisionInput, settings: Settings, request: RequestEnvelope): Promise<PredictionOutcome> {
    const cloud = this.#activeCloud(settings);
    return cloud === null
      ? await this.#localPredict(decision, settings, request)
      : await this.#cloudPredict(decision, cloud, request);
  }

  /** 本地身份解析：Ollama 缺省端点走 digest 复核；改写的兼容端点是纯计算（无需出网）。 */
  async #resolveLocalIdentity(settings: Settings): Promise<Result<string, LocalBackendErrorCode>> {
    if (settings.localBaseUrl !== DEFAULT_LOCAL_BASE_URL) {
      return ok(cloudIdentityFor("local-compat", settings.localBaseUrl, settings.localModel));
    }
    const resolved = await this.#local.resolveModel(settings.localModel);
    if (!resolved.ok) return err(resolved.error);
    return ok(resolved.value.identity);
  }

  async #localPredict(decision: DecisionInput, settings: Settings, request: RequestEnvelope): Promise<PredictionOutcome> {
    const startedAt = this.#monotonic();
    const identity = await this.#resolveLocalIdentity(settings);
    if (!identity.ok) {
      return this.#recordStatus(failedLocalOutcome(identity.error), request, startedAt);
    }
    const id = identity.value;
    if (!isEligibleIdentity(id)) {
      return this.#recordStatus(
        { kind: "unavailable", errorCode: "identity_not_validated", backend: "local", modelIdentity: id, ineligible: true },
        request,
        startedAt,
      );
    }
    const provider = settings.localBaseUrl === DEFAULT_LOCAL_BASE_URL ? "ollama" : "local-compat";
    const cached = this.#local.isRouter(settings.localModel)
      ? null
      : this.#cache.get(decision, { backend: "local", provider, modelIdentity: id });
    if (cached !== null && cached.kind === "ok") {
      const hit = applyValidation({ ...cached, cacheHit: true }, id);
      this.#recordStatus(hit, request, startedAt);
      return hit;
    }
    const result = await this.#local.infer(decision, settings, { modelIdentity: id });
    if (result.kind !== "ok") {
      const outcome: PredictionOutcome = { kind: "unavailable", errorCode: result.errorCode };
      this.#recordStatus(outcome, request, startedAt);
      return outcome;
    }
    const actualIdentity = result.modelIdentity;
    const ok: PredictionOk = {
      ...result,
      cacheHit: false,
      calibrated: false,
      validated: false,
      eligible: false,
      humanReview: VALIDATION.human_review,
    };
    this.#cache.put(decision, { backend: "local", provider: result.provider, modelIdentity: actualIdentity }, ok);
    const outcome = applyValidation(ok, actualIdentity);
    this.#recordStatus(outcome, request, startedAt);
    return outcome;
  }

  /**
   * 云端预测：与本地同一套身份 → 缓存 → 推理 → 验收流水线。
   *
   * 缓存身份 `{backend: "cloud", provider: kind, modelIdentity}` 与本地天然隔离——
   * 「跨通道/跨模型的旧结果一律不显示」由缓存键 + settingsChanged + seq 作废共同保证。
   */
  async #cloudPredict(decision: DecisionInput, cloud: CloudChannel, request: RequestEnvelope): Promise<PredictionOutcome> {
    const startedAt = this.#monotonic();
    const identity = this.#cloud.resolveIdentity(cloud);
    if (!identity.ok) {
      return this.#recordStatus(failedCloudOutcome(identity.error), request, startedAt);
    }
    const id = identity.value;
    if (!isEligibleIdentity(id)) {
      return this.#recordStatus(
        { kind: "unavailable", errorCode: "identity_not_validated", backend: "cloud", modelIdentity: id, ineligible: true },
        request,
        startedAt,
      );
    }
    const cacheIdentity = { backend: "cloud", provider: cloud.kind, modelIdentity: id };
    const cached = this.#cache.get(decision, cacheIdentity);
    if (cached !== null && cached.kind === "ok") {
      const hit = applyValidation({ ...cached, cacheHit: true }, id);
      this.#recordStatus(hit, request, startedAt);
      return hit;
    }
    const result = await this.#cloud.infer(decision, cloud);
    if (result.kind !== "ok") {
      const outcome: PredictionOutcome = { kind: "unavailable", errorCode: result.errorCode, backend: "cloud" };
      this.#recordStatus(outcome, request, startedAt);
      return outcome;
    }
    const ok: PredictionOk = {
      ...result,
      cacheHit: false,
      calibrated: false,
      validated: false,
      eligible: false,
      humanReview: VALIDATION.human_review,
    };
    this.#cache.put(decision, cacheIdentity, ok);
    const outcome = applyValidation(ok, result.modelIdentity);
    this.#recordStatus(outcome, request, startedAt);
    return outcome;
  }

  async health(settings: Settings): Promise<HealthReport> {
    // 状态查询绝不启动 Ollama：启动只由真实预测或设置页按钮触发。
    const cloud = this.#activeCloud(settings);
    return {
      status: "ready",
      backend: cloud === null ? settings.backend : "cloud",
      connection: cloud === null ? await this.#local.testConnection() : await this.#cloud.testConnection(cloud),
      selectedModel: await this.modelStatus(settings.localModel),
      cacheEntries: this.#cache.size,
      lastInference: { ...this.#lastStatus },
    };
  }

  async modelStatus(model: unknown): Promise<ModelStatus> {
    return describeModel(model, await this.#local.modelInventory({ startServer: false }));
  }

  async settingsAction(payload: JsonObject, settings: Settings): Promise<SettingsActionReply> {
    if (settings.backend !== "local" || settings.provider !== null) {
      return { kind: "unavailable", errorCode: "local_only" };
    }
    switch (payload["action"]) {
      case "cancel_prediction": {
        const engine = payload["engine_id"];
        const seq = payload["seq"];
        if (typeof engine !== "string" || !ENGINE_ID_PATTERN.test(engine)) {
          return { kind: "unavailable", errorCode: "invalid_request" };
        }
        if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
          return { kind: "unavailable", errorCode: "invalid_request" };
        }
        if (this.#latestSeq.get(engine) === seq) {
          this.#latestSeq.delete(engine);
          const pending = this.#queued.get(engine);
          if (pending !== undefined && !pending.settled) pending.cancel();
          this.#queued.delete(engine);
        }
        return { kind: "ok" };
      }
      case "selection": {
        const requestId = payload["prediction_request_id"];
        const seq = payload["prediction_seq"];
        const adopted = payload["adopted"];
        if (typeof requestId !== "string" || !HEX_32.test(requestId) || typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
          return { kind: "unavailable", errorCode: "invalid_selection_event" };
        }
        if (typeof adopted !== "boolean") {
          return { kind: "unavailable", errorCode: "invalid_selection_event" };
        }
        const last = this.#lastRequestIdentity;
        if (last === null || last.requestId !== requestId || last.seq !== seq) {
          return { kind: "ignored" };
        }
        this.#lastStatus = { ...this.#lastStatus, status: "selected", adopted };
        this.#statusRevision += 1;
        return { kind: "ok" };
      }
      case "clear_cache":
        this.#cache.clear();
        return { kind: "cache-cleared", cacheEntries: this.#cache.size };
      case "models":
        return { kind: "inventory", local: await this.#local.modelInventory({ startServer: false }) };
      case "pull_model":
        return { kind: "pull", pull: await this.#local.startModelPull(payload["model"]) };
      case "pull_status":
        return { kind: "pull", pull: this.#local.modelPullStatus() };
      case "cancel_pull":
        return { kind: "pull", pull: await this.#local.cancelModelPull() };
      case "model_status": {
        const requested = "model" in payload ? payload["model"] : settings.localModel;
        return { kind: "model-status", status: await this.modelStatus(requested) };
      }
      case "status":
        return { kind: "health", report: await this.health(settings) };
      case "test_connection": {
        const cloud = this.#activeCloud(settings);
        return {
          kind: "connection",
          connection: cloud === null ? await this.#local.testConnection() : await this.#cloud.testConnection(cloud),
        };
      }
      default:
        return { kind: "unavailable", errorCode: "invalid_request" };
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#queue.cancelPending();
    await this.#queue.drain();
    await this.#local.close();
  }

  /**
   * 记下「最近一次预测」。
   *
   * 只保留 allow-list 里的键：候选、拼音、上文和模型原文永远进不了日志与状态文件。
   */
  #recordStatus<T extends PredictionOutcome>(outcome: T, request: RequestEnvelope, startedAt: number): T {
    const value = predictionWire(outcome);
    const draft: InferenceStatusMetadataDraft = { status: "unknown" };
    for (const key of STATUS_METADATA_KEYS) {
      const entry: JsonValue | undefined = value[key];
      if (entry === undefined) continue;
      assignMetadata(draft, key, entry);
    }
    draft.duration_ms = Math.round(Math.max(0, this.#monotonic() - startedAt) * 1000 * 100) / 100;
    if (this.#latestSeq.get(request.engineId) === request.seq) {
      this.#lastStatus = draft;
      this.#statusRevision += 1;
      this.#lastRequestIdentity = { requestId: request.requestId, seq: request.seq };
    }
    return outcome;
  }
}

/** 旧实现照抄值，这里按声明类型挑一次，等于把「脏数据进不了状态」写进代码。 */
function assignMetadata(draft: InferenceStatusMetadataDraft, key: string, entry: JsonValue): void {
  switch (key) {
    case "status":
      if (typeof entry === "string") draft.status = entry;
      return;
    case "backend":
    case "provider":
    case "model":
    case "model_identity":
    case "error_code":
      if (typeof entry === "string") draft[key] = entry;
      return;
    case "cache_hit":
    case "calibrated":
    case "eligible":
    case "adopted":
      if (typeof entry === "boolean") draft[key] = entry;
      return;
    default:
      return;
  }
}

/** `_apply_validation`：把「是否有资格」的判定集中在一处，成功路径都要过它。 */
function applyValidation(outcome: PredictionOk, identity: string): PredictionOk {
  const validated = isEligibleIdentity(identity);
  return {
    ...outcome,
    modelIdentity: identity,
    calibrated: false,
    validated,
    eligible: validated,
    humanReview: VALIDATION.human_review,
  };
}

export { CancelledTask };
