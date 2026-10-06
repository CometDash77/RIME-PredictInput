/**
 * 旧实现行为快照的读取入口。
 *
 * `tests/fixtures/oracle.json` 由 `tools/oracle/dump_fixtures.py` 直接驱动旧的 Python
 * 伴随进程生成，是「重构前的行为」这一说法的唯一凭据。它属于外部输入，因此在这里
 * 先用 schema 验证一次，测试里就不再需要任何类型断言。
 */

import { readFileSync } from "node:fs";
import { z } from "zod";

const captureSchema = z.object({
  ok: z.boolean(),
  code: z.string().nullable(),
  value: z.unknown().optional(),
});

export type Capture = z.infer<typeof captureSchema>;

const decisionCaseSchema = z.object({
  name: z.string(),
  payload: z.unknown(),
  result: captureSchema,
  state_digest: z.string().optional(),
  candidates_digest: z.string().optional(),
});

const settingsCaseSchema = z.object({
  name: z.string(),
  mapping: z.unknown(),
  result: captureSchema,
});

const requestCaseSchema = z.object({
  name: z.string(),
  raw: z.string(),
  result: captureSchema,
});

const chatCaseSchema = z.object({
  name: z.string(),
  model: z.string(),
  result: captureSchema,
});

const policySchema = z.object({
  default_model: z.string(),
  model_digest: z.string(),
  system_prompt: z.string(),
  options: z.unknown(),
  policy_spec: z.unknown(),
  policy_digest: z.string(),
  validated_policy_digest: z.string(),
  validated_identity: z.string(),
  validation: z.unknown(),
  failed_screenings: z.unknown(),
  identity_for_model_digest: z.string(),
  is_validated_default: z.boolean(),
});

const responsesSchema = z.object({
  settings_file_bytes: z.string(),
  settings_file_no_overwrite_bytes: z.string(),
  request_files: z.record(z.string(), z.string()),
  request_tree: z.array(z.string()),
  request_to_mapping: z.unknown(),
  publish_ok: z.boolean(),
  response_files: z.record(z.string(), z.string()),
  response_tree: z.array(z.string()),
  read_latest: z.unknown().nullable(),
  consume_ok: z.boolean(),
  consume_wrong_id_refused: z.boolean(),
  response_tree_after_consume: z.array(z.string()),
  publish_stale_refused: z.boolean(),
  publish_newest_ok: z.boolean(),
  publish_first_ok: z.boolean(),
  publish_older_refused: z.boolean(),
  publish_same_seq_other_id_refused: z.boolean(),
  latest_seq_after_refusals: z.number().nullable(),
  request_bytes_fractional: z.string(),
  publish_response_fractional_ok: z.boolean(),
  response_bytes_fractional: z.string(),
  ready_bytes_fractional: z.string(),
  read_latest_fractional: z.unknown().nullable(),
});

const runtimeResponseSchema = z.object({
  seq: z.number(),
  request_id: z.string(),
  payload: z.unknown(),
});

const runtimeInputSchema = z.object({
  settings_mapping: z.unknown(),
  raw_settings: z.string().nullable(),
  rewrite_before: z.unknown(),
  rewrite_after: z.unknown(),
  kind: z.string(),
  payload: z.unknown(),
  resolve: z.unknown(),
  idle_seconds: z.number(),
});

const runtimeScenarioSchema = z.object({
  name: z.string(),
  input: runtimeInputSchema,
  state_after_start: z.record(z.string(), z.unknown()),
  handled: z.number(),
  calls: z.array(
    z.object({
      kind: z.string(),
      seq: z.number(),
      settings: z.record(z.string(), z.unknown()),
    }),
  ),
  request_id: z.string(),
  response_after_pump: runtimeResponseSchema.nullable(),
  state_after_pump: z.record(z.string(), z.unknown()),
  log_after_pump: z.array(z.record(z.string(), z.unknown())),
  response_after_resolve: runtimeResponseSchema.nullable(),
  notices: z.array(z.object({ engine_id: z.string(), request_id: z.string(), seq: z.number() })),
  state_after_resolve: z.record(z.string(), z.unknown()),
  log_after_resolve: z.array(z.record(z.string(), z.unknown())),
  deferred_pending: z.number(),
});

