/**
 * 发布 gate 端到端（#27 验收⑥）：干净仓库放行、缺一项就挡下、报告可归档。
 *
 * 这组测试的重点不是「工具能跑」，而是**挡得住**：每条反例都对应票面一条验收标准，
 * 断言 gate 给出 blocked 与具名理由。发布前 gate 唯一不可接受的失败模式是「该挡没挡」。
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { nodeFs } from "../src/release/fs.js";
import { credentialHarness, MIT_MARKERS, runGate } from "../src/release/gate.js";
import { collectLicenseInventory } from "../src/release/licenses.js";
import { parseReleaseArgs, runReleaseCli } from "../src/release/main.js";
import { ARTIFACT_LICENSE, ARTIFACT_NOTICES, SYNTHETIC_CORPUS_MARKERS } from "../src/release/shipset.js";
import { RELEASE_REPORT_SCHEMA } from "../src/release/types.js";
import { EXPECTED_CHECK_IDS, fakeInventory, memoryFs } from "./release-fixtures.js";
import { cleanRepo, FIXTURE_FILES, FIXTURE_PATHS } from "./release-repo-fixture.js";

const FIXED_NOW = 1_700_000_000_000;

/**
 * 夹具里的 `THIRD-PARTY-NOTICES.md` 是真实文件，所以判据必须喂**真实清单**才能对齐：
 * 用假清单会得到「正文与安装树不一致」的假失败。装不上依赖时退回假清单，
 * 门禁的另一半（缺件、泄漏、模板缺段）在那种环境下仍然成立。
 */
function realOrFakeInventory() {
  try {
    return collectLicenseInventory(".", nodeFs);
  } catch {
    return fakeInventory();
  }
}

const INVENTORY = realOrFakeInventory();

function gate(overrides: Record<string, string> = {}, tag = "v0.1.0") {
  const fs = cleanRepo(overrides);
  return runGate({
    root: ".",
    releaseTag: tag,
    fs,
    now: () => FIXED_NOW,
    inventory: () => INVENTORY,
    files: fs.walk("."),
  });
}

function failingIds(report: { readonly checks: readonly { readonly id: string; readonly passed: boolean }[] }): string[] {
  return report.checks.filter((check) => !check.passed).map((check) => check.id);
}

function evidenceOf(
  report: { readonly checks: readonly { readonly id: string; readonly evidence: readonly string[] }[] },
  id: string,
): string {
  return report.checks.find((check) => check.id === id)?.evidence.join("\n") ?? "";
}

