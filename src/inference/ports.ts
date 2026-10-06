import type { LocalBackend } from "../providers/ollama.js";

/**
 * `InferenceService` 依赖的本机后端接口。
 *
 * 用 `Pick` 而不是新写一份 interface：真实实现升级签名时编译器会立刻指出端口漂移，
 * 测试里的假后端也必须满足同一组签名。
 */
export type LocalBackendPort = Pick<
  LocalBackend,
  | "resolveModel"
  | "isRouter"
  | "infer"
  | "testConnection"
  | "modelInventory"
  | "startModelPull"
  | "modelPullStatus"
  | "cancelModelPull"
  | "close"
>;
