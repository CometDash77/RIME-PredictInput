/**
 * inference 层与旧实现的行为对照。
 *
 * 每条用例的实际值都在这里现场算出来，再与 \`tests/fixtures/oracle.json\` 的
 * \`inference\` 段比对：断言的是「旧实现真的会这样回答」，而不是我对源码的复述。
 */

import { beforeAll, describe, expect, it } from "vitest";
import { parseRequest, type RequestEnvelope } from "../src/contracts/envelope.js";
import { FAILED_SCREENINGS, MODEL_DIGEST, VALIDATED_IDENTITY } from "../src/contracts/policy.js";
import type { DecisionInput } from "../src/domain/decision.js";
import type { LocalBackendErrorCode } from "../src/domain/error-codes.js";
import { DEFAULT_MODEL } from "../src/domain/model.js";
import { err, expectOk, ok, type Result } from "../src/domain/result.js";
import { settingsFromMapping, type Settings } from "../src/domain/settings.js";
import { settingsActionWire, type SettingsActionReply } from "../src/inference/actions.js";
import type { LocalBackendPort } from "../src/inference/ports.js";
import { InferenceService, type DispatchReply } from "../src/inference/service.js";
import {
  PULL_MODEL_PATTERN,
  type ConnectionStatus,
  type LocalInferenceOutcome,
  type ModelInventory,
  type PullStatus,
  type ResolvedModel,
} from "../src/providers/ollama.js";
import { basePayload, basePayloadObject, oracle } from "./support/oracle.js";

const INFERENCE_ENGINE = "a".repeat(40);
const INFERENCE_REQUEST_ID = "1".repeat(32);

const describeError = (error: unknown): string => "测试夹具必须可用: " + String(error);

function expectLoaded<T, E>(result: Result<T, E>): T {
  return expectOk(result, describeError);
}

const enabled: Settings = expectLoaded(settingsFromMapping({ enabled: true, local_model: DEFAULT_MODEL }));
const disabled: Settings = expectLoaded(settingsFromMapping({ enabled: false, local_model: DEFAULT_MODEL }));
const quick: Settings = expectLoaded(settingsFromMapping({ enabled: true, local_model: DEFAULT_MODEL, local_wait_ms: 1 }));
const slow: Settings = expectLoaded(settingsFromMapping({ enabled: true, local_model: DEFAULT_MODEL, local_wait_ms: 200 }));

const failedDigest = Object.keys(FAILED_SCREENINGS)[0] ?? "";
if (failedDigest === "") throw new Error("快照里必须有至少一条未通过筛选的模型摘要");

const installed: ModelInventory = {
  status: "available",
  models: [{ name: DEFAULT_MODEL, digest: MODEL_DIGEST, format: "unknown" }],
};
const unavailableStore: ModelInventory = { status: "unavailable", errorCode: "model_store_unavailable", models: [] };
const connected: ConnectionStatus = { status: "connected", provider: "local", version: "0.12.0" };

function okOutcome(choice = 2): LocalInferenceOutcome {
  return {
    kind: "ok",
    backend: "local",
    provider: "ollama",
    model: DEFAULT_MODEL,
    choice: String(choice),
    requestedModel: DEFAULT_MODEL,
    modelIdentity: VALIDATED_IDENTITY,
  };
}

const resolved: ResolvedModel = { identity: VALIDATED_IDENTITY, digest: MODEL_DIGEST, format: "unknown" };

/** 旧实现里最完整的一套「验收通过的本地模型」。 */
function goodScenario(): Scenario {
  return { resolve: ok(resolved), infer: okOutcome(), inventory: installed };
}

/** 只丢掉候选列表的负载：用来锁住「缺字段」与「字段为空」被区别对待这件事。 */
const stateOnlyPayload: Record<string, unknown> = { state: basePayloadObject["state"] };

interface Scenario {
  readonly resolve?: Result<ResolvedModel, LocalBackendErrorCode>;
  readonly router?: boolean;
  readonly infer?: LocalInferenceOutcome;
  readonly connection?: ConnectionStatus;
  readonly inventory?: ModelInventory;
}

/** 鸭子类型的假后端：没有套接字、没有子进程，只回答场景里规定的东西。 */
class FakeLocal implements LocalBackendPort {
  readonly #scenario: Scenario;
  #pullModel: string | null = null;

