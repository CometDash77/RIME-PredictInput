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
export interface DecisionInput {
  readonly state: DecisionState;
  readonly candidates: readonly string[];
  readonly candidateFields: readonly CandidateFields[];
}

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

  return ok({
    state: { task, precedingText: preceding, pinyin },
    candidates: [...candidates] as string[],
    candidateFields: fields,
  });
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
