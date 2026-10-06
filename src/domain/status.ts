import type { DispatchErrorCode } from "./error-codes.js";

/** `runtime._write_status` accepts exactly these five states. */
export type SidecarState = "starting" | "ready" | "busy" | "stopped" | "error";

export type StatusFile = {
  readonly state: SidecarState;
  readonly pid: number;
  readonly updated_at: number;
  readonly error_code?: string;
};

export function normalizeSidecarState(state: string): SidecarState {
  switch (state) {
    case "starting":
    case "ready":
    case "busy":
    case "stopped":
      return state;
    default:
      return "error";
  }
}

/**
 * The subset of a result that may be shown in the settings page or written to a
 * diagnostic line. Everything else — candidates, pinyin, preceding text, model
 * answers — is deliberately unrepresentable here.
 */
export type InferenceStatusMetadata = {
  readonly status: string;
  readonly backend?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly model_identity?: string;
  readonly error_code?: string;
  readonly cache_hit?: boolean;
  readonly calibrated?: boolean;
  readonly eligible?: boolean;
  readonly adopted?: boolean;
  readonly duration_ms?: number;
};

/**
 * `_record_status` 边挑边写，因此需要一个可变的同形副本。
 *
 * `StatusFile` 与 `InferenceStatusMetadata` 写成 type 而不是 interface，是为了拿到
 * TypeScript 给对象字面量类型的隐式索引签名，能直接当 JSON 值发出去。
 */
export type InferenceStatusMetadataDraft = { -readonly [K in keyof InferenceStatusMetadata]: InferenceStatusMetadata[K] };

export const STATUS_METADATA_KEYS = [
  "status",
  "backend",
  "provider",
  "model",
  "model_identity",
  "error_code",
  "cache_hit",
  "calibrated",
  "eligible",
  "adopted",
] as const;

export type DispatchStatus = "ok" | "pending" | "unavailable" | "error" | "ready";

export interface DispatchResult {
  readonly status: DispatchStatus;
  readonly error_code?: DispatchErrorCode;
  readonly [key: string]: unknown;
}
