/**
 * 云端通道适配器：四种形态，一个推理端口。
 *
 * 这个类只做一件事：把「用户选中了一个候选」的决策输入翻译成对所选云端通道的
 * 一次调用，并把结果压成与本地 LocalBackend 同构的封闭成功/失败判别联合。
 * 决策输入、答案契约、错误分类全部复用本地路径的同一套构件——
 * 「同一推理端口」不是注释，是代码结构本身。
 *
 * 凭据纪律（spec #10）：api_key 只进入请求头；响应体、异常文本绝不进错误码
 * （safeHttpError 固定枚举），也绝不落日志——本类不持有任何可写日志的依赖。
 */

import type { CloudChannel, CloudKind } from "../domain/settings.js";
import type { TransportFailureCode, HttpFailureCode } from "../domain/error-codes.js";
import type { DecisionInput } from "../domain/decision.js";
import { compact } from "../json/canonical.js";
import { err, ok, type Result } from "../domain/result.js";
import { cloudIdentityFor } from "../contracts/policy.js";
import { FetchTransport, decodeJsonBody, safeHttpError, type HttpTransportLike } from "./http.js";
import type { ConnectionStatus } from "./ollama.js";
import {
  ANTHROPIC_ENDPOINT,
  OPENAI_CHAT_ENDPOINT,
  OPENAI_RESPONSES_ENDPOINT,
  anthropicRequest,
  chatCompletionsRequest,
  connectionProbeRequest,
  parseAnthropicAnswer,
  parseChatCompletionsAnswer,
  parseResponsesAnswer,
  responsesRequest,
  type PreparedRequest,
} from "../contracts/cloud-wire.js";

export type CloudBackendErrorCode =
  | TransportFailureCode
  | HttpFailureCode
  | "invalid_model_response"
  | "invalid_request";

export type CloudInferenceOutcome =
  | {
      readonly kind: "ok";
      readonly backend: "cloud";
      readonly provider: CloudKind;
      readonly model: string;
      readonly choice: string;
      readonly requestedModel: string;
      readonly modelIdentity: string;
    }
  | { readonly kind: "unavailable"; readonly errorCode: CloudBackendErrorCode };

export interface CloudChannelPort {
  resolveIdentity(cloud: CloudChannel): Result<string, CloudBackendErrorCode>;
  infer(decision: DecisionInput, cloud: CloudChannel): Promise<CloudInferenceOutcome>;
  testConnection(cloud: CloudChannel): Promise<ConnectionStatus>;
  close(): Promise<void>;
}

export interface CloudBackendOptions {
  readonly transport?: HttpTransportLike;
  readonly inferenceTimeout?: number;
  readonly connectionTimeout?: number;
}

interface PreparedCall extends PreparedRequest {
  parse(body: unknown, candidateCount: number): Result<string, "invalid_model_response">;
}

function channelEndpoint(cloud: CloudChannel): string | null {
  switch (cloud.kind) {
    case "openai-responses":
      return OPENAI_RESPONSES_ENDPOINT;
    case "openai-chat":
      return OPENAI_CHAT_ENDPOINT;
    case "anthropic":
      return ANTHROPIC_ENDPOINT;
    case "custom":
      return cloud.baseUrl;
  }
}

export class CloudBackend implements CloudChannelPort {
  readonly #transport: HttpTransportLike;
  readonly #inferenceTimeout: number;
  readonly #connectionTimeout: number;

  constructor(options: CloudBackendOptions = {}) {
    this.#transport = options.transport ?? new FetchTransport();
    this.#inferenceTimeout = options.inferenceTimeout ?? 30;
    this.#connectionTimeout = options.connectionTimeout ?? 3;
  }

  /** 纯计算：通道 + 端点 + 模型 + 冻结策略的联合摘要。凭据不参与。 */
  resolveIdentity(cloud: CloudChannel): Result<string, CloudBackendErrorCode> {
    const endpoint = channelEndpoint(cloud);
    if (endpoint === null) return err("invalid_request");
    return ok(cloudIdentityFor(cloud.kind, endpoint, cloud.model));
  }

