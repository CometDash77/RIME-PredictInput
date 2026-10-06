import type { InferenceStatusMetadata } from "../domain/status.js";
import type { JsonObject } from "../json/guards.js";
import { connectionWire } from "../providers/wire.js";
import type { ConnectionStatus } from "../providers/ollama.js";
import { modelStatusWire, type ModelStatus } from "./model-status.js";

/** `InferenceService.health`：设置页的「总览」卡片读这一份。 */
export interface HealthReport {
  readonly status: "ready";
  readonly backend: string;
  readonly connection: ConnectionStatus;
  readonly selectedModel: ModelStatus;
  readonly cacheEntries: number;
  readonly lastInference: InferenceStatusMetadata;
}

export function healthWire(report: HealthReport): JsonObject {
  return {
    status: report.status,
    backend: report.backend,
    local: connectionWire(report.connection),
    selected_model: modelStatusWire(report.selectedModel),
    cache_entries: report.cacheEntries,
    last_inference: report.lastInference,
  };
}
