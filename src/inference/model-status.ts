import { FAILED_SCREENINGS, VALIDATION, identityFor, isValidatedIdentity, type ValidationEvidence } from "../contracts/policy.js";
import { MODEL_DIGEST } from "../domain/model.js";
import { MODEL_NAME_PATTERN } from "../domain/settings.js";
import type { DispatchErrorCode } from "../domain/error-codes.js";
import { HEX_64 } from "../json/digest.js";
import type { JsonObject } from "../json/guards.js";
import type { ModelInventory } from "../providers/ollama.js";

export const UNVERIFIED_SOURCE = "尚无此模型的中文选词专项训练证明。";
export const UNVERIFIED_QUALITY = "当前固定策略尚未独立验收。";
export const UNCENSORED_SOURCE =
  "HauhauCS Qwen3.5-2B Uncensored Aggressive；作者声明uncensored，未证明中文选词专项微调。";
export const ACCEPTED_QUALITY =
  "固定中文提示词与300字上文独立筛选：105/120，首选102/120，纠正3、改错0；人工试用待完成。";

/** 设置页「模型身份」卡片要显示的全部内容。 */
export interface DescribedModel {
  readonly kind: "described";
  readonly model: string;
  readonly status: "unverified" | "accepted" | "failed" | "not_installed";
  readonly eligible: boolean;
  readonly thinking: false;
  readonly source: string;
  readonly quality: string;
  readonly errorCode?: DispatchErrorCode;
  readonly digest?: string;
  readonly modelIdentity?: string;
  readonly validation?: ValidationEvidence;
}

export interface InvalidModelName {
  readonly kind: "invalid-name";
  readonly errorCode: "invalid_model_name";
}

export type ModelStatus = DescribedModel | InvalidModelName;

/**
 * `InferenceService.model_status`：纯函数，输入清单、输出卡片内容。
 *
 * 旧实现里有 6 条互相覆盖的分支（未验收、未安装、摘要不可用、固定模型、验收通过、
 * 曾经筛选失败），这里全部保留，只是把「清单从哪来」交给调用方，等于把副作用的
 * 边界推到 service。
 */
export function describeModel(model: unknown, inventory: ModelInventory): ModelStatus {
  if (typeof model !== "string" || !MODEL_NAME_PATTERN.test(model)) {
    return { kind: "invalid-name", errorCode: "invalid_model_name" };
  }
  const base: Omit<DescribedModel, "kind"> = {
    model,
    status: "unverified",
    eligible: false,
    thinking: false,
    source: UNVERIFIED_SOURCE,
    quality: UNVERIFIED_QUALITY,
  };
  if (inventory.status !== "available") {
    return { ...base, kind: "described", errorCode: inventory.errorCode };
  }
  const installed = inventory.models.find((entry) => entry.name === model);
  if (installed === undefined) {
    return { ...base, kind: "described", status: "not_installed", errorCode: "model_missing" };
  }
  if (!HEX_64.test(installed.digest)) {
    return { ...base, kind: "described", errorCode: "model_version_unavailable" };
  }
  const digest = installed.digest;
  const identity = identityFor(digest);
  const described: DescribedModel = {
    ...base,
    kind: "described",
    digest,
    modelIdentity: identity,
    source: digest === MODEL_DIGEST ? UNCENSORED_SOURCE : UNVERIFIED_SOURCE,
  };
  if (isValidatedIdentity(identity)) {
    return { ...described, status: "accepted", eligible: true, validation: VALIDATION, quality: ACCEPTED_QUALITY };
  }
  const screening = FAILED_SCREENINGS[digest];
  if (screening !== undefined) {
    return { ...described, status: "failed", quality: screening };
  }
  return described;
}

export function modelStatusWire(status: ModelStatus): JsonObject {
  if (status.kind === "invalid-name") {
    return { status: "unavailable", error_code: status.errorCode, eligible: false };
  }
  return {
    model: status.model,
    status: status.status,
    eligible: status.eligible,
    thinking: status.thinking,
    source: status.source,
    quality: status.quality,
    ...(status.errorCode === undefined ? {} : { error_code: status.errorCode }),
    ...(status.digest === undefined ? {} : { digest: status.digest }),
    ...(status.modelIdentity === undefined ? {} : { model_identity: status.modelIdentity }),
    ...(status.validation === undefined ? {} : { validation: status.validation }),
  };
}