  constructor(scenario: Scenario = {}) {
    this.#scenario = scenario;
  }

  async resolveModel(model: string): Promise<Result<ResolvedModel, LocalBackendErrorCode>> {
    void model;
    return this.#scenario.resolve ?? err<LocalBackendErrorCode>("model_missing");
  }

  isRouter(model: string): boolean {
    void model;
    return this.#scenario.router ?? false;
  }

  async infer(
    decision: DecisionInput,
    settings: Settings,
    options: { readonly modelIdentity?: string } = {},
  ): Promise<LocalInferenceOutcome> {
    void decision;
    void settings;
    void options;
    return this.#scenario.infer ?? { kind: "unavailable", errorCode: "invalid_model_response" };
  }

  async testConnection(): Promise<ConnectionStatus> {
    return this.#scenario.connection ?? { status: "unavailable", errorCode: "ollama_missing" };
  }

  async modelInventory(options: { readonly startServer?: boolean } = {}): Promise<ModelInventory> {
    void options;
    return this.#scenario.inventory ?? { status: "unavailable", errorCode: "model_store_unavailable", models: [] };
  }

  async startModelPull(model: unknown): Promise<PullStatus> {
    if (typeof model !== "string" || !PULL_MODEL_PATTERN.test(model.trim())) {
      return { status: "unavailable", errorCode: "invalid_model_name" };
    }
    this.#pullModel = model.trim();
    return { status: "pulling", model: this.#pullModel };
  }

  modelPullStatus(): PullStatus {
    return { status: "idle" };
  }

  async cancelModelPull(): Promise<PullStatus> {
    return { status: "cancelled", model: this.#pullModel };
  }

  async close(): Promise<void> {
    // 假后端没有资源要释放。
  }
}

function makeRequest(
  options: {
    readonly payload?: unknown;
    readonly seq?: number;
    readonly requestId?: string;
    readonly engine?: string;
    readonly kind?: string;
  } = {},
): RequestEnvelope {
  const raw = JSON.stringify({
    version: 1,
    contract_version: 1,
    engine_id: options.engine ?? INFERENCE_ENGINE,
    seq: options.seq ?? 1,
    request_id: options.requestId ?? INFERENCE_REQUEST_ID,
    kind: options.kind ?? "predict",
    sent_at: 1000.25,
    payload: options.payload ?? basePayload,
  });
  return expectLoaded(parseRequest(new TextEncoder().encode(raw)));
}

/** duration_ms 是唯一不确定的字段：换成标记，两侧都这样处理。 */
function trimDuration(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => trimDuration(item));
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (key !== "duration_ms") kept[key] = trimDuration(item);
  }
  if ("duration_ms" in source) kept["has_duration_ms"] = true;
  return kept;
}

async function dispatchCase(
  scenario: Scenario,
  settings: Settings,
  request: RequestEnvelope,
): Promise<unknown> {
  const service = new InferenceService({ local: new FakeLocal(scenario) });
  try {
    return trimDuration(await service.dispatch(request, settings));
  } finally {
    await service.close();
  }
}

function action(reply: SettingsActionReply): unknown {
  return trimDuration(settingsActionWire(reply));
}

function immediate(reply: DispatchReply): unknown {
  if (reply.kind !== "immediate") throw new Error("该用例应当立刻回答");
  return trimDuration(reply.payload);
}

