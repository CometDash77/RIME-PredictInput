import type { JsonObject } from "../json/guards.js";
import type { ConnectionStatus, ModelEntry, ModelInventory, PullStatus } from "./ollama.js";

/** 模型清单的线上形态：`providers.LocalBackend.model_inventory` 的返回形状。 */
export function inventoryWire(inventory: ModelInventory): JsonObject {
  if (inventory.status === "available") {
    return {
      status: "available",
      ...(inventory.source === undefined ? {} : { source: inventory.source }),
      models: inventory.models.map(modelEntryWire),
    };
  }
  return { status: "unavailable", error_code: inventory.errorCode, models: [] };
}

export function modelEntryWire(entry: ModelEntry): JsonObject {
  return { name: entry.name, digest: entry.digest, format: entry.format };
}

/** `providers.LocalBackend.test_connection` 的返回形状。 */
export function connectionWire(connection: ConnectionStatus): JsonObject {
  if (connection.status === "connected") {
    return { status: "connected", provider: connection.provider, version: connection.version };
  }
  return { status: "unavailable", error_code: connection.errorCode };
}

/** `providers.LocalBackend.model_pull_status` 的返回形状（含两处字段顺序差异，照抄）。 */
export function pullStatusWire(pull: PullStatus): JsonObject {
  switch (pull.status) {
    case "idle":
      return { status: "idle" };
    case "pulling":
      return pull.model === null ? { status: "pulling" } : { status: "pulling", model: pull.model };
    case "installed":
      return { status: "installed", model: pull.model };
    case "cancelled":
      return { status: "cancelled", model: pull.model };
    case "unavailable":
      if (pull.model === undefined) return { status: "unavailable", error_code: pull.errorCode };
      if (pull.errorCode === "pull_cancel_failed") {
        return { status: "unavailable", error_code: pull.errorCode, model: pull.model };
      }
      return { status: "unavailable", model: pull.model, error_code: pull.errorCode };
  }
}
