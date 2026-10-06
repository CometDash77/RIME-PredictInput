/**
 * 不依赖 Ollama、不碰用户目录的自检。
 *
 * 它跑的是真实装配：策略身份常量、设置文件的写读往返、文件 IPC 的请求/响应往返、
 * 伴随进程的状态文件与日志，以及空闲退出。用途是让「装好了、能跑、链路是通的」
 * 有一条可重复的命令行证据（`pnpm selftest`）。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRequest } from "../contracts/envelope.js";
import {
  MODEL_DIGEST,
  POLICY_DIGEST,
  VALIDATED_IDENTITY,
  VALIDATED_POLICY_DIGEST,
  identityFor,
} from "../contracts/policy.js";
import { engineId, sequence } from "../domain/ids.js";
import { expectOk, isErr } from "../domain/result.js";
import { DEFAULT_SETTINGS, toWire } from "../domain/settings.js";
import { appPaths } from "../ipc/app-paths.js";
import { isJsonObject } from "../json/guards.js";
import { SidecarRuntime } from "../runtime/runtime.js";
import type { DispatchReply } from "../runtime/dispatch.js";
import { SettingsStore } from "../settings/store.js";

export interface SelfTestReport {
  readonly status: "ok" | "failed";
  readonly checks: readonly string[];
  readonly error?: string;
}

const ENGINE_ID = "0".repeat(40);
/** 自检里的空闲退出用假时钟推进，不真的等 60 秒。 */
const SELFTEST_IDLE_SECONDS = 0.2;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function check(checks: string[], name: string, body: () => void | Promise<void>): Promise<void> {
  await body();
  checks.push(name);
}

function readStatusState(path: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return isJsonObject(parsed) ? parsed["state"] : undefined;
}

export async function runSelftest(): Promise<number> {
  const checks: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "rime-predict-selftest-"));
  try {
    await check(checks, "policy identity matches the frozen evidence", () => {
      assert(POLICY_DIGEST === VALIDATED_POLICY_DIGEST, "policy digest drifted");
      assert(identityFor(MODEL_DIGEST) === VALIDATED_IDENTITY, "model identity drifted");
    });

    const paths = appPaths(root);
    const enabled = { ...DEFAULT_SETTINGS, enabled: true, slot: 5 };

    await check(checks, "settings file round trip", () => {
      const store = new SettingsStore(paths.settings);
      expectOk(
        store.save(enabled),
        (error) => `save failed: ${error}`,
      );
      const loaded = expectOk(
        store.load(),
        (error) => `load failed: ${error}`,
      );
      assert(loaded.enabled, "enabled flag lost");
      assert(loaded.slot === 5, "slot lost");
    });

    await check(checks, "runtime rejects a malformed request envelope", () => {
      const parsed = parseRequest(new TextEncoder().encode('{"version":9}'));
      assert(isErr(parsed) && parsed.error === "unsupported request envelope", "bad envelope accepted");
    });

    let tick = 0;
    const runtime = new SidecarRuntime({
      paths,
      idleSeconds: SELFTEST_IDLE_SECONDS,
      monotonic: (): number => {
        tick += 0.1;
        return tick;
      },
      sleep: async (): Promise<void> => undefined,
      dispatch: async (): Promise<DispatchReply> => ({
        kind: "immediate",
        payload: { status: "ok", eligible: false },
      }),
    });

    await check(checks, "file ipc request/response round trip", () => {
      const published = expectOk(
        runtime.ipc.publishRequest({
          engineId: expectOk(
            engineId(ENGINE_ID),
            (error) => error,
          ),
          seq: expectOk(
            sequence(1),
            (error) => error,
          ),
          kind: "predict",
          payload: { state: { task: "selftest" } },
          now: 1.5,
        }),
        (error) => `publish failed: ${error}`,
      );
      assert(published.requestId.length === 32, "request id shape drifted");
    });

    await check(checks, "runtime pumps one request and writes status/log", async () => {
      const handled = await runtime.pumpOnce();
      assert(handled === 1, `expected one handled request, got ${handled}`);
      const response = expectOk(
        runtime.ipc.readLatestResponse(ENGINE_ID),
        (error) => `read failed: ${error}`,
      );
      if (response === null) throw new Error("no response published");
      assert(response.payload["status"] === "ok", "unexpected response payload");
      assert(readStatusState(paths.status) === "ready", "status file is not ready");
      const lines = readFileSync(paths.log, "utf8").trim().split("\n");
      assert(lines.length === 1, "expected exactly one diagnostic line");
    });

    await runtime.run();
    await check(checks, "runtime exits when idle and reports stopped", () => {
      assert(runtime.lastState === "stopped", `state after run: ${runtime.lastState}`);
    });

    await check(checks, "settings wire shape is stable", () => {
      const wire = toWire(enabled);
      assert(Object.keys(wire)[0] === "enabled", "unexpected wire key order");
      assert(wire["backend"] === "local", "backend drifted");
    });

    process.stdout.write(JSON.stringify({ status: "ok", checks } satisfies SelfTestReport) + "\n");
    return 0;
  } catch (error) {
    const report: SelfTestReport = {
      status: "failed",
      checks,
      error: error instanceof Error ? error.message : "unknown failure",
    };
    process.stdout.write(JSON.stringify(report) + "\n");
    return 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
