import type { DispatchErrorCode } from "../domain/error-codes.js";
import type { JsonObject } from "../json/guards.js";

/**
 * 本机预测的三种结果，正好对应线上 payload 的 `status`。
 *
 * Lua 滤镜只认三种情况：`pending` 继续等，`ok` 且 `eligible === true` 才允许插入
 * 模型候选，其余一律留空。把它们写成判别联合，是为了让「成功但没有资格」这种旧实现
 * 里真实存在过的状态无法被表达出来。
 */
export interface PredictionOk {
  readonly kind: "ok";
  readonly backend: "local";
  readonly provider: "ollama";
  readonly model: string;
  readonly choice: string;
  readonly requestedModel: string;
  readonly modelIdentity: string;
  readonly cacheHit: boolean;
  readonly calibrated: false;
  readonly validated: boolean;
  readonly eligible: boolean;
  readonly humanReview: string;
}

/**
 * 失败结果。
 *
 * `backend` 只在「设置或解析」路径上由 `_local_predict` 自己写，而把后端返回值原样透出
 * 时不写；`modelIdentity` 与 `eligible`/`calibrated` 只出现在身份未验收那一支。差异很小但
 * 设置页会显示，所以照抄而不是统一。
 */
export interface PredictionUnavailable {
  readonly kind: "unavailable";
  readonly errorCode: DispatchErrorCode;
  readonly backend?: "local";
  readonly modelIdentity?: string;
  readonly ineligible?: true;
}

export interface PredictionPending {
  readonly kind: "pending";
}

export type PredictionOutcome = PredictionOk | PredictionUnavailable | PredictionPending;

export function pendingOutcome(): PredictionOutcome {
  return { kind: "pending" };
}

export function failedOutcome(errorCode: DispatchErrorCode): PredictionOutcome {
  return { kind: "unavailable", errorCode };
}

export function failedLocalOutcome(errorCode: DispatchErrorCode): PredictionOutcome {
  return { kind: "unavailable", errorCode, backend: "local" };
}

/** 字段顺序与 `providers.infer` / `_apply_validation` 的插入顺序一致。 */
export function predictionWire(outcome: PredictionOutcome): JsonObject {
  switch (outcome.kind) {
    case "pending":
      return { status: "pending" };
    case "ok":
      return {
        status: "ok",
        backend: outcome.backend,
        provider: outcome.provider,
        model: outcome.model,
        choice: outcome.choice,
        requested_model: outcome.requestedModel,
        model_identity: outcome.modelIdentity,
        cache_hit: outcome.cacheHit,
        calibrated: outcome.calibrated,
        validated: outcome.validated,
        eligible: outcome.eligible,
        human_review: outcome.humanReview,
      };
    case "unavailable":
      return {
        status: "unavailable",
        ...(outcome.backend === undefined ? {} : { backend: outcome.backend }),
        error_code: outcome.errorCode,
        ...(outcome.modelIdentity === undefined ? {} : { model_identity: outcome.modelIdentity }),
        ...(outcome.ineligible === undefined ? {} : { eligible: false, calibrated: false }),
      };
  }
}