describe("干净仓库放行（验收①–⑥）", () => {
  it("verdict=pass，13 条检查齐备且每条都带证据", () => {
    const report = gate();
    expect(report.verdict).toBe("pass");
    expect(failingIds(report)).toEqual([]);
    expect(report.schema).toBe(RELEASE_REPORT_SCHEMA);
    expect(report.releaseTag).toBe("v0.1.0");
    expect(report.generatedAt).toBe(new Date(FIXED_NOW).toISOString());
    expect(report.checks.map((check) => check.id)).toEqual([...EXPECTED_CHECK_IDS]);
    for (const check of report.checks) {
      expect(check.summary.length, `${check.id} 缺摘要`).toBeGreaterThan(0);
      expect(check.evidence.length, `${check.id} 缺证据`).toBeGreaterThan(0);
    }
    expect(report.summary).toEqual({ total: 13, passed: 13, failed: 0 });
  });

  it("报告自带机器可读的归档面：许可证清单、发布物摘要、扫描计数、notes 判据", () => {
    const report = gate();
    expect(report.licenses.map((entry) => entry.role)).toContain("embedded-runtime");
    expect(report.shipSet.fileCount).toBe(2);
    expect(report.shipSet.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(report.shipSet.exclusions).toContain("reference/");
    expect(report.credentials.filesScanned).toBeGreaterThan(0);
    expect(report.releaseNotes.checks).toHaveLength(11);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("扫描器自证：反例必被抓到、干净样本必被放行", () => {
    const harness = credentialHarness();
    expect(harness.passed).toBe(true);
    expect(harness.detail).toContain("反例被抓到");
  });
});

describe("该挡就挡（逐条反例）", () => {
  it("缺 LICENSE（或其正文不是 MIT）→ 挡下", () => {
    const missing = gate({ "LICENSE": "" });
    expect(missing.verdict).toBe("blocked");
    expect(failingIds(missing)).toContain("policy.own-license");
    expect(evidenceOf(missing, "policy.own-license")).toContain(MIT_MARKERS[1] ?? "");
  });

  it("fork 的 GPL-3 正文副本缺失 → 挡下", () => {
    const report = gate({ "docs/license/GPL-3.0.txt": "not a license" });
    expect(report.verdict).toBe("blocked");
    expect(failingIds(report)).toContain("policy.fork-license");
  });

  it("第三方声明与安装树漂移 → 挡下（许可证正文不可少）", () => {
    const report = gate({ "THIRD-PARTY-NOTICES.md": "## koffi 2.16.3\n\n（正文被我删了）\n" });
    expect(report.verdict).toBe("blocked");
    expect(failingIds(report)).toContain("policy.own-license");
    expect(evidenceOf(report, "policy.own-license")).toContain("缺少条目");
  });

  it("生产代码新增一处凭据字样 → 挡下（含规则没覆盖过的新文件）", () => {
    const baseline = "src/providers/ollama.ts";
    const current = FIXTURE_FILES[baseline] ?? "";
    const report = gate({ [baseline]: `${current}\nconst K = "api_key";\n` });
    expect(report.verdict).toBe("blocked");
    expect(failingIds(report)).toContain("credentials.source-scan");
    expect(evidenceOf(report, "credentials.source-scan")).toContain("api_key");

    // 全新文件没有任何规则覆盖：上界默认 0，出现即违规。
    const fresh = gate({ "src/domain/brand-new.ts": 'export const k = { api_key: "sk-live" };\n' });
    expect(failingIds(fresh)).toContain("credentials.source-scan");
    expect(evidenceOf(fresh, "credentials.source-scan")).toContain("src/domain/brand-new.ts");
  });

  it("完成通知链路出现凭据字样 → 挡下（票面点名的 IPC 出口）", () => {
    const report = gate({ "src/runtime/completion-notify.ts": "export const payload = { api_key: 'x' };\n" });
    expect(report.verdict).toBe("blocked");
    expect(failingIds(report)).toContain("credentials.runtime-boundaries");
    expect(evidenceOf(report, "credentials.runtime-boundaries")).toContain("api_key");
  });

  it("发布文本面被塞进作者路径 → 挡下", () => {
    const report = gate({ "README.md": "# 读我\n\n本机构建路径 D:\\VibeCoding\\RIME-PredictInput\n" });
    expect(report.verdict).toBe("blocked");
    expect(failingIds(report)).toContain("distribution.personal-data");
    expect(evidenceOf(report, "distribution.personal-data")).toContain("personal-path");
  });

  it("评测语料丢了合成声明 → 挡下（词库与个人语料不得进产物）", () => {
    const report = gate({ "src/eval/samples.ts": "export const OUTSIDE_POOL = [];\n" });
    expect(report.verdict).toBe("blocked");
    expect(failingIds(report)).toContain("distribution.synthetic-corpus");
    expect(SYNTHETIC_CORPUS_MARKERS.length).toBeGreaterThan(0);
  });

  it("产物里出现未声明条目、或声明项缺失 → 挡下", () => {
    const stray = gate({ "dist/release/extra-notes.md": "hi\n" });
    expect(stray.verdict).toBe("blocked");
    expect(failingIds(stray)).toContain("distribution.ship-set-plan");

    // 缺件用「空文件」造不出来（空串仍然是存在），所以直接构造一个没有产物的世界。
    const empty = runGate({
      root: ".",
      releaseTag: "v0.1.0",
      fs: memoryFs({}),
      now: () => FIXED_NOW,
      inventory: () => INVENTORY,
      files: [],
    });
    expect(empty.verdict).toBe("blocked");
    expect(evidenceOf(empty, "distribution.ship-set-plan")).toContain("声明了但不存在");
  });

  it("Release notes 少一段必备内容 → 挡下（缺源码链接同样挡下）", () => {
    const template = FIXTURE_FILES["docs/release-notes-template.md"] ?? "";
    const truncated = { ...cleanRepo(), readText: (path: string) => (path.endsWith("release-notes-template.md") ? "" : cleanRepo().readText(path)) };
    const report = runGate({
      root: ".",
      releaseTag: "v0.1.0",
      fs: truncated,
      now: () => FIXED_NOW,
      inventory: () => INVENTORY,
      files: truncated.walk("."),
    });
    expect(report.verdict).toBe("blocked");
    expect(failingIds(report)).toContain("notes.required-content");
    expect(evidenceOf(report, "notes.required-content")).toContain("sidecar-variants");
    expect(template.length).toBeGreaterThan(0);

    const noFork = gate({ "docs/fork/release-template.md": "（空的 fork 模板）\n" });
    expect(failingIds(noFork)).toContain("notes.required-content");
    expect(evidenceOf(noFork, "notes.required-content")).toContain("fork-base");
  });
});

describe("夹具同形（防止测试世界与真实世界分叉）", () => {
  it("逐条与磁盘上的真实文件一致", () => {
    expect(FIXTURE_PATHS.length).toBeGreaterThan(10);
    for (const relative of FIXTURE_PATHS) {
      const onDisk = nodeFs.readText(join(process.cwd(), relative));
      expect(onDisk, `${relative} 磁盘上读不到`).not.toBeNull();
      expect(FIXTURE_FILES[relative], `${relative} 夹具与磁盘不一致（重跑 tools/release/export-fixture.mjs）`).toBe(
        onDisk,
      );
    }
    // 判据真正扫到的源码基线也在夹具里：证明扫描面由规则驱动、不是手工清单。
    expect(FIXTURE_PATHS).toContain("src/runtime/completion-notify.ts");
    expect(FIXTURE_PATHS).toContain("src/providers/ollama.ts");
  });
});

describe("CLI 与归档（验收⑥）", () => {
  it("参数解析：tag 形状受限，未知参数与命令直接报错", () => {
    expect(parseReleaseArgs(["check"])).toEqual({ command: "check", tag: "v0.1.0", write: false });
    expect(parseReleaseArgs(["check", "--tag", "v0.1.0.3"]).tag).toBe("v0.1.0.3");
    expect(() => parseReleaseArgs(["check", "--tag", "0.1"])).toThrow(/--tag/);
    expect(() => parseReleaseArgs(["deploy"])).toThrow(/无法识别的命令/);
    expect(() => parseReleaseArgs(["check", "--force"])).toThrow(/无法识别的参数/);
  });

  it("用法错误退出码 2；被挡下退出码 1（含逐条理由）", () => {
    const usageErrors: string[] = [];
    const originalStderr = process.stderr.write.bind(process.stderr);
    try {
      process.stderr.write = ((chunk: string) => {
        usageErrors.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      expect(runReleaseCli(["deploy"], ".")).toBe(2);
      expect(usageErrors.join("")).toContain("无法识别的命令");
    } finally {
      process.stderr.write = originalStderr;
    }

    const captured = memoryFs({});
    const originalStdout = process.stdout.write.bind(process.stdout);
    try {
      process.stdout.write = (() => true) as typeof process.stdout.write;
      const fs = cleanRepo({ "LICENSE": "（不是 MIT 正文）\n" });
      const code = runReleaseCli(["check", "--tag", "v0.1.0"], ".", {
        fs: { ...fs, writeText: (path, text) => captured.writeText(path, text) },
        now: () => FIXED_NOW,
        inventory: () => INVENTORY,
      });
      expect(code).toBe(1);
      const printed = captured.readText("dist/release-archive/release-report.json") ?? "{}";
      expect((JSON.parse(printed) as { verdict?: string }).verdict).toBe("blocked");
    } finally {
      process.stdout.write = originalStdout;
    }
  });

  it("check PASS 时退出码 0，并把报告与许可证清单写进产物（机器可读归档）", () => {
    const io = memoryFs({});
    const stdout: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    const fs = cleanRepo();
    try {
      process.stdout.write = ((chunk: string) => {
        stdout.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      const code = runReleaseCli(["check", "--tag", "v0.1.0"], ".", {
        fs: { ...fs, writeText: (path, text) => io.writeText(path, text) },
        now: () => FIXED_NOW,
        inventory: () => INVENTORY,
      });
      expect(code).toBe(0);
      expect(stdout.join("")).toContain("PASS v0.1.0");
    } finally {
      process.stdout.write = original;
    }
    const report = JSON.parse(io.readText("dist/release-archive/release-report.json") ?? "{}") as { verdict?: string };
    expect(report.verdict).toBe("pass");
    const inventory = JSON.parse(io.readText("dist/release-archive/licenses.json") ?? "{}") as { entries?: readonly unknown[] };
    expect(inventory.entries?.length).toBe(7);
  });

  it("产物目录是 stage 的落点（声明与常量一致）", () => {
    expect(ARTIFACT_LICENSE.startsWith("dist/release/")).toBe(true);
    expect(ARTIFACT_NOTICES.startsWith("dist/release/")).toBe(true);
    for (const path of [ARTIFACT_LICENSE, ARTIFACT_NOTICES]) {
      expect(nodeFs.readText(join(process.cwd(), path))).not.toBeNull();
    }
  });
});




