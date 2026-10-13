/**
 * 凭据 / 个人数据 / 发布物清单 / Release notes（#27 验收③④⑤）。
 *
 * 每一组判据都配一个**反例**：只证明「干净样本通过」是不够的，必须同时证明「该报的
 * 能报出来」，否则扫描器只是一段永远返回 true 的代码。
 */
import { describe, expect, it } from "vitest";

import { BOUNDARY_RULES, CREDENTIAL_RULES, PERSONAL_PATTERNS, SHIP_SET_FORBIDDEN_TOKENS } from "../src/release/credential-policy.js";
import {
  countOccurrences,
  matchPatterns,
  scanBoundaryRules,
  scanCredentialBaseline,
  scanNoticesProvenance,
  scanPersonalData,
  scanShipSet,
} from "../src/release/credential-scan.js";
import {
  ARTIFACT_LICENSE,
  ARTIFACT_NOTICES,
  collectShipSet,
  EXCLUDED_FILES,
  EXCLUDED_PREFIXES,
  isExcluded,
  SHIP_SET_ENTRIES,
} from "../src/release/shipset.js";
import { checkReleaseNotes, NOTE_REQUIREMENTS, readReleaseNotes, releaseNotesReport } from "../src/release/release-notes.js";
import { memoryFs } from "./release-fixtures.js";
import { cleanRepo, FIXTURE_FILES } from "./release-repo-fixture.js";

const realFs = cleanRepo();
/** 扫描面由**规则**驱动（基线文件 + 边界文件），不是手工清单。 */
const SOURCE_FILES = [
  ...new Set([...CREDENTIAL_RULES.map((rule) => rule.path), ...BOUNDARY_RULES.map((rule) => rule.path)]),
].sort();

describe("扫描原语", () => {
  it("计数大小写不敏感、互不重叠", () => {
    expect(countOccurrences("API_KEY api_key Api_Key", "api_key")).toBe(3);
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("nothing", "api_key")).toBe(0);
    expect(countOccurrences("anything", "")).toBe(0);
  });

  it("模式匹配给出规则 id，便于把失败落到具名判据上", () => {
    expect(matchPatterns("path C:\\Users\\tester\\x", PERSONAL_PATTERNS)).toContain("personal-path");
    expect(matchPatterns("nothing here", PERSONAL_PATTERNS)).toEqual([]);
  });
});

describe("生产代码凭据字样基线（验收③）", () => {
  it("真实源码：计数与基线逐条相等（多一处、少一处都算漂移）", () => {
    const scan = scanCredentialBaseline(".", CREDENTIAL_RULES, { fs: realFs, files: SOURCE_FILES });
    expect(scan.violations).toEqual([]);
    expect(scan.findings).toHaveLength(CREDENTIAL_RULES.length);
    // 基线的意义是「已知的凭据字样都在声明过的地方」：出现次数变化必须走人工判断。
    // 报告里按位置排序，比较时同样排序，避免把「顺序」误当判据。
    const sorted = [...CREDENTIAL_RULES].sort((left, right) =>
      `${left.path}#${left.token}`.localeCompare(`${right.path}#${right.token}`),
    );
    expect(scan.findings.map((finding) => `${finding.location}=${String(finding.count)}/${String(finding.allowed)}`)).toEqual(
      sorted.map((rule) => `${rule.path}#${rule.token}=${String(rule.max)}/${String(rule.max)}`),
    );
  });

  it("假源码里多出一处 api_key 立刻被挡下；删掉一处也要重新校准基线", () => {
    const path = "src/domain/leak.ts";
    const rules = [{ id: "leak", path, token: "api_key", max: 0, reason: "反例" }];
    const leaky = memoryFs({ [path]: 'const key = "api_key";\n' });
    expect(scanCredentialBaseline(".", rules, { fs: leaky, files: [path] }).violations).toHaveLength(1);

    const clean = memoryFs({ [path]: "const key = 1;\n" });
    expect(scanCredentialBaseline(".", rules, { fs: clean, files: [path] }).violations).toEqual([]);

    // 清单里有、磁盘上没有：不能当成「干净」放过。
    const unreadable = memoryFs({});
    const unreadableScan = scanCredentialBaseline(".", rules, { fs: unreadable, files: [path] });
    expect(unreadableScan.violations).toHaveLength(1);
    expect(unreadableScan.violations[0] ?? "").toContain("读不到内容");
    expect(unreadableScan.filesScanned).toBe(0);

    // 连清单里都没有：说明扫描面被剪过，同样报错。
    const absent = scanCredentialBaseline(".", rules, { fs: memoryFs({}), files: [] });
    expect(absent.violations[0] ?? "").toContain("不在扫描面内");
  });

  it("规则没覆盖过的新文件出现凭据字样同样被挡下（上界默认 0）", () => {
    const rules = [{ id: "leak", path: "src/domain/known.ts", token: "api_key", max: 0, reason: "反例" }];
    const fs = memoryFs({
      "src/domain/known.ts": "export const k = 1;\n",
      "src/domain/brand-new.ts": 'export const k = { apikey: "sk-live" };\n',
    });
    const violations = scanCredentialBaseline(".", rules, {
      fs,
      files: ["src/domain/known.ts", "src/domain/brand-new.ts"],
    }).violations;
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("src/domain/brand-new.ts");
    expect(violations[0]).toContain("apikey");
  });
});

