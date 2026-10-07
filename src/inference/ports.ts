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

/**
 * 云端通道端口（spec #10 双通道）：与本地端口承担同一推理语义的云端半边。
 * `resolveIdentity` 是纯计算（通道+端点+模型+冻结策略的联合摘要），不需要网络。
 */
export type { CloudChannelPort } from "../providers/cloud.js";
