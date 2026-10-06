/**
 * 设置入口的返回码与启动流程。返回码是「模型预测设置」快捷方式与安装脚本之间的契约
 * （0 成功、2 缺伴随进程、3 起不来、4 超时、5 打不开浏览器），所以这里逐条锁住，
 * 并把「先问已在运行的服务、再回落启动、再轮询」这个顺序固定下来。
 */
import { describe, expect, it } from "vitest";

import { runSelftest } from "../src/cli/selftest.js";
import {
  LAUNCHER_MESSAGES,
  SETTINGS_BASE_URL,
  openSettingsSession,
  type SettingsLauncherOptions,
  type SidecarProcess,
} from "../src/web/launcher.js";

const TOKEN = "t".repeat(43);
const SCRIPT = "C:/app/cli/main.js";

interface Trace {
  readonly opened: string[];
  readonly launched: Array<{ readonly script: string; readonly token: string }>;
  readonly errors: string[];
  readonly sleeps: number[];
}

interface HarnessOptions {
  readonly mainScript?: string | null;
  readonly sessionAnswers?: readonly boolean[];
  readonly openWorks?: boolean;
  readonly spawnFails?: boolean;
  readonly processExits?: boolean;
}

function harness(options: HarnessOptions): { readonly trace: Trace; readonly run: () => Promise<number> } {
  const trace: Trace = { opened: [], launched: [], errors: [], sleeps: [] };
  const answers = [...(options.sessionAnswers ?? [true])];
  let now = 100;

  const settings: SettingsLauncherOptions = {
    mainScript: options.mainScript === undefined ? SCRIPT : options.mainScript,
    token: TOKEN,
    startSession: () => Promise.resolve(answers.shift() ?? false),
    openBrowser: (url: string) => {
      trace.opened.push(url);
      return options.openWorks ?? true;
    },
    spawnSidecar: (script: string, token: string): SidecarProcess | null => {
      if (options.spawnFails === true) return null;
      trace.launched.push({ script, token });
      return { exited: (): boolean => options.processExits ?? false };
    },
    showError: (message: string) => {
      trace.errors.push(message);
    },
    now: () => now,
    sleep: (seconds: number) => {
      trace.sleeps.push(seconds);
      now += seconds;
      return Promise.resolve();
    },
  };

  return { trace, run: () => openSettingsSession(settings) };
}

describe("settings launcher", () => {
  it("opens the browser when a sidecar already answers", async () => {
    const { trace, run } = harness({ sessionAnswers: [true] });
    expect(await run()).toBe(0);
    expect(trace.opened).toEqual([`${SETTINGS_BASE_URL}/#${TOKEN}`]);
    expect(trace.launched).toEqual([]);
    expect(trace.errors).toEqual([]);
  });

  it("reports an entry point that is not installed", async () => {
    const { trace, run } = harness({ mainScript: null });
    expect(await run()).toBe(2);
    expect(trace.errors).toEqual([LAUNCHER_MESSAGES.missingSidecar]);
  });

  it("reports a browser that refuses to open", async () => {
    const { trace, run } = harness({ sessionAnswers: [true, true], openWorks: false });
    expect(await run()).toBe(5);
    expect(trace.errors).toEqual([LAUNCHER_MESSAGES.browserFailed]);
    expect(trace.launched).toEqual([]);
  });

  it("reports a sidecar that could not be spawned", async () => {
    const { trace, run } = harness({ sessionAnswers: [false], spawnFails: true });
    expect(await run()).toBe(3);
    expect(trace.errors).toEqual([LAUNCHER_MESSAGES.spawnFailed]);
    expect(trace.launched).toEqual([]);
  });

  it("spawns a hidden sidecar and gives up after the start timeout", async () => {
    const { trace, run } = harness({ sessionAnswers: [false], processExits: false });
    expect(await run()).toBe(4);
    expect(trace.errors).toEqual([LAUNCHER_MESSAGES.startFailed]);
    expect(trace.launched).toEqual([{ script: SCRIPT, token: TOKEN }]);
    expect(trace.sleeps.every((seconds) => seconds === 0.1)).toBe(true);
    expect(trace.sleeps.length).toBeGreaterThan(0);
  });

  it("polls faster while the sidecar has exited", async () => {
    const { trace, run } = harness({ sessionAnswers: [false], processExits: true });
    expect(await run()).toBe(4);
    expect(trace.sleeps.every((seconds) => seconds === 0.15)).toBe(true);
  });

  it("opens the browser once the spawned sidecar starts answering", async () => {
    const { trace, run } = harness({ sessionAnswers: [false, false, true] });
    expect(await run()).toBe(0);
    expect(trace.opened).toEqual([`${SETTINGS_BASE_URL}/#${TOKEN}`]);
    // 先试已在运行的服务（第 1 次失败）→ 启动 → 第 2 次失败后睡 0.1 秒 → 第 3 次成功。
    expect(trace.sleeps).toEqual([0.1]);
  });
});

describe("selftest", () => {
  it("runs the offline boundary checks green", async () => {
    expect(await runSelftest()).toBe(0);
  });
});
