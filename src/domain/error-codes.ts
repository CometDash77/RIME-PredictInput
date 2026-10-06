/**
 * Closed sets of codes that may appear on the wire.
 *
 * Provider bodies, exception text and user content must never reach a log line,
 * a status file or an HTTP response; the legacy code enforced that with
 * allow-lists in three different places. Here the allow-lists are part of the
 * type system and the reason they exist is written down once.
 */

export type DecisionInputErrorCode =
  | "invalid_prediction_payload"
  | "invalid_state"
  | "invalid_candidates"
  | "invalid_candidate_fields";

export type SettingsErrorCode =
  | "settings must be a JSON object"
  | "settings contain unsupported fields"
  | "enabled must be a boolean"
  | "local_only"
  | "local_model is invalid"
  | "slot must be a positive integer"
  | "local_wait_ms must be between 1 and 200"
  | "log_mode must be off or metadata"
  | "thresholds must be a small object"
  | "threshold identity is invalid"
  | "threshold must be a finite number between zero and one"
  | "secrets are not supported in local settings"
  | "settings file is too large";

/**
 * Only `SettingsStore` produces these. `settings file is unreadable` covers the
 * decode/parse failures the legacy code left unhandled; the other two describe
 * the atomic-write paths (hard link when the caller asked not to overwrite).
 */
export type SettingsStoreErrorCode =
  | "settings file is unreadable"
  | "settings_already_exists"
  | "settings_unwritable";

export type TransportFailureCode = "timeout" | "network_unavailable" | "response_too_large";

export type HttpFailureCode =
  | "unauthorized"
  | "payment_required"
  | "forbidden"
  | "model_unavailable"
  | "invalid_request"
  | "rate_limited"
  | "provider_overloaded"
  | "redirect_refused"
  | "provider_unavailable"
  | "provider_rejected"
  | "provider_error";

export type LocalBackendErrorCode =
  | TransportFailureCode
  | HttpFailureCode
  | "ollama_missing"
  | "ollama_start_failed"
  | "local_unavailable"
  | "local_auth_required"
  | "model_missing"
  | "model_version_unavailable"
  | "model_store_unavailable"
  | "model_ownership_unavailable"
  | "invalid_model_response"
  | "invalid_model_list"
  | "invalid_model_name"
  | "pull_in_progress"
  | "pull_start_failed"
  | "pull_failed"
  | "pull_cancel_failed";

export type DispatchErrorCode =
  | DecisionInputErrorCode
  | LocalBackendErrorCode
  | "local_only"
  | "identity_not_validated"
  | "disabled"
  | "sidecar_stopping"
  | "prediction_busy"
  | "backend_not_ready"
  | "invalid_request"
  | "handler_failed"
  | "invalid_handler_result"
  | "publish_failed"
  | "settings_changed"
  | "invalid_selection_event";

export type ProtocolErrorCode =
  | "request is too large"
  | "request is incomplete or invalid"
  | "unsupported request envelope"
  | "invalid engine id"
  | "invalid request sequence"
  | "invalid request id"
  | "invalid request kind"
  | "invalid request timestamp"
  | "request payload must be an object"
  | "message is not valid JSON"
  | "message is too large"
  | "secrets are not allowed in IPC";

/** `runtime._write_status` and `MetadataLogger` only accept short metadata codes. */
export const SAFE_METADATA_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

export function isSafeMetadataCode(value: string): boolean {
  return SAFE_METADATA_CODE.test(value);
}