describe("完成通知与诊断日志的硬边界（验收③）", () => {
  it("真实源码：三份出口文件零凭据字样", () => {
    const scan = scanBoundaryRules(".", BOUNDARY_RULES, {
      fs: realFs,
      files: BOUNDARY_RULES.map((rule) => rule.path),
    });
    expect(scan.violations).toEqual([]);
  });

  it("完成通知里塞进凭据字段必被挡下", () => {
    const notification = BOUNDARY_RULES[0];
    expect(notification).toBeDefined();
    const path = notification?.path ?? "";
    const leaky = memoryFs({ [path]: "export const notice = { api_key: 'sk-1' };\n" });
    const violations = scanBoundaryRules(".", BOUNDARY_RULES, { fs: leaky, files: [path] }).violations;
    expect(violations.some((line) => line.includes("api_key"))).toBe(true);
  });

  it("边界文件缺失也算失败（不能靠删文件绕过判据）", () => {
    const violations = scanBoundaryRules(".", BOUNDARY_RULES, {
      fs: memoryFs({}),
      files: BOUNDARY_RULES.map((rule) => rule.path),
    }).violations;
    expect(violations.filter((line) => line.includes("不存在"))).toHaveLength(BOUNDARY_RULES.length);
  });
});

describe("发布物凭据扫描与个人数据（验收③⑤）", () => {
  it("真实发布文本面零命中", () => {
    const scan = scanShipSet(".", [ARTIFACT_LICENSE, ARTIFACT_NOTICES, "README.md", "LICENSE"], realFs);
    expect(scan.violations).toEqual([]);
    expect(SHIP_SET_FORBIDDEN_TOKENS.length).toBeGreaterThan(0);
  });

  it("往产物里塞凭据或私钥标记必被挡下", () => {
    const fs = memoryFs({ [ARTIFACT_NOTICES]: "client_secret: abc\n-----BEGIN OPENSSH PRIVATE KEY-----\n" });
    const violations = scanShipSet(".", [ARTIFACT_NOTICES], fs).violations;
    expect(violations.some((line) => line.includes("client_secret"))).toBe(true);
    expect(violations.some((line) => line.includes("-----BEGIN "))).toBe(true);
  });

  it("作者路径混进发布文本面即被挡下", () => {
    const fs = memoryFs({ "README.md": "构建机路径：D:\\VibeCoding\\RIME-PredictInput\n" });
    const scan = scanPersonalData(".", ["README.md"], fs);
    expect(scan.violations.some((line) => line.includes("personal-path"))).toBe(true);
  });

  it("声明里的地址必须逐字来自安装树许可证正文", () => {
    const address = "zod-maintainer@example.invalid";
    const provenance = scanNoticesProvenance(
      `Copyright (c) 2026 zod authors <${address}>\n`,
      [`Copyright (c) 2026 zod authors <${address}>\n`],
    );
    expect(provenance.violations).toEqual([]);
    expect(provenance.findings).toHaveLength(1);

    const foreign = scanNoticesProvenance(
      "Copyright (c) 2026 x <only-on-this-machine@example.invalid>\n",
      [`Copyright (c) 2026 zod authors <${address}>\n`],
    );
    expect(foreign.violations[0]).toContain("only-on-this-machine@example.invalid");
  });
});

