/**
 * 安装计划接缝（spec #10 Testing Decisions）的离线断言面：
 * - 幂等重装 = 空增量（目标齐、注册在手 → ops 为空）。
 * - 卸载全清 + 保留共享模型（keeps 与写/删永不相交）。
 * - 还原指引生成（替换官方在场或卸载自有前端才出现，文本确定）。
 * - 中断自愈（缺的补写、遗留清掉）。
 * 全部纯快照重放，不查盘；路径表只作为参数注入，计划不编造路径。
 */
import { describe, expect, it } from "vitest";

import type {
  EnvironmentSnapshot,
  InstallOp,
  PayloadTarget,
  TsfState,
} from "../src/domain/install-plan.js";
import { planInstall, planUninstall } from "../src/domain/install-plan.js";

// 注入路径表（测试替身）：最终路径归架构票，这里只验证决策逻辑。
const ROOT = "C:\\Program Files\\RimeModelPredict";
const SIDE = `${ROOT}\\rime-predict.exe`;
const FRONT = `${ROOT}\\weasel\\WeaselTSF.dll`;
const LUA = `${ROOT}\\lua\\rime-predict.lua`;
const MODEL = "C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\models\\qwen2-7b.gguf";

const D_SIDE = "aa".repeat(32);
const D_FRONT = "bb".repeat(32);
const D_LUA = "cc".repeat(32);

const TARGET: PayloadTarget = {
  artifacts: {
    sidecar: { path: SIDE, digest: D_SIDE },
    frontend: { path: FRONT, digest: D_FRONT },
    lua: { path: LUA, digest: D_LUA },
  },
  frontend: "frontend",
};

const MODELS = [MODEL];

function snapshot(
  files: Record<string, string | null>,
  tsf: TsfState,
  sharedModels: readonly string[] = MODELS,
): EnvironmentSnapshot {
  return { files, tsf, sharedModels };
}

function guideOf(ops: readonly InstallOp[]): string {
  for (const op of ops) {
    if (op.kind === "guide") return op.text;
  }
  throw new Error("plan has no guide op");
}

const deletePaths = (ops: readonly InstallOp[]): string[] =>
  ops.filter((op): op is Extract<InstallOp, { kind: "delete" }> => op.kind === "delete").map((op) => op.path);

describe("planInstall", () => {
  it("全新安装：全部写入 + 注册，无还原指引，共享模型只进保留清单", () => {
    const plan = planInstall(snapshot({}, "none"), TARGET);
    expect(plan.ops).toEqual([
      { kind: "write", path: LUA, digest: D_LUA },
      { kind: "write", path: SIDE, digest: D_SIDE },
      { kind: "write", path: FRONT, digest: D_FRONT },
      { kind: "register", path: FRONT },
    ]);
    expect(plan.keeps).toEqual(MODELS);
  });

  it("幂等重装 = 空增量：目标齐、注册在手、无遗留 → ops 为空", () => {
    const plan = planInstall(
      snapshot({ [SIDE]: D_SIDE, [FRONT]: D_FRONT, [LUA]: D_LUA }, "ours"),
      TARGET,
    );
    expect(plan.ops).toEqual([]);
    expect(plan.keeps).toEqual(MODELS);
  });

  it("升级：摘要不一致的重写，一致的跳过；前端重写触发重注册", () => {
    const plan = planInstall(
      snapshot({ [SIDE]: "11".repeat(32), [FRONT]: "22".repeat(32), [LUA]: D_LUA }, "ours"),
      TARGET,
    );
    expect(plan.ops).toEqual([
      { kind: "write", path: SIDE, digest: D_SIDE },
      { kind: "write", path: FRONT, digest: D_FRONT },
      { kind: "register", path: FRONT },
    ]);
  });

  it("替换官方：注册 + 确定文本的还原指引", () => {
    const plan = planInstall(snapshot({}, "official"), TARGET);
    expect(plan.ops.filter((op) => op.kind === "register")).toEqual([
      { kind: "register", path: FRONT },
    ]);
    const guide = guideOf(plan.ops);
    expect(guide).toContain("0.17.4");
    expect(guide).toContain("https://github.com/rime/weasel/releases");
    expect(guide).toContain("方案与词库未被改动");
  });

  it("中断自愈：半写不可读的前端补写并重注册，遗留临时文件清掉", () => {
    const tmp = `${ROOT}\\sidecar.pkg.tmp`;
    const plan = planInstall(
      snapshot({ [FRONT]: null, [LUA]: D_LUA, [SIDE]: D_SIDE, [tmp]: "dead" }, "ours"),
      TARGET,
    );
    expect(plan.ops).toEqual([
      { kind: "write", path: FRONT, digest: D_FRONT },
      { kind: "delete", path: tmp },
      { kind: "register", path: FRONT },
    ]);
  });

  it("frontend 角色缺失：不产生注册/反注册操作，其余决策照常", () => {
    const bare: PayloadTarget = {
      artifacts: { sidecar: { path: SIDE, digest: D_SIDE } },
      frontend: "missing",
    };
    const install = planInstall(snapshot({}, "none"), bare);
    expect(install.ops).toEqual([{ kind: "write", path: SIDE, digest: D_SIDE }]);
    const uninstall = planUninstall(snapshot({ [SIDE]: D_SIDE }, "none"), bare);
    expect(uninstall.ops).toEqual([{ kind: "delete", path: SIDE }]);
  });
});

