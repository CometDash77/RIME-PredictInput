/**
 * 运行时层与旧 Python 伴随进程的对照测试。
 *
 * 用例输入与期望值全部来自 `tests/fixtures/oracle.json` 的 `runtime` 段：那里记录了
 * 旧 `SidecarRuntime` 在真实临时目录里写出的状态文件、诊断日志和两次响应。这里只补上
 * 旧脚本里那段 dispatch 与假时钟，其余按快照重放。
 *
 * 运行期真值（pid、request_id）在两侧都掩码，其它字段一律逐字比对。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { isRequestKind } from "../src/contracts/envelope.js";
import { DEFAULT_SETTINGS, settingsFromMapping, toWire } from "../src/domain/settings.js";
import { engineId as toEngineId, sequence as toSequence } from "../src/domain/ids.js";
import { expectOk } from "../src/domain/result.js";
import type { JsonObject } from "../src/json/guards.js";
import { appPaths } from "../src/ipc/app-paths.js";
import type { Dispatch, DispatchReply } from "../src/runtime/dispatch.js";
import { SidecarRuntime } from "../src/runtime/runtime.js";
import { SettingsStore } from "../src/settings/store.js";
import { toJsonObject } from "./support/json.js";
import { runtimeCases, type RuntimeLoop, type RuntimeScenario } from "./support/oracle.js";

/** 旧脚本使用的 engine id；响应按它分目录，因此这个值本身也是契约。 */
const ENGINE_ID = "a".repeat(40);
/** 假时钟的起点，与旧脚本一致。 */
const CLOCK_START = 100.0;
/** 掩码声明：运行期真值在两侧都不参与比较。 */
const MASKED_PID = "pid";
const MASKED_REQUEST_ID = "request-id";
const MASKED_TIMESTAMP = "float";

const recordSchema = z.record(z.string(), z.unknown());

function readState(statusPath: string): Record<string, unknown> {
  const parsed = recordSchema.parse(JSON.parse(readFileSync(statusPath, "utf8")));
  return { ...parsed, pid: MASKED_PID, updated_at: MASKED_TIMESTAMP };
}

function readLog(logPath: string): Record<string, unknown>[] {
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  const rows: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    rows.push(JSON.parse(line));
  }
  return rows.map((row) => {
    const masked: Record<string, unknown> = { ...recordSchema.parse(row), ts: "iso" };
    if ("duration_ms" in masked) masked["duration_ms"] = "number";
    return masked;
  });
}

function readResponse(runtime: SidecarRuntime): Record<string, unknown> | null {
  const latest = expectOk(runtime.ipc.readLatestResponse(ENGINE_ID), (error) => error);
  if (latest === null) return null;
  return { seq: latest.seq, request_id: MASKED_REQUEST_ID, payload: latest.payload };
}

/** 快照里的响应也走同一套掩码，保证两侧比较的是同一件事。 */
function maskFixtureResponse(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  const parsed = recordSchema.parse(raw);
  return { ...parsed, request_id: MASKED_REQUEST_ID };
}

function maskNotice(notice: { engine_id: string; request_id: string; seq: number }): Record<string, unknown> {
  return { ...notice, request_id: MASKED_REQUEST_ID };
}

function saveMapping(store: SettingsStore, mapping: unknown): void {
  const settings = expectOk(settingsFromMapping(mapping), (error) => `快照里的设置被拒绝：${error}`);
  expectOk(store.save(settings), (error) => `快照里的设置写不进去：${error}`);
}

function requireKind(kind: string): "predict" | "health" | "settings" {
  if (!isRequestKind(kind)) throw new Error(`快照里出现了未知请求类型：${kind}`);
  return kind;
}

/** 立即应答型场景的返回负载：与旧脚本里每个 `scenario(...)` 的 lambda 一一对应。 */
const IMMEDIATE_PAYLOADS: Record<string, () => JsonObject> = {
  immediate_ok: () => ({ status: "ok", eligible: true }),
  immediate_missing_status: () => ({ note: "no status" }),
  immediate_invalid_error_code: () => ({ status: "unavailable", error_code: 1.5 }),
  immediate_bool_error_code: () => ({ status: "unavailable", error_code: true }),
  predict_reloads_settings: () => ({ status: "ok" }),
  settings_kind_keeps_cached: () => ({ status: "ok" }),
  broken_settings_disables: () => ({ status: "ok" }),
};

const DEFERRED_SCENARIOS = ["deferred_ok", "deferred_ineligible", "deferred_settings_changed", "deferred_unresolved"];

/**
 * 旧 dispatch 是鸭子类型，运行期确实可能返回非对象。这一条刻意越过类型复刻该运行时
 * 边界：验证 runtime 仍把它折成 `invalid_handler_result`，而不是把非对象写进响应。
 */
const ROGUE_REPLY = async (): Promise<DispatchReply> => "not a dict" as unknown as DispatchReply;

