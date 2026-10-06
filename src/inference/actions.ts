import type { DispatchErrorCode } from "../domain/error-codes.js";
import { connectionWire, inventoryWire, pullStatusWire } from "../providers/wire.js";
import type { ConnectionStatus, ModelInventory, PullStatus } from "../providers/ollama.js";
import type { JsonObject } from "../json/guards.js";
import { healthWire, type HealthReport } from "./health.js";
import { modelStatusWire, type ModelStatus } from "./model-status.js";

/**
 * `InferenceService.settings_action` 的返回值。
 *
 * 旧实现是一个大 if/elif 返回字面量字典；改成判别联合后，设置页能拿到的每一种回包都
 * 在类型里列全了，新增 action 时编译器会逼着补上线上形态。
 */
export type SettingsActionReply =
  | { readonly kind: "ok" }
  | { readonly kind: "ignored" }
  | { readonly kind: "cache-cleared"; readonly cacheEntries: number }
  | { readonly kind: "inventory"; readonly local: ModelInventory }
  | { readonly kind: "pull"; readonly pull: PullStatus }
  | { readonly kind: "connection"; readonly connection: ConnectionStatus }
  | { readonly kind: "model-status"; readonly status: ModelStatus }
  | { readonly kind: "health"; readonly report: HealthReport }
  | { readonly kind: "unavailable"; readonly errorCode: DispatchErrorCode };

export function settingsActionWire(reply: SettingsActionReply): JsonObject {
  switch (reply.kind) {
    case "ok":
      return { status: "ok" };
    case "ignored":
      return { status: "ok", ignored: true };
    case "cache-cleared":
      return { status: "ok", cache_entries: reply.cacheEntries };
    case "inventory":
      return { status: "ok", local: inventoryWire(reply.local) };
    case "pull":
      // 拉取状态本身就是完整回包，没有 status:"ok" 外壳。
      return pullStatusWire(reply.pull);
    case "connection":
      return connectionWire(reply.connection);
    case "model-status":
      return modelStatusWire(reply.status);
    case "health":
      return healthWire(reply.report);
    case "unavailable":
      return { status: "unavailable", error_code: reply.errorCode };
  }
}