describe("planUninstall", () => {
  it("卸载全清：反注册 + 全部自有文件删除 + 还原指引；共享模型只进保留清单", () => {
    const plan = planUninstall(
      snapshot({ [SIDE]: D_SIDE, [FRONT]: D_FRONT, [LUA]: D_LUA }, "ours"),
      TARGET,
    );
    expect(plan.ops).toEqual([
      { kind: "unregister", path: FRONT },
      { kind: "delete", path: LUA },
      { kind: "delete", path: SIDE },
      { kind: "delete", path: FRONT },
      { kind: "guide", text: expect.any(String) },
    ]);
    expect(plan.keeps).toEqual(MODELS);
  });

  it("共享模型即便被误扫进快照也绝不出现在删除清单（保留清单防线）", () => {
    const plan = planUninstall(snapshot({ [SIDE]: D_SIDE, [MODEL]: "ee".repeat(32) }, "ours"), TARGET);
    expect(deletePaths(plan.ops)).toEqual([SIDE]);
    expect(plan.keeps).toEqual(MODELS);
  });

  it("官方在场时卸载：不反注册、无还原指引，自有文件照删", () => {
    const plan = planUninstall(snapshot({ [SIDE]: D_SIDE, [LUA]: D_LUA }, "official"), TARGET);
    expect(plan.ops).toEqual([
      { kind: "delete", path: LUA },
      { kind: "delete", path: SIDE },
    ]);
  });
});

describe("还原指引与路径不变量", () => {
  it("指引文本确定：安装替换官方与卸载自有前端共用同一份", () => {
    const a = guideOf(planInstall(snapshot({}, "official"), TARGET).ops);
    const b = guideOf(planUninstall(snapshot({}, "ours"), TARGET).ops);
    expect(a).toBe(b);
  });

  it("计划里的每个路径都来自快照或目标清单；keeps 与写/删永不相交", () => {
    const scenarios: { files: Record<string, string | null>; tsf: TsfState }[] = [
      { files: {}, tsf: "none" },
      { files: { [SIDE]: D_SIDE, [FRONT]: D_FRONT, [LUA]: D_LUA }, tsf: "ours" },
      { files: { [FRONT]: null, [`${ROOT}\\stray.tmp`]: "ab" }, tsf: "official" },
    ];
    const known = new Set([SIDE, FRONT, LUA]);
    for (const scenario of scenarios) {
      const snap = snapshot(scenario.files, scenario.tsf);
      for (const plan of [planInstall(snap, TARGET), planUninstall(snap, TARGET)]) {
        for (const op of plan.ops) {
          if (op.kind === "guide") continue;
          if (op.kind === "write" || op.kind === "delete") {
            expect(plan.keeps).not.toContain(op.path);
          }
          expect(known.has(op.path) || scenario.files[op.path] !== undefined).toBe(true);
        }
      }
    }
  });
});