function makeDispatch(
  name: string,
  calls: { kind: string; seq: number; settings: unknown }[],
  waiters: ((value: JsonObject | null) => void)[],
): Dispatch {
  const inner: Dispatch = async (_request, settings) => {
    if (name === "immediate_non_dict") return ROGUE_REPLY();
    if (name === "handler_failed") throw new Error("oracle dispatch failure");
    const immediate = IMMEDIATE_PAYLOADS[name];
    if (immediate !== undefined) return { kind: "immediate", payload: immediate() };
    if (DEFERRED_SCENARIOS.includes(name)) {
      const completion = new Promise<JsonObject | null>((resolve) => {
        waiters.push(resolve);
      });
      return { kind: "deferred", initial: { status: "pending" }, settings, completion };
    }
    throw new Error(`快照场景没有对应实现：${name}`);
  };
  return async (request, settings) => {
    calls.push({ kind: request.kind, seq: request.seq, settings: toWire(settings) });
    return inner(request, settings);
  };
}

/** 等「第二次响应」的异步写入落定；未落定的场景会耗尽这里的轮次并保持 pending。 */
async function settle(runtime: SidecarRuntime): Promise<void> {
  for (let round = 0; round < 100 && runtime.deferredPending > 0; round += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

interface ReplayedScenario {
  readonly stateAfterStart: Record<string, unknown>;
  readonly handled: number;
  readonly calls: { kind: string; seq: number; settings: unknown }[];
  readonly responseAfterPump: Record<string, unknown> | null;
  readonly stateAfterPump: Record<string, unknown>;
  readonly logAfterPump: Record<string, unknown>[];
  readonly responseAfterResolve: Record<string, unknown> | null;
  readonly notices: Record<string, unknown>[];
  readonly stateAfterResolve: Record<string, unknown>;
  readonly logAfterResolve: Record<string, unknown>[];
  readonly deferredPending: number;
}

async function replay(scenario: RuntimeScenario): Promise<ReplayedScenario> {
  const input = scenario.input;
  const paths = appPaths(mkdtempSync(join(tmpdir(), "rime-runtime-")));
  const store = new SettingsStore(paths.settings);
  if (input.settings_mapping !== null && input.settings_mapping !== undefined) {
    saveMapping(store, input.settings_mapping);
  }

  const calls: { kind: string; seq: number; settings: unknown }[] = [];
  const notices: Record<string, unknown>[] = [];
  const waiters: ((value: JsonObject | null) => void)[] = [];
  const clock = { value: CLOCK_START };
  const runtime = new SidecarRuntime({
    paths,
    dispatch: makeDispatch(scenario.name, calls, waiters),
    pollInterval: 0.01,
    idleSeconds: input.idle_seconds,
    monotonic: () => clock.value,
    wallClock: () => 1000.25,
    sleep: async (seconds) => {
      clock.value += Math.max(seconds, 0.1);
    },
    completionNotify: (notice) => {
      notices.push({ engine_id: notice.engineId, request_id: notice.requestId, seq: notice.sequence });
      return true;
    },
    pid: 15196,
  });

  const stateAfterStart = readState(paths.status);
  if (input.raw_settings !== null) writeFileSync(paths.settings, input.raw_settings, "utf8");
  if (input.rewrite_before !== null && input.rewrite_before !== undefined) {
    saveMapping(store, input.rewrite_before);
  }
  expectOk(
    runtime.ipc.publishRequest({
      engineId: expectOk(toEngineId(ENGINE_ID), (error) => error),
      seq: expectOk(toSequence(1), (error) => error),
      kind: requireKind(input.kind),
      payload: input.payload === null || input.payload === undefined ? {} : toJsonObject(input.payload),
      now: 1000.25,
    }),
    (error) => `请求写不进去：${error}`,
  );

  const handled = await runtime.pumpOnce();
  const responseAfterPump = readResponse(runtime);
  const stateAfterPump = readState(paths.status);
  const logAfterPump = readLog(paths.log);

  if (input.rewrite_after !== null && input.rewrite_after !== undefined) {
    saveMapping(store, input.rewrite_after);
  }
  if (input.resolve !== null && input.resolve !== undefined) {
    const value = toJsonObject(input.resolve);
    for (const resolve of waiters) resolve(value);
  }
  await settle(runtime);

  return {
    stateAfterStart,
    handled,
    calls,
    responseAfterPump,
    stateAfterPump,
    logAfterPump,
    responseAfterResolve: readResponse(runtime),
    notices: notices.map((notice) => maskNotice(z.object({ engine_id: z.string(), request_id: z.string(), seq: z.number() }).parse(notice))),
    stateAfterResolve: readState(paths.status),
    logAfterResolve: readLog(paths.log),
    deferredPending: runtime.deferredPending,
  };
}

async function replayLoop(loop: RuntimeLoop): Promise<{
  dispatchCalls: number;
  closed: boolean;
  state: Record<string, unknown>;
  response: Record<string, unknown> | null;
}> {
  const input = loop.input;
  const paths = appPaths(mkdtempSync(join(tmpdir(), "rime-runtime-")));
  const store = new SettingsStore(paths.settings);
  saveMapping(store, { enabled: true });

  const owner = { calls: 0, closed: false };
  const clock = { value: CLOCK_START };
  const runtime = new SidecarRuntime({
    paths,
    dispatch: async () => {
      owner.calls += 1;
      return { kind: "immediate", payload: { status: "ok" } };
    },
    pollInterval: 0.01,
    idleSeconds: input.idle_seconds,
    monotonic: () => clock.value,
    wallClock: () => 1000.25,
    sleep: async (seconds) => {
      clock.value += Math.max(seconds, 0.1);
    },
    completionNotify: () => true,
    closeDispatchOwner: () => {
      owner.closed = true;
    },
    pid: 15196,
  });

  if (input.publish) {
    expectOk(
      runtime.ipc.publishRequest({
        engineId: expectOk(toEngineId(ENGINE_ID), (error) => error),
        seq: expectOk(toSequence(1), (error) => error),
        kind: requireKind(input.kind),
        payload: toJsonObject(input.payload),
        now: 1000.25,
      }),
      (error) => `请求写不进去：${error}`,
    );
  }
  await runtime.run();
  return {
    dispatchCalls: owner.calls,
    closed: owner.closed,
    state: readState(paths.status),
    response: readResponse(runtime),
  };
}

const scenarios = runtimeCases().scenarios;
const loops = runtimeCases().loops;
const construction = runtimeCases().construction;

const IMPLEMENTED = [...Object.keys(IMMEDIATE_PAYLOADS), ...DEFERRED_SCENARIOS, "immediate_non_dict", "handler_failed"];

describe("请求泵对照旧实现", () => {
  it("快照里的每条用例都有对应实现", () => {
    expect([...IMPLEMENTED].sort()).toEqual(scenarios.map((scenario) => scenario.name).sort());
  });

  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const actual = await replay(scenario);
      expect(actual.stateAfterStart).toEqual({
        ...scenario.state_after_start,
        pid: MASKED_PID,
        updated_at: MASKED_TIMESTAMP,
      });
      expect(actual.handled).toBe(scenario.handled);
      expect(actual.calls).toEqual(scenario.calls);
      expect(actual.responseAfterPump).toEqual(maskFixtureResponse(scenario.response_after_pump));
      expect(actual.stateAfterPump).toEqual({
        ...scenario.state_after_pump,
        pid: MASKED_PID,
        updated_at: MASKED_TIMESTAMP,
      });
      expect(actual.logAfterPump).toEqual(
        scenario.log_after_pump.map((row) => ({ ...row, ts: "iso", duration_ms: "number" })),
      );
      expect(actual.responseAfterResolve).toEqual(maskFixtureResponse(scenario.response_after_resolve));
      expect(actual.notices).toEqual(scenario.notices.map((notice) => maskNotice(notice)));
      expect(actual.stateAfterResolve).toEqual({
        ...scenario.state_after_resolve,
        pid: MASKED_PID,
        updated_at: MASKED_TIMESTAMP,
      });
      expect(actual.logAfterResolve).toEqual(
        scenario.log_after_resolve.map((row) => ({ ...row, ts: "iso", duration_ms: "number" })),
      );
      expect(actual.deferredPending).toBe(scenario.deferred_pending);
    });
  }
});

