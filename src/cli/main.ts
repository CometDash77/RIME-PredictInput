#!/usr/bin/env node
/**
 * 无控制台的伴随进程入口，等价旧实现的 `pythonw main.py`。
 *
 * 参数、返回码与启动顺序都照旧：`--migrate-settings` 只搬设置；`--idle-seconds` 必须
 * 为正；拿不到单实例锁就安静退出；设置页端口被占用时**不能**连预测一起禁用，除非
 * 这次启动本来就是为了设置页。
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { InferenceService } from "../inference/service.js";
import { appPathsForUser } from "../ipc/app-paths.js";
import { LocalBackend } from "../providers/ollama.js";
import { CloudBackend } from "../providers/cloud.js";
import { messengerCompletionNotifier } from "../runtime/completion-notify.js";
import { SingleInstance, SIDECAR_LOCK_FILE } from "../runtime/lifecycle.js";
import { SidecarRuntime } from "../runtime/runtime.js";
import { createWeaselWindowMessenger } from "../runtime/weasel-messenger-koffi.js";
import { migrateLegacySettings } from "../settings/store.js";
import { openSettingsSession } from "../web/launcher.js";
import { SettingsWebHost } from "../web/settings-host.js";
import { runSelftest } from "./selftest.js";

export interface CliArgs {
  readonly source: "lua" | "settings";
  readonly idleSeconds: number;
  readonly token: string | null;
  readonly migrateSettings: boolean;
}

export const USAGE = [
  "用法: rime-predict [--source lua|settings] [--idle-seconds 60] [--token <token>] [--migrate-settings]",
  "       rime-predict selftest",
  "       rime-predict settings",
].join("\n");

export function parseArgs(argv: readonly string[]): CliArgs {
  let source: "lua" | "settings" = "lua";
  let idleSeconds = 60;
  let token: string | null = null;
  let migrateSettings = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--source") {
      const value = argv[index + 1];
      if (value !== "lua" && value !== "settings") throw new Error("--source 只能是 lua 或 settings");
      source = value;
      index += 1;
      continue;
    }
    if (flag === "--idle-seconds") {
      const value = argv[index + 1];
      const parsed = value === undefined ? Number.NaN : Number(value);
      if (!Number.isFinite(parsed)) throw new Error("--idle-seconds 需要一个数字");
      idleSeconds = parsed;
      index += 1;
      continue;
    }
    if (flag === "--token") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--token 需要一个值");
      token = value;
      index += 1;
      continue;
    }
    if (flag === "--migrate-settings") {
      migrateSettings = true;
      continue;
    }
    throw new Error(`无法识别的参数: ${flag ?? ""}`);
  }
  return { source, idleSeconds, token, migrateSettings };
}

export async function runSidecar(args: CliArgs): Promise<number> {
  const paths = appPathsForUser();
  if (args.migrateSettings) {
    migrateLegacySettings(paths);
    return 0;
  }
  if (args.idleSeconds <= 0) return 2;

  const lock = new SingleInstance(join(paths.root, SIDECAR_LOCK_FILE));
  if (!lock.acquire()) return 0;

  let inference: InferenceService | null = null;
  let runtime: SidecarRuntime | null = null;
  let settingsWeb: SettingsWebHost | null = null;
  try {
    // 双通道推理端口（spec #10）：本地 Ollama/兼容端点 + 云端四形态，同一决策契约。
    const service = new InferenceService({ local: new LocalBackend(), cloud: new CloudBackend() });
    inference = service;
    // 完成通知（ADR 0001）：Windows + koffi 就绪时恢复旧行为（预测落盘即刻刷新
    // 候选窗），否则保持「等下一次按键」的降级表现。
    const messenger = createWeaselWindowMessenger();
    const host = new SidecarRuntime({
      paths,
      dispatch: (request, settings) => service.submit(request, settings),
      idleSeconds: args.idleSeconds,
      ...(messenger === null ? {} : { completionNotify: messengerCompletionNotifier(messenger) }),
    });
    runtime = host;
    settingsWeb = new SettingsWebHost({
      inference: service,
      runtime: host,
      initialToken: args.source === "settings" ? args.token : null,
    });
    try {
      await settingsWeb.start();
    } catch {
      // 设置页端口被占用不该影响预测；启动器连不上时会自己告诉用户。
      if (args.source === "settings") return 3;
      settingsWeb = null;
    }
    await runtime.run();
  } finally {
    if (settingsWeb !== null) await settingsWeb.stop();
    if (runtime !== null) runtime.markStopped();
    if (inference !== null) await inference.close();
    lock.close();
  }
  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  if (command === "selftest") return await runSelftest();
  if (command === "settings") return await openSettingsSession();
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  try {
    return await runSidecar(parseArgs(argv));
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : "参数无效") + "\n" + USAGE + "\n");
    return 2;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