  #prepare(cloud: CloudChannel, decision: DecisionInput): Result<PreparedCall, CloudBackendErrorCode> {
    switch (cloud.kind) {
      case "openai-chat":
        return ok({
          ...chatCompletionsRequest({
            endpoint: OPENAI_CHAT_ENDPOINT,
            model: cloud.model,
            apiKey: cloud.apiKey,
            decision,
            strictFormat: true,
          }),
          parse: parseChatCompletionsAnswer,
        });
      case "custom": {
        if (cloud.baseUrl === null) return err("invalid_request");
        return ok({
          ...chatCompletionsRequest({
            endpoint: cloud.baseUrl,
            model: cloud.model,
            apiKey: cloud.apiKey,
            decision,
            strictFormat: false,
          }),
          parse: parseChatCompletionsAnswer,
        });
      }
      case "openai-responses":
        return ok({
          ...responsesRequest({ endpoint: OPENAI_RESPONSES_ENDPOINT, model: cloud.model, apiKey: cloud.apiKey, decision }),
          parse: parseResponsesAnswer,
        });
      case "anthropic":
        return ok({
          ...anthropicRequest({ model: cloud.model, apiKey: cloud.apiKey, decision }),
          parse: parseAnthropicAnswer,
        });
    }
  }

  async infer(decision: DecisionInput, cloud: CloudChannel): Promise<CloudInferenceOutcome> {
    const identity = this.resolveIdentity(cloud);
    if (!identity.ok) return { kind: "unavailable", errorCode: identity.error };
    const prepared = this.#prepare(cloud, decision);
    if (!prepared.ok) return { kind: "unavailable", errorCode: prepared.error };
    try {
      const response = await this.#transport.request("POST", prepared.value.url, {
        headers: prepared.value.headers,
        body: Buffer.from(compact(prepared.value.body), "utf8"),
        timeoutSeconds: this.#inferenceTimeout,
      });
      if (!response.ok) return { kind: "unavailable", errorCode: response.error };
      if (response.value.status !== 200) {
        return { kind: "unavailable", errorCode: safeHttpError(response.value.status) };
      }
      const decoded = decodeJsonBody(response.value.body);
      if (!decoded.ok) return { kind: "unavailable", errorCode: "invalid_model_response" };
      const answer = prepared.value.parse(decoded.value, decision.candidates.length);
      if (!answer.ok) return { kind: "unavailable", errorCode: "invalid_model_response" };
      return {
        kind: "ok",
        backend: "cloud",
        provider: cloud.kind,
        model: cloud.model,
        choice: answer.value,
        requestedModel: cloud.model,
        modelIdentity: identity.value,
      };
    } catch {
      return { kind: "unavailable", errorCode: "invalid_model_response" };
    }
  }

  async testConnection(cloud: CloudChannel): Promise<ConnectionStatus> {
    const endpoint = channelEndpoint(cloud);
    if (endpoint === null) return { status: "unavailable", errorCode: "invalid_request" };
    const probe = connectionProbeRequest({
      endpoint,
      apiKey: cloud.apiKey,
      anthropic: cloud.kind === "anthropic",
    });
    try {
      const response = await this.#transport.request("GET", probe.url, {
        headers: probe.headers,
        timeoutSeconds: this.#connectionTimeout,
      });
      if (!response.ok) return { status: "unavailable", errorCode: response.error };
      if (response.value.status === 200) {
        return { status: "connected", provider: "cloud", version: cloud.kind };
      }
      return { status: "unavailable", errorCode: safeHttpError(response.value.status) };
    } catch {
      return { status: "unavailable", errorCode: "network_unavailable" };
    }
  }

  /** 无自有子进程与常驻状态；接口对称保留。 */
  async close(): Promise<void> {}
}
