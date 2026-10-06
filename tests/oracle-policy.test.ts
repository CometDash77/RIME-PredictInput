import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL,
  MODEL_DIGEST,
  POLICY_DIGEST,
  POLICY_SPEC,
  SAMPLING_OPTIONS,
  SYSTEM_PROMPT,
  VALIDATION,
  FAILED_SCREENINGS,
  chatRequestBody,
  chatRequestWire,
  identityFor,
  isValidatedIdentity,
} from "../src/contracts/policy.js";
import { decisionInputFromPayload, type DecisionInput } from "../src/domain/decision.js";
import { expectOk } from "../src/domain/result.js";
import { basePayload, chatCases, oracle } from "./support/oracle.js";

function baseDecision(): DecisionInput {
  return expectOk(decisionInputFromPayload(basePayload), (error) => "base payload rejected: " + error);
}

function singleCandidatePayload(): unknown {
  const payload = basePayload as {
    readonly state: unknown;
    readonly candidates: readonly unknown[];
    readonly candidate_fields: readonly unknown[];
  };
  return {
    state: payload.state,
    candidates: payload.candidates.slice(0, 1),
    candidate_fields: payload.candidate_fields.slice(0, 1),
  };
}

function withoutCandidateFieldsPayload(): unknown {
  const payload = basePayload as { readonly state: unknown; readonly candidates: unknown };
  return { state: payload.state, candidates: payload.candidates };
}

describe("策略身份", () => {
  it("复现旧实现的策略摘要与已验收身份", () => {
    expect(POLICY_DIGEST).toBe(oracle.policy.policy_digest);
    expect(POLICY_DIGEST).toBe(oracle.policy.validated_policy_digest);
    expect(identityFor(MODEL_DIGEST)).toBe(oracle.policy.identity_for_model_digest);
    expect(identityFor(MODEL_DIGEST)).toBe(oracle.policy.validated_identity);
    expect(isValidatedIdentity(identityFor(MODEL_DIGEST))).toBe(oracle.policy.is_validated_default);
  });

  it("提示词、采样参数与策略快照逐字一致", () => {
    expect(SYSTEM_PROMPT).toBe(oracle.policy.system_prompt);
    expect(SAMPLING_OPTIONS).toEqual(oracle.policy.options);
    expect(POLICY_SPEC).toEqual(oracle.policy.policy_spec);
    expect(VALIDATION).toEqual(oracle.policy.validation);
    expect(FAILED_SCREENINGS).toEqual(oracle.policy.failed_screenings);
  });

  it("默认模型与摘要来自同一个事实来源", () => {
    expect(DEFAULT_MODEL).toBe(oracle.policy.default_model);
    expect(MODEL_DIGEST).toBe(oracle.policy.model_digest);
  });

  it("未验收的组合不具备资格", () => {
    expect(isValidatedIdentity(identityFor("0".repeat(64)))).toBe(false);
    expect(isValidatedIdentity(oracle.policy.validated_identity)).toBe(true);
  });
});

describe("聊天请求体", () => {
  function caseDecision(name: string): DecisionInput {
    switch (name) {
      case "single_candidate":
        return expectOk(decisionInputFromPayload(singleCandidatePayload()), (error) => "rejected: " + error);
      case "candidate_fields_missing":
        return expectOk(decisionInputFromPayload(withoutCandidateFieldsPayload()), (error) => "rejected: " + error);
      default:
        return baseDecision();
    }
  }

  function bodyFor(name: string, model: string): unknown {
    const body = chatRequestBody(caseDecision(name), model);
    return body.ok ? chatRequestWire(body.value) : "error:" + body.error;
  }

  it.each(chatCases())("%s", (name, item) => {
    const actual = bodyFor(name, item.model);
    expect(actual).toEqual(item.result.ok ? item.result.value : "error:" + item.result.code);
  });
});
