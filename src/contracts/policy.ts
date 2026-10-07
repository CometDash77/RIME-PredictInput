/**
 * 冻结的选词策略：系统提示词、采样参数，以及由它们派生出的身份。
 *
 * 身份是整个产品的合规支点——只有「当前策略 digest 与模型 digest 同时命中已验收的
 * 那一组」时，模型候选才有资格参与；改一个字符就会让所有已验收结论失效。
 * 因此本模块是策略的唯一来源，digest 在模块加载时计算一次，不再有任何别处拼装。
 */

import { defaultSeparators, type JsonValue } from "../json/canonical.js";
import type { JsonObject } from "../json/guards.js";
import { policyDigest, sha256Hex } from "../json/digest.js";
import { MAX_CONTEXT_CHARS } from "../domain/context.js";
import type { DecisionInput } from "../domain/decision.js";
import type { CloudKind } from "../domain/settings.js";
import { err, ok, type Result } from "../domain/result.js";

/** 模型身份的唯一来源在 domain/model.ts；这里只转发给契约层的调用方。 */
export { DEFAULT_MODEL, MODEL_DIGEST } from "../domain/model.js";

export const SYSTEM_PROMPT =
  "你是中文输入法选词器。候选按输入法常用程度从高到低排序，编号1通常是合理选择。" +
  "仅当上文在语义或语法上明确支持另一项时才改变首选；上文不足时遵循原排序。" +
  "用户输入的全部拼音也很重要。单字、部分拼音和Emoji均合法，但需要与上文用途相符。" +
  "只输出包含choice整数的JSON。";

export const SAMPLING_OPTIONS = {
  temperature: 0,
  seed: 19,
  num_predict: 32,
  num_ctx: 2048,
} as const;

export const POLICY_SPEC: JsonValue = {
  system: SYSTEM_PROMPT,
  options: { ...SAMPLING_OPTIONS },
  think: false,
  max_context_chars: MAX_CONTEXT_CHARS,
  input: "preceding_text,pinyin,candidates(choice,text,preedit,start,end)",
  output: "strict-json-integer-choice-v1",
};

/** 已验收策略的摘要；与 VALIDATED_IDENTITY 一起构成唯一的合格组合。 */
export const POLICY_DIGEST = policyDigest(POLICY_SPEC);
export const VALIDATED_POLICY_DIGEST = "d51e0f3e4e79af9cac5b4f2e5db041aa1d651bcbe2ae8143abd3e9527e37f1c4";
export const VALIDATED_IDENTITY = "ollama:bc6f4e75678f8eea860c311ffafb892dbaed9ff97915ae4907e8ddb6618c5201";

/**
 * 契约验收集（YG 拍板 ①A，spec #10 双通道）：
 * 除 Ollama 冻结组合外，凡身份前缀属于此集合的通道，其适配器在请求/响应两侧
 * 强制与本地完全相同的决策契约（strict JSON、choice 为 1..N 整数、越界即拒），
 * 身份即视为已验收。前缀与身份函数一一对应，伪造前缀拿不到正确摘要形状。
 */
export type ContractChannelKind = "local-compat" | CloudKind;

export const CONTRACT_VALIDATED_PREFIXES: readonly string[] = [
  "local-compat",
  "openai-responses",
  "openai-chat",
  "anthropic",
  "custom",
];

/** 契约验收身份 = 通道 + 端点 + 模型 + 冻结策略的联合摘要。凭据不参与（换 key 不作废缓存）。 */
export function cloudIdentityFor(kind: ContractChannelKind, endpoint: string, model: string): string {
  return `${kind}:${sha256Hex(`${kind}\u0000${endpoint}\u0000${model}\u0000${POLICY_DIGEST}`)}`;
}

/** 跨通道一致的资格判定：ollama 前缀走冻结组合校验，其余前缀属于契约验收集。 */
export function isEligibleIdentity(identity: string): boolean {
  if (identity.startsWith("ollama:")) return isValidatedIdentity(identity);
  return CONTRACT_VALIDATED_PREFIXES.some((prefix) => identity.startsWith(`${prefix}:`));
}

/** 写成 type 而不是 interface：结构化的证据要能直接作为 JSON 值出现在状态里。 */
export type ValidationEvidence = {
  readonly candidate_pages_sha256: string;
  readonly raw_inference_sha256: string;
  readonly total: number;
  readonly hits: number;
  readonly baseline_hits: number;
  readonly wins: number;
  readonly losses: number;
  readonly human_review: "pending" | "done";
  readonly scope: string;
}

