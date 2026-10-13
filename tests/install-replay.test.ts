/**
 * 纯快照重放（S8/#26 验收标准⑦）：真实路径表 + 真实计划 + 执行器，跑在一台全在内存里的机器上。
 *
 * 不依赖时钟、不依赖真实 IO：文件、TSF 注册状态、伴随进程 pid、进程映像全部经注入端口进出，
 * 因此「装上 → 重装幂等」「装到一半被打断 → 自愈」「卸载全清且共享模型留下」这三条
 * 都能在离线断言面上重放。
 */
import { describe, expect, it } from "vitest";

import type {
  EnvironmentSnapshot,
  PayloadArtifact,
  PayloadTarget,
  TsfState,
} from "../src/domain/install-plan.js";
import { planInstall, planUninstall } from "../src/domain/install-plan.js";
import type { InstallExecutorPorts } from "../src/install/executor.js";
import { executePlan } from "../src/install/executor.js";
import { ROLE_FRONTEND, artifactPaths, pathTable } from "../src/install/paths.js";

// 真实路径表：这一层测的就是各层拼起来之后的行为，所以不喂替身路径。
const PATHS = pathTable({
  programFiles: "C:\\Program Files",
  userProfile: "C:\\Users\\u",
  appData: "C:\\Users\\u\\AppData\\Roaming",
});

const FRONT = PATHS.frontend;
const SIDE_CONSOLE = PATHS.sidecars.console;
const STRAY = `${PATHS.programRoot}\\install.tmp`;
const STATUS = PATHS.statusFile;
const DIAG = PATHS.diagnosticsLog;
const SETTINGS = PATHS.settingsFile;
const REQUEST_FILE = `${PATHS.requestsDirectory}\\pending.json`;
const MODEL = "C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\models\\qwen2-7b.gguf";
const MODELS = [MODEL];
const SIDE_IMAGE = "C:/PROGRAM FILES/Rime/weasel-0.17.4/predict/Rime-Predict-Sidecar.exe";

const digests = new Map<string, string>();

/** 确定性摘要：由插入次序推导，绝不掺时钟或随机数。 */
function digestOf(path: string): string {
  const known = digests.get(path);
  if (known !== undefined) return known;
  const made = String(digests.size + 1).padStart(2, "0").repeat(32);
  digests.set(path, made);
  return made;
}

const artifacts: Record<string, PayloadArtifact> = {};
for (const [role, path] of Object.entries(artifactPaths(PATHS))) {
  artifacts[role] = { path, digest: digestOf(path) };
}

const TARGET: PayloadTarget = {
  artifacts,
  frontend: ROLE_FRONTEND,
  transient: [...PATHS.transientPaths],
  preserves: [...PATHS.preservedPaths],
  sidecarStop: PATHS.sidecarStop,
};

const ARTIFACT_PATHS = Object.values(artifacts)
  .map((artifact) => artifact.path)
  .sort();
const ARTIFACT_COUNT = ARTIFACT_PATHS.length;

interface Machine {
  readonly files: Map<string, string | null>;
  readonly calls: string[];
  tsf: TsfState;
  pid: number | null;
  readonly ports: InstallExecutorPorts;
}

/** 一台全在内存里的机器：注册会改写注册权，终止进程会把 pid 清掉。 */
function machine(initial: Record<string, string | null> = {}): Machine {
  const files = new Map<string, string | null>(Object.entries(initial));
  const calls: string[] = [];
  const box: Machine = {
    files,
    calls,
    tsf: "none",
    pid: null,
    ports: {
      writeArtifact: async (write) => {
        calls.push("write:" + write.path);
        files.set(write.path, write.digest);
      },
      removeFile: async (path) => {
        calls.push("delete:" + path);
        files.delete(path);
      },
      removeTree: async (path) => {
        calls.push("delete-tree:" + path);
        for (const key of [...files.keys()]) {
          if (key === path || key.startsWith(path + "\\")) files.delete(key);
        }
      },
      registerTsf: async (path) => {
        calls.push("register:" + path);
        box.tsf = "ours";
      },
      unregisterTsf: async (path) => {
        calls.push("unregister:" + path);
        box.tsf = "none";
      },
      readSidecarPid: async () => box.pid,
      processImage: async (pid) => (box.pid === pid ? SIDE_IMAGE : null),
      stopProcess: async (pid) => {
        calls.push("stop:" + String(pid));
        box.pid = null;
      },
    },
  };
  return box;
}

function snapshotOf(m: Machine): EnvironmentSnapshot {
  const files: Record<string, string | null> = {};
  for (const [path, digest] of m.files) files[path] = digest;
  return {
    files,
    tsf: m.tsf,
    sharedModels: MODELS,
    ...(m.pid === null ? {} : { sidecarPid: m.pid }),
  };
}

describe("幂等重装（验收②）", () => {
  it("第一次装上；第二次规划是空增量，重跑零动作", async () => {
    const m = machine();
    const first = await executePlan(planInstall(snapshotOf(m), TARGET), m.ports);
    expect(first.completed).toBe(true);
    expect(first.applied).toBe(ARTIFACT_COUNT + 1); // 每份产物一次写入 + 一次注册
    expect(m.tsf).toBe("ours");
    expect([...m.files.keys()].sort()).toEqual(ARTIFACT_PATHS);

    const second = planInstall(snapshotOf(m), TARGET);
    expect(second.ops).toEqual([]);
    const rerun = await executePlan(second, m.ports);
    expect(rerun.completed).toBe(true);
    expect(rerun.applied).toBe(0);
  });
});

