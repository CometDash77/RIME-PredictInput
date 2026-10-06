/**
 * 打开一个带令牌的设置会话；必要时先把按需伴随进程拉起来。
 *
 * 旧实现是 `settings_launcher.py`：先试着向已在运行的回环服务要一个会话；拿不到就
 * 无窗口启动伴随进程，8 秒内每 0.1/0.15 秒重试一次，然后把用户浏览器指到
 * `http://127.0.0.1:48371/#<token>`。返回码保持不变（0 成功、2 缺伴随进程文件、
 * 3 启动失败、4 超时、5 打不开浏览器），因为安装脚本与快捷方式依赖它们。
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { showNativeAlert } from "./native-alert.js";
import { HOST, PORT } from "./settings-host.js";

export const SETTINGS_BASE_URL = `http://${HOST}:${PORT}`;
export const SESSION_TIMEOUT_MS = 600;
export const START_TIMEOUT_SECONDS = 8;
export const SIDECAR_POLL_FAST_SECONDS = 0.1;
export const SIDECAR_POLL_EXITED_SECONDS = 0.15;

export const LAUNCHER_MESSAGES = {
  missingSidecar: "找不到模型预测伴随进程文件。请重新安装模型预测设置入口。",
  browserFailed: "设置服务已启动，但无法打开浏览器。请设置默认浏览器后重新打开模型预测设置。",
  spawnFailed: "无法启动模型预测设置服务。请检查 Node 运行时和快捷方式路径。",
  startFailed: "设置服务未能启动。请确认 RIME 文件完整，并确认本机端口没有被其他程序占用。",
} as const;

export interface SidecarProcess {
  readonly exited: () => boolean;
}

export interface SettingsLauncherOptions {
  /** 伴随进程入口；默认解析同目录下的 `../cli/main.js`（开发时退回 `.ts`）。 */
  readonly mainScript?: string | null;
  readonly token?: string;
  readonly startSession?: (token: string) => Promise<boolean>;
  readonly openBrowser?: (url: string) => boolean;
  readonly spawnSidecar?: (script: string, token: string) => SidecarProcess | null;
  readonly showError?: (message: string) => void;
  readonly now?: () => number;
  readonly sleep?: (seconds: number) => Promise<void>;
}

/** 旧实现用 `MAIN.is_file()` 判断入口是否就位。 */
export function defaultMainScript(): string | null {
  for (const relative of ["../cli/main.js", "../cli/main.ts"]) {
    const candidate = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function defaultStartSession(token: string): Promise<boolean> {
  try {
    const response = await fetch(SETTINGS_BASE_URL + "/session", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

function defaultOpenBrowser(url: string): boolean {
  const commands: readonly (readonly [string, readonly string[]])[] =
    process.platform === "win32"
      ? [["cmd", ["/c", "start", "", url]]]
      : process.platform === "darwin"
        ? [["open", [url]]]
        : [["xdg-open", [url]]];
  for (const [command, args] of commands) {
    try {
      const result = spawnSync(command, [...args], { stdio: "ignore", windowsHide: true });
      return result.error === undefined && result.status === 0;
    } catch {
      return false;
    }
  }
  return false;
}

function defaultSpawnSidecar(script: string, token: string): SidecarProcess | null {
  try {
    const child = spawn(process.execPath, [script, "--source", "settings", "--token", token], {
      cwd: dirname(script),
      stdio: "ignore",
      windowsHide: true,
      detached: true,
    });
    child.unref();
    return { exited: (): boolean => child.exitCode !== null || child.signalCode !== null };
  } catch {
    return null;
  }
}

export async function openSettingsSession(options: SettingsLauncherOptions = {}): Promise<number> {
  const startSession = options.startSession ?? defaultStartSession;
  const openBrowser = options.openBrowser ?? defaultOpenBrowser;
  const spawnSidecar = options.spawnSidecar ?? defaultSpawnSidecar;
  const showError = options.showError ?? showNativeAlert;
  const now = options.now ?? ((): number => Date.now() / 1000);
  const sleep = options.sleep ?? ((seconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, seconds * 1000)));

  const script = options.mainScript === undefined ? defaultMainScript() : options.mainScript;
  if (script === null) {
    showError(LAUNCHER_MESSAGES.missingSidecar);
    return 2;
  }

  const token = options.token ?? randomBytes(32).toString("base64url");
  const openWithToken = (): boolean => openBrowser(SETTINGS_BASE_URL + "/#" + token);

  if (await startSession(token)) {
    if (openWithToken()) return 0;
    showError(LAUNCHER_MESSAGES.browserFailed);
    return 5;
  }

  const process_ = spawnSidecar(script, token);
  if (process_ === null) {
    showError(LAUNCHER_MESSAGES.spawnFailed);
    return 3;
  }

  const deadline = now() + START_TIMEOUT_SECONDS;
  while (now() < deadline) {
    if (await startSession(token)) {
      if (openWithToken()) return 0;
      showError(LAUNCHER_MESSAGES.browserFailed);
      return 5;
    }
    // 已在运行的伴随进程可能赢了启动竞争：它的回环监听就绪后会接受同一个会话。
    await sleep(process_.exited() ? SIDECAR_POLL_EXITED_SECONDS : SIDECAR_POLL_FAST_SECONDS);
  }
  showError(LAUNCHER_MESSAGES.startFailed);
  return 4;
}
