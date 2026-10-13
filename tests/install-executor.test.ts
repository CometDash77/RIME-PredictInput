/**
 * 执行器薄壳（S8/#26 验收标准③）的离线断言面。
 *
 * 端口全部是假的：执行器只按清单动手，把这些断言钉在「排序」「失败即停」「终止守卫」
 * 三件事上，不碰文件系统也不碰进程表。
 */
import { describe, expect, it } from "vitest";

import type { InstallOp, InstallPlan } from "../src/domain/install-plan.js";
import type { InstallExecutorPorts } from "../src/install/executor.js";
import { executePlan } from "../src/install/executor.js";

const ROOT = "C:\\Program Files\\Rime\\weasel-0.17.4";
const FRONT = `${ROOT}\\WeaselTSF.dll`;
const FEATURE = `${ROOT}\\predict`;
const SIDE_CONSOLE = `${FEATURE}\\rime-predict-sidecar.exe`;
const SIDE_WINDOW = `${FEATURE}\\rime-predict-sidecar-gui.exe`;
const STRAY = `${ROOT}\\install.tmp`;
const STATUS = "C:\\Users\\u\\.rime-model-predict\\status.json";
const D = "aa".repeat(32);
const GUIDE = "本插件替换了 Weasel（小狼毫）前端。";

const plan = (ops: readonly InstallOp[]): InstallPlan => ({ ops, keeps: [] });

interface RecorderOptions {
  readonly pid?: number | null;
  readonly image?: string | null;
  readonly failOn?: string;
}

interface Recorder {
  readonly calls: string[];
  readonly ports: InstallExecutorPorts;
}

function recorder(options: RecorderOptions = {}): Recorder {
  const calls: string[] = [];
  const note = (label: string): void => {
    calls.push(label);
    if (options.failOn === label) throw new Error("io failed: " + label);
  };
  const ports: InstallExecutorPorts = {
    writeArtifact: async (write) => note("write:" + write.path),
    removeFile: async (path) => note("delete:" + path),
    removeTree: async (path) => note("delete-tree:" + path),
    registerTsf: async (path) => note("register:" + path),
    unregisterTsf: async (path) => note("unregister:" + path),
    readSidecarPid: async (statusFile) => {
      calls.push("read-pid:" + statusFile);
      return options.pid ?? null;
    },
    processImage: async (pid) => {
      calls.push("image:" + String(pid));
      return options.image ?? null;
    },
    stopProcess: async (pid, image) => {
      calls.push("stop:" + String(pid) + ":" + image);
    },
  };
  return { calls, ports };
}

describe("排序：稳定且不重排语义阶段", () => {
  it("同种操作按路径升序，不依赖清单给的次序", async () => {
    const r = recorder();
    const result = await executePlan(
      plan([
        { kind: "write", path: SIDE_WINDOW, digest: D },
        { kind: "write", path: FRONT, digest: D },
        { kind: "write", path: SIDE_CONSOLE, digest: D },
      ]),
      r.ports,
    );
    // 码位序：大写 W（0x57）在小写 p（0x70）前，连字符（0x2D）在点号（0x2E）前。
    // 区域序会把这些顺序换个位置，所以这里钉的是「确定」，不是「好看」。
    expect(r.calls).toEqual(["write:" + FRONT, "write:" + SIDE_WINDOW, "write:" + SIDE_CONSOLE]);
    expect(result.completed).toBe(true);
  });

  it("种类之间沿用清单里首次出现的次序：卸载的语义阶段不会被打散", async () => {
    const r = recorder();
    await executePlan(
      plan([
        { kind: "write", path: FRONT, digest: D },
        { kind: "delete", path: STRAY },
        { kind: "write", path: SIDE_CONSOLE, digest: D },
      ]),
      r.ports,
    );
    expect(r.calls).toEqual(["write:" + FRONT, "write:" + SIDE_CONSOLE, "delete:" + STRAY]);
  });

  it("每个操作只交给端口一次：不复查摘要、不做第二次决策", async () => {
    const r = recorder();
    const result = await executePlan(
      plan([
        { kind: "write", path: FRONT, digest: D },
        { kind: "delete", path: STRAY },
        { kind: "delete-tree", path: FEATURE },
        { kind: "register", path: FRONT },
        { kind: "unregister", path: FRONT },
      ]),
      r.ports,
    );
    expect(r.calls).toEqual([
      "write:" + FRONT,
      "delete:" + STRAY,
      "delete-tree:" + FEATURE,
      "register:" + FRONT,
      "unregister:" + FRONT,
    ]);
    expect(result.applied).toBe(5);
  });
});