async function buildActual(): Promise<Record<string, unknown>> {
  const actual: Record<string, unknown> = {};

  actual["health_unavailable"] = await dispatchCase(
    { connection: { status: "unavailable", errorCode: "ollama_missing" }, inventory: unavailableStore },
    enabled,
    makeRequest({ kind: "health" }),
  );
  actual["health_accepted"] = await dispatchCase(
    { connection: connected, inventory: installed },
    enabled,
    makeRequest({ kind: "health" }),
  );

  const statusRequest = makeRequest({ kind: "settings", payload: { action: "model_status" } });
  actual["model_status_accepted"] = await dispatchCase(goodScenario(), enabled, statusRequest);
  actual["model_status_explicit"] = await dispatchCase(
    goodScenario(),
    enabled,
    makeRequest({ kind: "settings", payload: { action: "model_status", model: "some/model:tag" } }),
  );
  actual["model_status_failed_screening"] = await dispatchCase(
    { inventory: { status: "available", models: [{ name: DEFAULT_MODEL, digest: failedDigest, format: "gguf" }] } },
    enabled,
    statusRequest,
  );
  actual["model_status_unknown_digest"] = await dispatchCase(
    { inventory: { status: "available", models: [{ name: DEFAULT_MODEL, digest: "unknown", format: "unknown" }] } },
    enabled,
    statusRequest,
  );
  actual["model_status_unverified"] = await dispatchCase(
    { inventory: { status: "available", models: [{ name: DEFAULT_MODEL, digest: "d".repeat(64), format: "gguf" }] } },
    enabled,
    statusRequest,
  );
  actual["model_status_not_installed"] = await dispatchCase(
    { inventory: { status: "available", models: [{ name: "other/model:tag", digest: "d".repeat(64), format: "gguf" }] } },
    enabled,
    statusRequest,
  );
  actual["model_status_invalid_name"] = await dispatchCase(
    goodScenario(),
    enabled,
    makeRequest({ kind: "settings", payload: { action: "model_status", model: "bad name!" } }),
  );
  actual["model_status_store_unavailable"] = await dispatchCase(
    { inventory: unavailableStore },
    enabled,
    statusRequest,
  );

  actual["predict_disabled"] = await dispatchCase(goodScenario(), disabled, makeRequest());
  actual["predict_resolve_error"] = await dispatchCase(
    { resolve: err<LocalBackendErrorCode>("ollama_missing"), infer: okOutcome() },
    enabled,
    makeRequest(),
  );
  actual["predict_identity_not_validated"] = await dispatchCase(
    {
      resolve: ok({ identity: "ollama:" + "e".repeat(64), digest: "e".repeat(64), format: "unknown" }),
      infer: okOutcome(),
    },
    enabled,
    makeRequest(),
  );
  actual["predict_infer_unavailable"] = await dispatchCase(
    { resolve: ok(resolved), infer: { kind: "unavailable", errorCode: "provider_unavailable" } },
    enabled,
    makeRequest(),
  );
  actual["predict_ok"] = await dispatchCase(goodScenario(), enabled, makeRequest());
  actual["predict_bad_payload"] = await dispatchCase(
    goodScenario(),
    enabled,
    makeRequest({ payload: stateOnlyPayload }),
  );

  const service = new InferenceService({ local: new FakeLocal(goodScenario()) });
  try {
    actual["predict_cache_miss"] = trimDuration(await service.dispatch(makeRequest({ seq: 1 }), enabled));
    actual["predict_cache_hit"] = trimDuration(
      await service.dispatch(makeRequest({ seq: 2, requestId: "2".repeat(32) }), enabled),
    );
    actual["predict_cache_entries"] = service.cacheEntries;
    actual["status_after_predict"] = trimDuration(service.statusSince(0));
    actual["status_current"] = trimDuration(service.statusSince(service.statusRevision));
    actual["action_selection_accepted"] = action(
      await service.settingsAction(
        { action: "selection", prediction_request_id: "2".repeat(32), prediction_seq: 2, adopted: true },
        enabled,
      ),
    );
    actual["status_after_selection"] = trimDuration(service.statusSince(0));
    actual["action_selection_stale"] = action(
      await service.settingsAction(
        { action: "selection", prediction_request_id: INFERENCE_REQUEST_ID, prediction_seq: 1, adopted: true },
        enabled,
      ),
    );
    actual["action_selection_unknown"] = action(
      await service.settingsAction(
        { action: "selection", prediction_request_id: "3".repeat(32), prediction_seq: 1, adopted: true },
        enabled,
      ),
    );
    actual["action_selection_invalid"] = action(
      await service.settingsAction(
        { action: "selection", prediction_request_id: "xyz", prediction_seq: 1, adopted: true },
        enabled,
      ),
    );
    actual["action_cancel_prediction"] = action(
      await service.settingsAction({ action: "cancel_prediction", engine_id: INFERENCE_ENGINE, seq: 1 }, enabled),
    );
    actual["action_cancel_prediction_unknown"] = action(
      await service.settingsAction({ action: "cancel_prediction", engine_id: "b".repeat(40), seq: 1 }, enabled),
    );
    actual["action_cancel_prediction_invalid"] = action(
      await service.settingsAction({ action: "cancel_prediction", engine_id: "bad!", seq: 0 }, enabled),
    );
    actual["action_clear_cache"] = action(await service.settingsAction({ action: "clear_cache" }, enabled));
    actual["action_models"] = action(await service.settingsAction({ action: "models" }, enabled));
    actual["action_pull_model"] = action(
      await service.settingsAction({ action: "pull_model", model: "some/model:tag" }, enabled),
    );
    actual["action_pull_model_missing"] = action(await service.settingsAction({ action: "pull_model" }, enabled));
    actual["action_pull_status"] = action(await service.settingsAction({ action: "pull_status" }, enabled));
    actual["action_cancel_pull"] = action(await service.settingsAction({ action: "cancel_pull" }, enabled));
    actual["action_test_connection"] = action(await service.settingsAction({ action: "test_connection" }, enabled));
    actual["action_status"] = action(await service.settingsAction({ action: "status" }, enabled));
    actual["action_unknown"] = action(await service.settingsAction({ action: "nope" }, enabled));
    actual["action_not_object"] = action(await service.settingsAction({ action: null }, enabled));
  } finally {
    await service.close();
  }

  const router = new InferenceService({ local: new FakeLocal({ ...goodScenario(), router: true }) });
  try {
    await router.dispatch(makeRequest({ seq: 1 }), enabled);
    actual["predict_router_cache_miss"] = trimDuration(
      await router.dispatch(makeRequest({ seq: 2, requestId: "2".repeat(32) }), enabled),
    );
    actual["predict_router_cache_entries"] = router.cacheEntries;
  } finally {
    await router.close();
  }

  const queued = new InferenceService({ local: new FakeLocal(goodScenario()) });
  try {
    const first = await queued.submit(makeRequest({ seq: 5, engine: "9".repeat(40) }), quick);
    if (first.kind !== "deferred") throw new Error("predict 应当先回 pending");
    actual["submit_pending"] = trimDuration(first.initial);
    first.completion.catch(() => undefined);

    const second = await queued.submit(makeRequest({ seq: 6, engine: "8".repeat(40) }), quick);
    if (second.kind !== "deferred") throw new Error("predict 应当先回 pending");
    actual["submit_completion"] = trimDuration(await second.completion);

    actual["submit_disabled"] = immediate(
      await queued.submit(makeRequest({ seq: 7, engine: "7".repeat(40) }), disabled),
    );
    actual["submit_bad_payload"] = immediate(
      await queued.submit(makeRequest({ seq: 8, engine: "6".repeat(40), payload: stateOnlyPayload }), quick),
    );
    for (let index = 0; index < 16; index += 1) {
      const reply = await queued.submit(makeRequest({ seq: 9, engine: "e" + index.toString() }), slow);
      if (reply.kind === "deferred") reply.completion.catch(() => undefined);
    }
    actual["submit_busy"] = immediate(
      await queued.submit(makeRequest({ seq: 9, engine: "f".repeat(40) }), slow),
    );
  } finally {
    await queued.close();
  }

  return actual;
}

/**
 * 新类型无法表达的旧状态：\`backend\` 只有在 \`\"local\"\` 时才允许进入系统，
 * \`settingsFromMapping\` 会先把非本地偏好拒掉，所以这条用例单独断言。
 */
const UNREPRESENTABLE = new Set(["predict_local_only"]);

const caseNames = Object.keys(oracle.inference).filter((name) => !UNREPRESENTABLE.has(name));

describe("inference 层与旧实现一致", () => {
  let actual: Record<string, unknown> = {};

  beforeAll(async () => {
    actual = await buildActual();
  });

  it("每条快照用例都有对应的实现", () => {
    expect(Object.keys(actual).sort()).toEqual([...caseNames].sort());
  });

  it.each(caseNames)("%s 的回答与旧实现相同", (name) => {
    expect(actual[name]).toEqual(oracle.inference[name]);
  });

  it("cloud backend 在新类型里已经不可表达", () => {
    const mapped = settingsFromMapping({ enabled: true, backend: "cloud" });
    expect(mapped.ok).toBe(false);
    if (!mapped.ok) expect(mapped.error).toBe("local_only");
    expect(oracle.inference["predict_local_only"]).toEqual({
      status: "unavailable",
      error_code: "local_only",
    });
  });
});