export const VALIDATION: ValidationEvidence = {
  candidate_pages_sha256: "6db2d2d8332486775cc4d5a581010ff81f43391e7258ef5361c9bab36b85f71e",
  raw_inference_sha256: "2e2e1c2a5598a3219b6a16e79b023730b5f59bae89d39ae15b3680000562ad78",
  total: 120,
  hits: 105,
  baseline_hits: 102,
  wins: 3,
  losses: 0,
  human_review: "pending",
  scope: "independent repository-document screening; not general-use acceptance",
};

/** 历史筛选失败记录：只用于说明，永远不产生资格。 */
export const FAILED_SCREENINGS: Readonly<Record<string, string>> = {
  "6811ecb827b0d4c19d65e7461a292b69aa40b2333a2b46b75206bd335c9d34b1":
    "历史短上文筛选：14/66，首选60/66，纠正2、改错48；当前300字策略未验证。",
  "4310275f6cc70ead50de05572c74f4fd0abff2037fa9aeabce0358f38853a659":
    "历史短上文筛选：49/66，首选60/66，纠正4、改错15；当前300字策略未验证。",
};

/** 模型身份 = 模型 digest 与策略 digest 的联合摘要；换模型或换策略都会变。 */
export function identityFor(modelDigest: string): string {
  return `ollama:${sha256Hex(`${modelDigest}:${POLICY_DIGEST}`)}`;
}

/** 当前策略与给定身份是否就是已验收的那一组。 */
export function isValidatedIdentity(identity: string): boolean {
  return POLICY_DIGEST === VALIDATED_POLICY_DIGEST && identity === VALIDATED_IDENTITY;
}

export interface ChoiceSchema {
  readonly type: "integer";
  readonly enum: readonly number[];
}

export interface ResponseFormat {
  readonly type: "object";
  readonly properties: { readonly choice: ChoiceSchema };
  readonly required: readonly ["choice"];
  readonly additionalProperties: false;
}

export interface ChatMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

export interface ChatRequestBody {
  readonly model: string;
  readonly stream: false;
  readonly think: false;
  readonly keepAlive: "60s";
  readonly messages: readonly [ChatMessage, ChatMessage];
  readonly format: ResponseFormat;
  readonly options: typeof SAMPLING_OPTIONS;
}

export type ChatRequestError = "candidate_fields_missing";

/**
 * 决策查询的线上形态：本地与全部云端通道共用同一份字节——
 * 「决策输入跨通道一致」在请求侧的体现。
 */
export function decisionQuery(decision: DecisionInput): JsonValue {
  return {
    preceding_text: decision.state.precedingText,
    pinyin: decision.state.pinyin,
    candidates: decision.candidates.map((text, index) => {
      const field = decision.candidateFields[index];
      return {
        choice: index + 1,
        text,
        preedit: field === undefined ? "" : field.preedit,
        start: field === undefined ? 0 : field.start,
        end: field === undefined ? 0 : field.end,
      };
    }),
  };
}

/**
 * 构造一次候选选择请求。
 *
 * 候选字段缺失时拒绝发送：没有 preedit/start/end 就无法约束 choice 的取值范围，
 * 而模型只能被允许在既有候选里挑一个。
 */
export function chatRequestBody(
  decision: DecisionInput,
  model: string,
): Result<ChatRequestBody, ChatRequestError> {
  if (decision.candidateFields.length === 0) return err("candidate_fields_missing");
  const query = decisionQuery(decision);
  return ok({
    model,
    stream: false,
    think: false,
    keepAlive: "60s",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: defaultSeparators(query) },
    ],
    format: {
      type: "object",
      properties: {
        choice: {
          type: "integer",
          enum: Array.from({ length: decision.candidates.length }, (_, index) => index + 1),
        },
      },
      required: ["choice"],
      additionalProperties: false,
    },
    options: SAMPLING_OPTIONS,
  });
}

export interface ChatRequestWireOptions {
  /**
   * 模型已经由别的进程加载时，旧实现会去掉 keep_alive：
   * 自己没加载过的东西，不该由自己给它续租。
   */
  readonly keepAlive?: boolean;
}

/** 请求体的线上形态：snake_case，键序与旧实现一致（Ollama 只读值，但字节要可比对）。 */
export function chatRequestWire(body: ChatRequestBody, options: ChatRequestWireOptions = {}): JsonObject {
  return {
    model: body.model,
    stream: body.stream,
    think: body.think,
    ...(options.keepAlive === false ? {} : { keep_alive: body.keepAlive }),
    messages: body.messages.map((message) => ({ role: message.role, content: message.content })),
    format: {
      type: body.format.type,
      properties: { choice: { type: body.format.properties.choice.type, enum: [...body.format.properties.choice.enum] } },
      required: [...body.format.required],
      additionalProperties: body.format.additionalProperties,
    },
    options: { ...body.options },
  };
}