const runtimeLoopSchema = z.object({
  name: z.string(),
  input: z.object({
    publish: z.boolean(),
    kind: z.string(),
    payload: z.unknown(),
    idle_seconds: z.number(),
  }),
  dispatch_calls: z.number(),
  closed: z.boolean(),
  state: z.record(z.string(), z.unknown()),
  response: runtimeResponseSchema.nullable(),
});

const runtimeConstructionSchema = z.array(z.object({ name: z.string(), raised: z.string().nullable() }));

const runtimeSchema = z.object({
  scenarios: z.array(runtimeScenarioSchema),
  loops: z.array(runtimeLoopSchema),
  construction: runtimeConstructionSchema,
});

const oracleSchema = z.object({
  generated_by: z.string(),
  source: z.string(),
  policy: policySchema,
  decision_payloads: z.array(decisionCaseSchema),
  settings_mappings: z.array(settingsCaseSchema),
  requests: z.array(requestCaseSchema),
  chat_requests: z.array(chatCaseSchema),
  responses: responsesSchema,
  inference: z.record(z.string(), z.unknown()),
  runtime: runtimeSchema,
});

export type Oracle = z.infer<typeof oracleSchema>;
export type DecisionCase = z.infer<typeof decisionCaseSchema>;
export type SettingsCase = z.infer<typeof settingsCaseSchema>;
export type RequestCase = z.infer<typeof requestCaseSchema>;
export type ChatCase = z.infer<typeof chatCaseSchema>;
export type RuntimeInput = z.infer<typeof runtimeInputSchema>;
export type RuntimeScenario = z.infer<typeof runtimeScenarioSchema>;
export type RuntimeLoop = z.infer<typeof runtimeLoopSchema>;
export type RuntimeConstruction = z.infer<typeof runtimeConstructionSchema>;

const fixturePath = new URL("../fixtures/oracle.json", import.meta.url);

/** 已用 schema 验证过的旧实现快照；模块加载时读一次。 */
export const oracle: Oracle = oracleSchema.parse(JSON.parse(readFileSync(fixturePath, "utf8")) as unknown);

export function decisionCases(): [string, DecisionCase][] {
  return oracle.decision_payloads.map((item) => [item.name, item]);
}

export function settingsCases(): [string, SettingsCase][] {
  return oracle.settings_mappings.map((item) => [item.name, item]);
}

export function requestCases(): [string, RequestCase][] {
  return oracle.requests.map((item) => [item.name, item]);
}

export function chatCases(): [string, ChatCase][] {
  return oracle.chat_requests.map((item) => [item.name, item]);
}

/** inference 层的逐条用例：名字到旧实现真实回答的映射。 */
export function inferenceCases(): Record<string, unknown> {
  return oracle.inference;
}

/** 运行时层的快照：请求泵场景、空闲退出循环、构造期坏文件。 */
export function runtimeCases(): z.infer<typeof runtimeSchema> {
  return oracle.runtime;
}

/** 基础决策输入：直接取自快照里的第一条合法用例，避免测试自造数据。 */
export const basePayload: unknown = oracle.decision_payloads[0]?.payload;

const basePayloadRecord = z.record(z.string(), z.unknown()).safeParse(basePayload);

if (!basePayloadRecord.success) throw new Error("oracle base payload must be a JSON object");

/** 同一份基础负载，但已经过对象校验，便于逐字段改写。 */
export const basePayloadObject: Record<string, unknown> = basePayloadRecord.data;

/** 去掉一个字段后的基础负载：用来区分「字段缺失」与「字段为 null」。 */
export function payloadWithoutField(field: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...basePayloadObject };
  delete copy[field];
  return copy;
}