describe("空闲退出与关闭", () => {
  for (const loop of loops) {
    it(loop.name, async () => {
      const actual = await replayLoop(loop);
      expect(actual.dispatchCalls).toBe(loop.dispatch_calls);
      expect(actual.closed).toBe(loop.closed);
      expect(actual.state).toEqual({ ...loop.state, pid: MASKED_PID, updated_at: MASKED_TIMESTAMP });
      expect(actual.response).toEqual(maskFixtureResponse(loop.response));
    });
  }
});

describe("构造期的坏设置文件", () => {
  it("旧实现直接抛错，TS 版本按「关闭预测」继续", () => {
    const entry = construction[0];
    if (entry === undefined) throw new Error("快照必须记录构造期用例");
    // 旧行为凭据：构造时抛 JSONDecodeError。
    expect(entry.raised).toBe("JSONDecodeError");

    const paths = appPaths(mkdtempSync(join(tmpdir(), "rime-runtime-")));
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.settings, "{not json", "utf8");
    const runtime = new SidecarRuntime({ paths, pid: 15196 });
    // 读不了设置时退回默认设置（enabled=false），而不是照旧沿用坏文件里的启用状态。
    expect(runtime.settings).toEqual(DEFAULT_SETTINGS);
    expect(runtime.lastState).toBe("ready");
  });
});