describe("发布物清单（验收⑤）", () => {
  it("真实条目齐备，排除清单覆盖本地材料与个人评测数据", () => {
    const report = collectShipSet(".", realFs);
    expect(report.missing).toEqual([]);
    expect([...SHIP_SET_ENTRIES].sort()).toEqual([ARTIFACT_LICENSE, ARTIFACT_NOTICES].sort());
    expect(report.fileCount).toBe(SHIP_SET_ENTRIES.length);
    expect(report.digest).toMatch(/^[0-9a-f]{64}$/);
    for (const prefix of ["reference/", ".scratch/", ".local/", "eval/.cache/", "eval/holdout/"]) {
      expect(EXCLUDED_PREFIXES).toContain(prefix);
      expect(isExcluded(`${prefix}anything`)).toBe(true);
    }
    expect(EXCLUDED_FILES).toContain("docs/agents/workspace.json");
    expect(FIXTURE_FILES["LICENSE"]).not.toBe("");
  });

  it("缺件被报出来、摘要随内容变化（不是恒定值）", () => {
    expect(collectShipSet(".", memoryFs({})).missing).toEqual([...SHIP_SET_ENTRIES].sort());

    const a = collectShipSet(".", memoryFs({ [ARTIFACT_LICENSE]: "MIT License" }));
    const b = collectShipSet(".", memoryFs({ [ARTIFACT_LICENSE]: "MIT License v2" }));
    expect(a.missing).toEqual([ARTIFACT_NOTICES]);
    expect(a.digest).not.toBe(b.digest);
  });
});

describe("Release notes 必备内容（验收④）", () => {
  it("真实模板：十一组内容全部在场", () => {
    const report = releaseNotesReport({ fs: realFs, root: "." });
    expect(report.checks.filter((check) => !check.passed).map((check) => `${check.id}:${check.missing.join("、")}`)).toEqual([]);
    expect(report.checks).toHaveLength(NOTE_REQUIREMENTS.length);
    expect(report.charCount).toBeGreaterThan(2000);
  });

  it("删掉任一段落都会指名报缺（十项内容逐条可挡）", () => {
    const full = readReleaseNotes({ fs: realFs, root: "." });
    expect(full.sources).toEqual(["docs/release-notes-template.md", "docs/fork/release-template.md"]);
    for (const requirement of NOTE_REQUIREMENTS) {
      const pruned = full.text.replaceAll(requirement.required[0] ?? "", "");
      const failing = checkReleaseNotes(pruned).filter((check) => !check.passed).map((check) => check.id);
      expect(failing).toContain(requirement.id);
    }
  });

  it("两份模板都不可缺：少一份就报缺（含源码链接的那一份也不能少）", () => {
    const template = FIXTURE_FILES["docs/release-notes-template.md"] ?? "";
    const withFork = releaseNotesReport({ fs: memoryFs({ "docs/release-notes-template.md": template }), root: "." });
    const withMain = releaseNotesReport({ fs: memoryFs({ "docs/fork/release-template.md": template }), root: "." });
    const failed = (checks: readonly { readonly id: string; readonly passed: boolean }[]): string[] =>
      checks.filter((check) => !check.passed).map((check) => check.id);
    // 「合并两份才算齐」要有可验证的含义：任一份缺席都必须有检查变红。
    expect(failed(withMain.checks)).not.toEqual([]);
    expect(failed(withFork.checks)).not.toEqual([]);
    // 两个来源都在读取清单里；合并正文比任一份都长。
    const merged = readReleaseNotes({ fs: realFs, root: "." });
    expect(merged.sources).toHaveLength(2);
    expect(merged.text.length).toBeGreaterThan(readReleaseNotes({ fs: realFs, root: ".", sources: merged.sources.slice(0, 1) }).text.length);
  });
});
