/**
 * 请求泵与后端之间的 dispatch 契约。
 *
 * 旧实现让 dispatch 直接返回字典或 `DeferredResponse`；这里把「立即应答」和
 * 「先应答 pending、稍后再应答一次」写成判别联合，让 runtime 与后端各自只处理
 * 自己那一半。
 */
import type { RequestEnvelope } from "../contracts/envelope.js";
import type { Settings } from "../domain/settings.js";
import type { JsonObject } from "../json/guards.js";

export interface ImmediateReply {
  readonly kind: "immediate";
  readonly payload: JsonObject;
}

export interface DeferredReply {
  readonly kind: "deferred";
  readonly initial: JsonObject;
  readonly settings: Settings;
  readonly completion: Promise<JsonObject | null>;
}

export type DispatchReply = ImmediateReply | DeferredReply;

export type Dispatch = (request: RequestEnvelope, settings: Settings) => Promise<DispatchReply>;

/** 后端尚未注册时的兜底回答，对齐旧实现的 `unavailable_dispatch`。 */
export const unavailableDispatch: Dispatch = () =>
  Promise.resolve({
    kind: "immediate",
    payload: { status: "unavailable", error_code: "backend_not_ready" },
  });