describe("失败即停，保留已完成", () => {
  it("第一个失败即停，失败步骤原样记录，IO 失败可原样重试", async () => {
    const r = recorder({ failOn: "write:" + SIDE_CONSOLE });
    const result = await executePlan(
      plan([
        { kind: "write", path: FRONT, digest: D },
        { kind: "write", path: SIDE_CONSOLE, digest: D },
        { kind: "write", path: SIDE_WINDOW, digest: D },
      ]),
      r.ports,
    );
    expect(result.completed).toBe(false);
    expect(result.applied).toBe(2);
    expect(result.failed?.op).toEqual({ kind: "write", path: SIDE_CONSOLE, digest: D });
    expect(result.failed?.kind).toBe("io");
    expect(result.failed?.message).toBe("io failed: write:" + SIDE_CONSOLE);
    expect(result.retryable).toBe(true);
    // 排在失败步骤之后的都没执行：它们的前提是前面已经成功。
    expect(r.calls).toEqual(["write:" + FRONT, "write:" + SIDE_WINDOW, "write:" + SIDE_CONSOLE]);
  });

  it("已经收集到的还原指引照样交回调用方", async () => {
    const r = recorder({ failOn: "write:" + FRONT });
    const result = await executePlan(
      plan([
        { kind: "guide", text: GUIDE },
        { kind: "write", path: FRONT, digest: D },
      ]),
      r.ports,
    );
    expect(result.guide).toEqual([GUIDE]);
    expect(result.applied).toBe(1);
    expect(result.completed).toBe(false);
  });
});

describe("终止伴随进程的守卫", () => {
  it("校验通过才终止：大小写与斜杠写法不同不算外人", async () => {
    const observed = "C:/PROGRAM FILES/Rime/weasel-0.17.4/predict/Rime-Predict-Sidecar.exe";
    const r = recorder({ pid: 4242, image: observed });
    const result = await executePlan(
      plan([{ kind: "stop-sidecar", statusFile: STATUS, images: [SIDE_CONSOLE, SIDE_WINDOW] }]),
      r.ports,
    );
    expect(result.completed).toBe(true);
    expect(r.calls).toEqual(["read-pid:" + STATUS, "image:4242", "stop:4242:" + observed]);
  });

  it("映像对不上：绝不终止，交回给人手动退出，且不算可重试", async () => {
    const r = recorder({ pid: 4242, image: "C:\\Windows\\System32\\notepad.exe" });
    const result = await executePlan(
      plan([{ kind: "stop-sidecar", statusFile: STATUS, images: [SIDE_CONSOLE, SIDE_WINDOW] }]),
      r.ports,
    );
    expect(result.completed).toBe(false);
    expect(result.failed?.kind).toBe("sidecar-manual");
    expect(result.retryable).toBe(false);
    expect(result.failed?.message).toContain("手动退出");
    expect(result.failed?.message).toContain("4242");
    expect(r.calls.filter((call) => call.startsWith("stop:"))).toEqual([]);
  });

  it("status.json 没有可用 pid：视为没有可终止的进程，不猜", async () => {
    const r = recorder({ pid: null, image: "C:\\Windows\\System32\\notepad.exe" });
    const result = await executePlan(
      plan([{ kind: "stop-sidecar", statusFile: STATUS, images: [SIDE_CONSOLE] }]),
      r.ports,
    );
    expect(result.completed).toBe(true);
    expect(r.calls).toEqual(["read-pid:" + STATUS]);
  });

  it("进程已经不在了：跳过终止，卸载继续走完", async () => {
    const r = recorder({ pid: 4242, image: null });
    const result = await executePlan(
      plan([
        { kind: "stop-sidecar", statusFile: STATUS, images: [SIDE_CONSOLE] },
        { kind: "delete", path: SIDE_CONSOLE },
      ]),
      r.ports,
    );
    expect(result.completed).toBe(true);
    expect(r.calls).toEqual(["read-pid:" + STATUS, "image:4242", "delete:" + SIDE_CONSOLE]);
  });
});

describe("结果口径", () => {
  it("还原指引不落 IO：文本交给调用方呈现，applied 计全部步骤", async () => {
    const r = recorder();
    const result = await executePlan(
      plan([
        { kind: "unregister", path: FRONT },
        { kind: "delete", path: FRONT },
        { kind: "guide", text: GUIDE },
      ]),
      r.ports,
    );
    expect(result.completed).toBe(true);
    expect(result.applied).toBe(3);
    expect(result.retryable).toBe(false);
    expect(result.guide).toEqual([GUIDE]);
    expect(result.failed).toBeUndefined();
    expect(r.calls).toEqual(["unregister:" + FRONT, "delete:" + FRONT]);
  });
});
