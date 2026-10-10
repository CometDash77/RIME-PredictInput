/**
 * 云端通道的线上契约：请求构造与响应解析，全部是纯函数。
 *
 * 四种通道实现同一决策契约（YG 拍板 ①A）：
 * - 请求侧共用 `decisionQuery` 的同一份字节（本地 Ollama 亦然）——
 *   「决策输入跨通道一致」在 wire 上的体现。
 * - 采样参数映射自冻结的 SAMPLING_OPTIONS（temperature/seed/num_predict）；
 *   num_ctx 与 think 在 OpenAI/Anthropic wire 上无等价物，映射即为策略的全集。
 * - 响应侧强制与本地完全相同的答案契约：strict JSON（拒绝重复键）、恰好一个
 *   `choice` 整数键、1..N 越界即拒。任何不合规 → invalid_model_response → 留空。
 *
 * 端点策略（决策 09）：openai-responses / openai-chat / anthropic 用官方缺省端点
 * （base_url 不可覆盖，凭据只发往固定源）；custom = OpenAI Chat 兼容 wire + 自由
 * 端点，为最大兼容不发 response_format，靠提示词与响应侧契约兜底。
 */

import { z } from "zod";

import { defaultSeparators } from "../json/canonical.js";
import type { JsonObject } from "../json/guards.js";
import { parseStrictObject } from "../json/strict.js";
import { err, ok, type Result } from "../domain/result.js";
import type { DecisionInput } from "../domain/decision.js";
import { SAMPLING_OPTIONS, SYSTEM_PROMPT, decisionQuery } from "./policy.js";

export const OPENAI_CHAT_ENDPOINT = "https://api.openai.com/v1";
export const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1";
export const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1";
export const ANTHROPIC_VERSION = "2023-06-01";

export function stripTrailingSlash(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

/** 供 json_schema 使用的 plain schema：choice 整数，枚举恰好是当前候选页的编号。 */
function choiceJsonSchema(candidateCount: number): JsonObject {
  return {
    type: "object",
    properties: {
      choice: {
        type: "integer",
        enum: Array.from({ length: candidateCount }, (_, index) => index + 1),
      },
    },
    required: ["choice"],
    additionalProperties: false,
  };
}

function userContent(decision: DecisionInput): string {
  return defaultSeparators(decisionQuery(decision));
}

export interface PreparedRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: JsonObject;
}

/** OpenAI Chat Completions（openai-chat 官方端点 / custom 自由端点共用）。 */
export function chatCompletionsRequest(options: {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
  readonly decision: DecisionInput;
  /** 官方端点带 json_schema strict；custom 端点为兼容性省略。 */
  readonly strictFormat: boolean;
}): PreparedRequest {
  const body: JsonObject = {
    model: options.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent(options.decision) },
    ],
    temperature: SAMPLING_OPTIONS.temperature,
    seed: SAMPLING_OPTIONS.seed,
    max_tokens: SAMPLING_OPTIONS.num_predict,
    ...(options.strictFormat
      ? {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "choice",
              strict: true,
              schema: choiceJsonSchema(options.decision.candidates.length),
            },
          },
        }
      : {}),
  };
  return {
    url: stripTrailingSlash(options.endpoint) + "/chat/completions",
    headers: {
      "Content-Type": "application/json",
      ...(options.apiKey === "" ? {} : { Authorization: `Bearer ${options.apiKey}` }),
    },
    body,
  };
}

/** OpenAI Responses API：系统提示走 instructions，输出用 text.format 约束。 */
export function responsesRequest(options: {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
  readonly decision: DecisionInput;
}): PreparedRequest {
  const body: JsonObject = {
    model: options.model,
    instructions: SYSTEM_PROMPT,
    input: userContent(options.decision),
    max_output_tokens: SAMPLING_OPTIONS.num_predict,
    temperature: SAMPLING_OPTIONS.temperature,
    text: {
      format: {
        type: "json_schema",
        name: "choice",
        strict: true,
        schema: choiceJsonSchema(options.decision.candidates.length),
      },
    },
  };
  return {
    url: stripTrailingSlash(options.endpoint) + "/responses",
    headers: {
      "Content-Type": "application/json",
      ...(options.apiKey === "" ? {} : { Authorization: `Bearer ${options.apiKey}` }),
    },
    body,
  };
}

