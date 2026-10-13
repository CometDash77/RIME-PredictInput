import { jsonDigest } from "../json/digest.js";
import type { JsonValue } from "../json/canonical.js";
import { areCandidatesSafe, MAX_SPAN_OFFSET, MAX_PREEDIT_SCALARS } from "./candidate.js";
import { MAX_CONTEXT_CHARS } from "./context.js";
import type { DecisionInputErrorCode } from "./error-codes.js";
import { err, ok, type Result } from "./result.js";

/** `model_predict_filter.lua` sends this exact task string. */
export const DECISION_TASK = "中文输入法候选选择";

export const MAX_TASK_SCALARS = 256;
export const MAX_PINYIN_SCALARS = 256;
export const MAX_CANDIDATES = 255;

/**
 * 请求的两种模式（spec #18 §3、决策 05 Q2A）。
 *
 * `selection` 只能在既有候选里挑一个；`generation` 允许模型给出词条文本，但文本
 * 必须逐字命中候选列表（运行时它就是用户词库的投影）并通过读音与音节校验，否则
 * 安全留空——插件的承诺是「只在词库内选择」，不是「替用户造词」。
 */
export const DECISION_MODES = ["selection", "generation"] as const;
export type DecisionMode = (typeof DECISION_MODES)[number];
export const DEFAULT_DECISION_MODE: DecisionMode = "selection";
/** 载荷里的模式键；缺席或为 null 时按 `selection` 处理，旧版 Lua 载荷因此保持有效。 */
export const DECISION_MODE_KEY = "mode";

export interface DecisionState {
  readonly task: string;
  readonly precedingText: string;
  readonly pinyin: string;
}

export interface CandidateFields {
  readonly preedit: string;
  readonly start: number;
  readonly end: number;
}

/**
 * A validated prediction request. Constructing one of these is the only way to
 * get past the boundary: raw JSON never enters the pipeline unchecked.
 */
export interface DecisionCommon {
  readonly state: DecisionState;
  readonly candidates: readonly string[];
  readonly candidateFields: readonly CandidateFields[];
}

export interface SelectionDecision extends DecisionCommon {
  readonly mode: "selection";
}

export interface GenerationDecision extends DecisionCommon {
  readonly mode: "generation";
}

/**
 * 判别联合：模式在类型上不可省略，因此「按生成结果插入候选」与「按候选编号插入」
 * 在编译期就分得开；分派只发生在 inference/service 内部，runtime 调用者无感。
 */
export type DecisionInput = SelectionDecision | GenerationDecision;

const STATE_KEYS = ["task", "preceding_text", "pinyin"] as const;
const FIELD_KEYS = ["preedit", "start", "end"] as const;

function scalarLength(value: string): number {
  return [...value].length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => key in value);
}

/** `contracts.DecisionInput.from_payload`. */
export function decisionInputFromPayload(payload: unknown): Result<DecisionInput, DecisionInputErrorCode> {
  if (!isPlainObject(payload)) return err("invalid_prediction_payload");
  const rawMode: unknown = payload[DECISION_MODE_KEY];
  if (rawMode !== undefined && rawMode !== null && rawMode !== "selection" && rawMode !== "generation") {
    return err("invalid_mode");
  }
  const mode: DecisionMode = rawMode === "generation" ? "generation" : DEFAULT_DECISION_MODE;
  const state = payload["state"];
  const candidates = payload["candidates"];
  if (!isPlainObject(state) || !hasExactKeys(state, STATE_KEYS)) return err("invalid_state");

  const task = state["task"];
  const preceding = state["preceding_text"];
  const pinyin = state["pinyin"];
  if (typeof task !== "string" || scalarLength(task) < 1 || scalarLength(task) > MAX_TASK_SCALARS) {
    return err("invalid_state");
  }
  if (typeof preceding !== "string" || scalarLength(preceding) > MAX_CONTEXT_CHARS) return err("invalid_state");
  if (typeof pinyin !== "string" || scalarLength(pinyin) > MAX_PINYIN_SCALARS) return err("invalid_state");

  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > MAX_CANDIDATES) {
    return err("invalid_candidates");
  }
  for (const text of candidates) {
    if (typeof text !== "string" || text === "" || scalarLength(text) > 512) return err("invalid_candidates");
  }
  if (!areCandidatesSafe(candidates)) return err("invalid_candidates");

  const rawFields: unknown = payload["candidate_fields"];
  let fields: CandidateFields[] = [];
  if (rawFields !== undefined && rawFields !== null) {
    if (!Array.isArray(rawFields) || rawFields.length !== candidates.length) {
      return err("invalid_candidate_fields");
    }
    fields = [];
    for (const row of rawFields) {
      if (!isPlainObject(row) || !hasExactKeys(row, FIELD_KEYS)) return err("invalid_candidate_fields");
      const preedit = row["preedit"];
      const start = row["start"];
      const end = row["end"];
      if (typeof preedit !== "string" || scalarLength(preedit) > MAX_PREEDIT_SCALARS) {
        return err("invalid_candidate_fields");
      }
      if (!Number.isInteger(start) || !Number.isInteger(end)) return err("invalid_candidate_fields");
      const from = start as number;
      const to = end as number;
      if (!(from >= 0 && from < to && to <= MAX_SPAN_OFFSET)) return err("invalid_candidate_fields");
      fields.push({ preedit, start: from, end: to });
    }
  }

  const common = {
    state: { task, precedingText: preceding, pinyin },
    candidates: [...candidates] as string[],
    candidateFields: fields,
  };
  return mode === "generation" ? ok({ mode: "generation", ...common }) : ok({ mode: "selection", ...common });
}

/** Cache-key component: the editor state the answer was produced for. */
export function stateDigest(decision: DecisionInput): string {
  return jsonDigest({
    task: decision.state.task,
    preceding_text: decision.state.precedingText,
    pinyin: decision.state.pinyin,
  });
}

/** Cache-key component: the candidate list the answer was produced for. */
export function candidatesDigest(decision: DecisionInput): string {
  const fields: JsonValue[] = decision.candidateFields.map((field) => ({
    preedit: field.preedit,
    start: field.start,
    end: field.end,
  }));
  return jsonDigest({ texts: [...decision.candidates], fields });
}