describe("中断自愈（验收②⑥）", () => {
  it("半写不可读的前端 + 摘要过期的 sidecar + 遗留临时文件：补写、重注册、清遗留", async () => {
    const m = machine({
      [FRONT]: null,
      [SIDE_CONSOLE]: "deadbeef".repeat(8),
      [STRAY]: "deadbeef".repeat(8),
    });
    m.tsf = "ours"; // 注册权还在，但前端已被写坏

    const result = await executePlan(planInstall(snapshotOf(m), TARGET), m.ports);
    expect(result.completed).toBe(true);
    expect(m.calls).toContain("register:" + FRONT);
    expect(m.calls).toContain("delete:" + STRAY);
    expect(m.files.get(FRONT)).toBe(digestOf(FRONT));
    expect(m.files.has(STRAY)).toBe(false);
    expect([...m.files.keys()].sort()).toEqual(ARTIFACT_PATHS);
    // 收敛之后重新规划就是空增量
    expect(planInstall(snapshotOf(m), TARGET).ops).toEqual([]);
  });
});

describe("卸载全清与共享模型保留（验收④⑤）", () => {
  it("固定序：反注册 → 终止伴随进程 → 删自有文件 → 清瞬态 → 还原指引；用户数据与模型留下", async () => {
    const m = machine();
    await executePlan(planInstall(snapshotOf(m), TARGET), m.ports);
    m.files.set(MODEL, "ee".repeat(32));
    m.files.set(SETTINGS, "ff".repeat(32));
    m.files.set(STATUS, "state-ready");
    m.files.set(DIAG, "diagnostics");
    m.files.set(REQUEST_FILE, "pending");
    m.pid = 4242;
    m.calls.length = 0;

    const result = await executePlan(planUninstall(snapshotOf(m), TARGET), m.ports);
    expect(result.completed).toBe(true);
    expect(m.calls.slice(0, 2)).toEqual(["unregister:" + FRONT, "stop:4242"]);

    const deletes = m.calls.filter((call) => call.startsWith("delete:"));
    expect(deletes).toEqual([...deletes].sort()); // 删除阶段按路径升序，可复算
    expect(deletes).toContain("delete:" + STATUS);
    expect(deletes).toContain("delete:" + REQUEST_FILE);
    expect(deletes).toContain("delete:" + DIAG);
    expect(deletes).not.toContain("delete:" + MODEL);
    expect(deletes).not.toContain("delete:" + SETTINGS);

    const trees = m.calls.filter((call) => call.startsWith("delete-tree:"));
    expect(trees).toEqual([...PATHS.transientPaths].sort().map((path) => "delete-tree:" + path));
    expect(result.guide).toHaveLength(1);
    expect([...m.files.keys()].sort()).toEqual([MODEL, SETTINGS].sort());
  });

  it("卸载重跑幂等：只剩瞬态清空这一步，用户数据与模型再动一次也没少", async () => {
    const m = machine();
    await executePlan(planInstall(snapshotOf(m), TARGET), m.ports);
    m.files.set(MODEL, "ee".repeat(32));
    await executePlan(planUninstall(snapshotOf(m), TARGET), m.ports);
    expect(m.tsf).toBe("none");

    const again = planUninstall(snapshotOf(m), TARGET);
    // 瞬态清空是无条件的（对已消失项幂等），所以重跑不是空清单，而是同一份清单。
    expect(again.ops).toEqual(
      [...PATHS.transientPaths].sort().map((path) => ({ kind: "delete-tree", path })),
    );
    const rerun = await executePlan(again, m.ports);
    expect(rerun.completed).toBe(true);
    expect(rerun.applied).toBe(PATHS.transientPaths.length);
    expect([...m.files.keys()].sort()).toEqual([MODEL].sort());
  });
});

describe("还原指引与重放确定性（验收⑦）", () => {
  it("替换官方在场的 Weasel 与卸载自有前端给出同一份文本", async () => {
    const installing = machine({ [FRONT]: "aa".repeat(32) });
    installing.tsf = "official";
    const installed = await executePlan(planInstall(snapshotOf(installing), TARGET), installing.ports);

    const removing = machine();
    removing.tsf = "ours";
    removing.pid = 4242;
    const removed = await executePlan(planUninstall(snapshotOf(removing), TARGET), removing.ports);

    expect(installed.guide).toHaveLength(1);
    expect(installed.guide).toEqual(removed.guide);
    expect(installed.guide[0]).toContain("0.17.4");
  });

  it("同一快照重放两次：端口调用序列逐条相同", async () => {
    const start = { [SIDE_CONSOLE]: "stale", [STRAY]: "dead" };
    const a = machine(start);
    const b = machine(start);
    await executePlan(planInstall(snapshotOf(a), TARGET), a.ports);
    await executePlan(planInstall(snapshotOf(b), TARGET), b.ports);
    a.tsf = "ours";
    b.tsf = "ours";
    await executePlan(planUninstall(snapshotOf(a), TARGET), a.ports);
    await executePlan(planUninstall(snapshotOf(b), TARGET), b.ports);
    expect(a.calls).toEqual(b.calls);
    expect([...a.files.keys()].sort()).toEqual([...b.files.keys()].sort());
  });
});