/** Anthropic Messages API：凭据走 x-api-key，系统提示走 system 字段。 */
export function anthropicRequest(options: {
  readonly model: string;
  readonly apiKey: string;
  readonly decision: DecisionInput;
}): PreparedRequest {
  const body: JsonObject = {
    model: options.model,
    max_tokens: SAMPLING_OPTIONS.num_predict,
    temperature: SAMPLING_OPTIONS.temperature,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent(options.decision) }],
  };
  return {
    url: ANTHROPIC_ENDPOINT + "/messages",
    headers: {
      "Content-Type": "application/json",
      ...(options.apiKey === "" ? {} : { "x-api-key": options.apiKey }),
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body,
  };
}

/**
 * 连接探测：固定走 GET <endpoint>/models（四家都提供、不消耗推理费用）。
 * 200 = connected；401/403 等按 safeHttpError 映射。
 */
export function connectionProbeRequest(options: {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly anthropic: boolean;
}): { readonly url: string; readonly headers: Readonly<Record<string, string>> } {
  return {
    url: stripTrailingSlash(options.endpoint) + "/models",
    headers: {
      "Content-Type": "application/json",
      ...(options.apiKey === "" ? {} : options.anthropic ? { "x-api-key": options.apiKey } : { Authorization: `Bearer ${options.apiKey}` }),
      ...(options.anthropic ? { "anthropic-version": ANTHROPIC_VERSION } : {}),
    },
  };
}

// ---- 响应形状（外部输入；宽松收集，答案契约单独强制） ----

const ChatCompletionsResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string() }),
        finish_reason: z.string(),
      }),
    )
    .min(1),
});

const ResponsesResponseSchema = z.object({
  status: z.string(),
  output: z
    .array(
      z.object({
        type: z.string(),
        content: z
          .array(z.object({ type: z.string(), text: z.string() }))
          .optional(),
      }),
    )
    .min(1),
});

const AnthropicResponseSchema = z.object({
  stop_reason: z.string().nullable(),
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .min(1),
});

export type ModelAnswerError = "invalid_model_response";

/**
 * 答案契约的最终关口：strict JSON（重复键拒绝）、恰好一个 choice 键、
 * 整数且落在 1..N。与本地 Ollama 路径逐字一致。
 */
export function parseChoiceAnswer(text: string, candidateCount: number): Result<string, ModelAnswerError> {
  const answer = parseStrictObject(text);
  if (!answer.ok) return err("invalid_model_response");
  const keys = Object.keys(answer.value);
  if (keys.length !== 1 || keys[0] !== "choice") return err("invalid_model_response");
  const choice = answer.value["choice"];
  if (typeof choice !== "number" || !Number.isInteger(choice)) return err("invalid_model_response");
  if (choice < 1 || choice > candidateCount) return err("invalid_model_response");
  return ok(String(choice));
}

export function parseChatCompletionsAnswer(body: unknown, candidateCount: number): Result<string, ModelAnswerError> {
  const parsed = ChatCompletionsResponseSchema.safeParse(body);
  if (!parsed.success) return err("invalid_model_response");
  const first = parsed.data.choices[0];
  if (first === undefined || first.finish_reason !== "stop") return err("invalid_model_response");
  return parseChoiceAnswer(first.message.content, candidateCount);
}

export function parseResponsesAnswer(body: unknown, candidateCount: number): Result<string, ModelAnswerError> {
  const parsed = ResponsesResponseSchema.safeParse(body);
  if (!parsed.success) return err("invalid_model_response");
  if (parsed.data.status !== "completed") return err("invalid_model_response");
  const message = parsed.data.output.find((item) => item.type === "message");
  const text = message?.content?.find((part) => part.type === "output_text")?.text;
  if (text === undefined) return err("invalid_model_response");
  return parseChoiceAnswer(text, candidateCount);
}

export function parseAnthropicAnswer(body: unknown, candidateCount: number): Result<string, ModelAnswerError> {
  const parsed = AnthropicResponseSchema.safeParse(body);
  if (!parsed.success) return err("invalid_model_response");
  if (parsed.data.stop_reason !== "end_turn") return err("invalid_model_response");
  const text = parsed.data.content.find((part) => part.type === "text")?.text;
  if (text === undefined) return err("invalid_model_response");
  return parseChoiceAnswer(text, candidateCount);
}
