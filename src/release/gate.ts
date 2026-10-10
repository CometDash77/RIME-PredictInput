/**
 * 发布 gate：把许可证、凭据扫描、发布物枚举与 Release notes 判据合成一份归档报告（#27 验收⑥）。
 *
 * 报告是**机器可读**的：每条检查有名有据（`id` 稳定），失败项直接给出「缺什么」。
 * 判决规则刻意迟钝——任何一条检查失败就是 `blocked`，没有「警告放行」这一档：
 * 发布前少一份许可证、少一段隐私声明或少一条源码链接，本来就不该有人能按下发布键。
 */
import { nodeFs, sha256Hex, type ReleaseFs } from "./fs.js";
import { collectLicenseInventory, type InventoryCollection } from "./licenses.js";
import { noticesIntegrity, NOTICES_PATH } from "./notices.js";
import {
  ARTIFACT_NOTICES,
  collectShipSet,
  CORPUS_SOURCES,
  isExcluded,
  SHIP_SET_ENTRIES,
  SYNTHETIC_CORPUS_MARKERS,
} from "./shipset.js";
import { BOUNDARY_RULES, CREDENTIAL_RULES, CREDENTIAL_TOKENS } from "./credential-policy.js";
import { scanBoundaryRules, scanCredentialBaseline, scanNoticesProvenance, scanPersonalData, scanShipSet } from "./credential-scan.js";
import { notesReportForRoot } from "./release-notes.js";
import {
  FORK_LICENSE_SPDX,
  GATE_CHECK_IDS,
  OWN_LICENSE_SPDX,
  RELEASE_REPORT_SCHEMA,
  type CredentialFinding,
  type CredentialReport,
  type GateCheck,
  type ReleaseReport,
  type ShipSetReport,
} from "./types.js";

/** MIT 正文的判据片段（版权行单独核对，正文必须逐字在场）。 */
export const MIT_MARKERS: readonly string[] = [
  "MIT License",
  "Permission is hereby granted, free of charge",
  'THE SOFTWARE IS PROVIDED "AS IS"',
];

export const GPL_COPY_PATH = "docs/license/GPL-3.0.txt";
export const GPL_MARKERS: readonly string[] = ["GNU GENERAL PUBLIC LICENSE", "Version 3, 29 June 2007"];

/** 生产代码的扫描面：`src/` 下所有 `.ts`，但排除工具自身（`src/release/` 里全是判据数据）。 */
export function productSources(files: readonly string[]): readonly string[] {
  return files
    .filter((path) => path.startsWith("src/") && path.endsWith(".ts") && !path.startsWith("src/release/"))
    .sort();
}

/** 发布物实际要扫的文本面：产物文本 + 直接随产物发布/展示的仓库根文档。 */
export const SHIP_SET_TEXT_SOURCES: readonly string[] = [...SHIP_SET_ENTRIES, "README.md", NOTICES_PATH];

export function shipSetTextFiles(missing: readonly string[]): readonly string[] {
  return SHIP_SET_TEXT_SOURCES.filter((path) => !missing.includes(path)).sort();
}

export interface GateInput {
  readonly root: string;
  readonly releaseTag: string;
  readonly fs?: ReleaseFs;
  readonly now?: () => number;
  readonly inventory?: () => InventoryCollection;
  /** 仓库全量文件清单（相对仓库根）；缺省时用 fs.walk。 */
  readonly files?: readonly string[];
}

function markerCheck(
  path: string,
  markers: readonly string[],
  fs: ReleaseFs,
  root: string,
): { readonly passed: boolean; readonly missing: readonly string[] } {
  const text = fs.readText(`${root}/${path}`);
  if (text === null) return { passed: false, missing: [`${path} 不存在`] };
  const missing = markers.filter((marker) => !text.includes(marker));
  return { passed: missing.length === 0, missing };
}

export interface HarnessResult {
  readonly passed: boolean;
  readonly detail: string;
}

/** 反例自证：同一套判据喂进一份**故意违规**的假源码，必须报出违规。 */
export function credentialHarness(): HarnessResult {
  const fakePath = "src/domain/fake-leak.ts";
  const leaked = 'const CLOUD = { api_key: "sk-live-should-be-blocked" };\n';
  const clean = "export const value = 1;\n";
  const rules = [{ id: "harness", path: fakePath, token: "api_key", max: 0, reason: "反例自证" }];
  const memory = (text: string): ReleaseFs => ({
    readText: () => text,
    writeText: () => undefined,
    list: () => [],
    walk: () => [fakePath],
  });
  const leaky = scanCredentialBaseline("/repo", rules, { fs: memory(leaked), files: [fakePath] });
  const cleanScan = scanCredentialBaseline("/repo", rules, { fs: memory(clean), files: [fakePath] });
  const caughtLeak = leaky.violations.length === 1;
  const acceptedClean = cleanScan.violations.length === 0;
  return {
    passed: caughtLeak && acceptedClean,
    detail:
      caughtLeak && acceptedClean
        ? "反例被抓到、干净样本被放行"
        : `扫描器失效：反例 violations=${JSON.stringify(leaky.violations)}，干净 violations=${JSON.stringify(cleanScan.violations)}`,
  };
}

/** 跑完所有检查，返回归档报告。任何一条失败 ⇒ `verdict: "blocked"`。 */
export function runGate(input: GateInput): ReleaseReport {
  const fs = input.fs ?? nodeFs;
  const root = input.root;
  const files = input.files ?? fs.walk(root);
  const inventory = input.inventory === undefined ? collectLicenseInventory(root, fs) : input.inventory();
  const checks: GateCheck[] = [];

  // ① 自有代码 MIT；fork 继续按 GPL-3 派生物单独公开对应源码。
  const mit = markerCheck("LICENSE", MIT_MARKERS, fs, root);
  const licenseEntries = inventory.entries;
  const integrity = noticesIntegrity(
    fs.readText(`${root}/${NOTICES_PATH}`),
    licenseEntries,
    inventory.index.map((entry) => ({ name: entry.name, version: entry.version })),
  );
  checks.push({
    id: GATE_CHECK_IDS.ownLicense,
    passed: mit.passed && integrity.passed,
    summary: `自有代码 ${OWN_LICENSE_SPDX}：LICENSE 正文与第三方声明齐备`,
    evidence: [
      `LICENSE：${mit.passed ? "正文齐备" : `缺 ${mit.missing.join("、")}`}`,
      `${NOTICES_PATH}：${integrity.passed ? `${String(licenseEntries.length)} 条清单条目正文一致` : integrity.problems.join("；")}`,
    ],
  });

  const gpl = markerCheck(GPL_COPY_PATH, GPL_MARKERS, fs, root);
  const forkTemplate = fs.readText(`${root}/docs/fork/release-template.md`) ?? "";
  const forkBoundary = [FORK_LICENSE_SPDX, "源码义务"].filter((needle) => !forkTemplate.includes(needle));
  checks.push({
    id: GATE_CHECK_IDS.forkLicense,
    passed: gpl.passed && forkBoundary.length === 0,
    summary: `Weasel fork 按 ${FORK_LICENSE_SPDX} 派生物处理：许可证正文副本与义务声明齐备`,
    evidence: [
      `${GPL_COPY_PATH}：${gpl.passed ? "正文齐备" : `缺 ${gpl.missing.join("、")}`}`,
      `fork 模板义务声明：${forkBoundary.length === 0 ? "在" : `缺 ${forkBoundary.join("、")}`}`,
    ],
  });

  // ② 构建期收集的许可证与版权声明。
  const textless = licenseEntries.filter((entry) => entry.text === null || entry.text.trim().length === 0);
  checks.push({
    id: "licenses.inventory",
    passed: textless.length === 0 && licenseEntries.length === inventory.index.length,
    summary: "构建期收集依赖许可证与版权声明（标识符、版本、正文全部读自安装树）",
    evidence: [
      `条目：${inventory.index.map((entry) => `${entry.id}=${entry.license}`).join(", ")}`,
      textless.length === 0 ? "每条都带许可证正文" : `缺正文：${textless.map((entry) => entry.name).join("、")}`,
    ],
  });
  const runtime = licenseEntries.find((entry) => entry.role === "embedded-runtime") ?? null;
  checks.push({
    id: "licenses.embedded-node",
    passed: runtime !== null && runtime.license === "MIT",
    summary: "内嵌 Node 运行时的版本与许可证正文入档",
    evidence: [
      `运行时目标：${inventory.runtimeTarget}`,
      `主机运行时主版本：${inventory.hostNodeVersion.split(".")[0] ?? "?"}`,
      `正文哈希：${sha256Hex(runtime?.text ?? "")}`,
    ],
  });

  // ③ 凭据与个人数据。
  const harness = credentialHarness();
  checks.push({
    id: GATE_CHECK_IDS.credentialHarness,
    passed: harness.passed,
    summary: "扫描器自带反例自证（假泄漏必须被抓到）",
    evidence: [harness.detail],
  });

  const sources = productSources(files);
  const baseline = scanCredentialBaseline(root, CREDENTIAL_RULES, { fs, files: sources });
  checks.push({
    id: GATE_CHECK_IDS.sourceScan,
    passed: baseline.violations.length === 0,
    summary: `生产代码凭据字样基线（${String(CREDENTIAL_RULES.length)} 条规则 / ${String(baseline.filesScanned)} 个文件）`,
    evidence:
      baseline.violations.length === 0
        ? [`词表：${CREDENTIAL_TOKENS.join(", ")}`, "count==baseline"]
        : baseline.violations,
  });

  const boundaries = scanBoundaryRules(root, BOUNDARY_RULES, { fs, files: BOUNDARY_RULES.map((rule) => rule.path) });
  checks.push({
    id: GATE_CHECK_IDS.runtimeBoundaries,
    passed: boundaries.violations.length === 0,
    summary: "完成通知链路与诊断日志零凭据字样",
    evidence:
      boundaries.violations.length === 0
        ? BOUNDARY_RULES.map((rule) => `${rule.path}：干净`)
        : boundaries.violations,
  });

  const shipSet = collectShipSet(root, fs);
  const shipSetText = shipSetTextFiles(shipSet.missing);
  const shipScan = scanShipSet(root, shipSetText, fs);
  checks.push({
    id: GATE_CHECK_IDS.shipSetScan,
    passed: shipScan.violations.length === 0,
    summary: `发布物凭据扫描（${String(shipScan.filesScanned)} 个文本面）`,
    evidence: shipScan.violations.length === 0 ? shipSetText : shipScan.violations,
  });

  // 第三方声明里的邮箱走**来源等式**：必须逐字出现在安装树附带的许可证正文里。
  // 仓库根与产物目录两份声明都按同一等式核对（`release:stage` 只是复制，不该改变结论）。
  const personal = scanPersonalData(
    root,
    shipSetText.filter((path) => path !== NOTICES_PATH && path !== ARTIFACT_NOTICES),
    fs,
  );
  const licenseTexts = licenseEntries.map((entry) => entry.text ?? "");
  const provenance = [NOTICES_PATH, ARTIFACT_NOTICES]
    .map((path) => ({ path, ...scanNoticesProvenance(fs.readText(`${root}/${path}`), licenseTexts) }))
    .filter((entry) => fs.readText(`${root}/${entry.path}`) !== null);
  const provenanceFindings = provenance.reduce((sum, entry) => sum + entry.findings.length, 0);
  const corpus = CORPUS_SOURCES.map((path) => ({ path, text: fs.readText(`${root}/${path}`) ?? "" }));
  const corpusProblems = corpus
    .filter((entry) => SYNTHETIC_CORPUS_MARKERS.every((marker) => !entry.text.includes(marker)))
    .map((entry) => `${entry.path} 未声明合成来源`);
  const excludedInShipSet = shipSet.files.filter(isExcluded);
  const personalProblems = [...personal.violations, ...provenance.flatMap((entry) => entry.violations)];
  checks.push({
    id: GATE_CHECK_IDS.personalData,
    passed: personalProblems.length === 0 && excludedInShipSet.length === 0,
    summary: "发布物不含作者路径、用户名、个人配置或个人正文",
    evidence:
      personalProblems.length === 0 && excludedInShipSet.length === 0
        ? [
            `扫描面：${shipSetText.join(", ")}`,
            `${String(provenanceFindings)} 个声明地址全部逐字来自安装树许可证正文`,
          ]
        : [...personalProblems, ...excludedInShipSet.map((path) => `被排除项混入产物：${path}`)],
  });
  checks.push({
    id: GATE_CHECK_IDS.syntheticCorpus,
    passed: corpusProblems.length === 0,
    summary: "评测语料保持合成、且不在发布物里（`reference`/`.scratch`/词库/个人评测数据均不发布）",
    evidence:
      corpusProblems.length === 0
        ? [
            ...CORPUS_SOURCES.map((path) => `${path}：已声明合成`),
            `排除清单：${[...shipSet.exclusions].join(", ")}`,
          ]
        : corpusProblems,
  });

  // ⑤ 发布物清单与声明一致。
  const declarationProblems = [
    ...shipSet.missing.map((path) => `声明了但不存在：${path}（由 S9 打包补齐）`),
    ...shipSet.extra.map((path) => `产物目录出现未声明的条目：${path}`),
  ];
  checks.push({
    id: GATE_CHECK_IDS.shipSetPlan,
    passed: declarationProblems.length === 0,
    summary: "发布物清单与声明一致（许可证/声明随产物走）",
    evidence:
      declarationProblems.length === 0
        ? [`${String(shipSet.fileCount)} 个条目，摘要 ${shipSet.digest.slice(0, 12)}…`]
        : declarationProblems,
  });

  // ④ Release notes 必备内容。
  const notes = notesReportForRoot(root, fs);
  const failingNotes = notes.checks.filter((check) => !check.passed);
  const missingSources = notes.sources.filter((path) => fs.readText(`${root}/${path}`) === null);
  checks.push({
    id: GATE_CHECK_IDS.notesCoverage,
    passed: failingNotes.length === 0,
    summary: "Release notes 模板覆盖票面十项内容",
    evidence:
      failingNotes.length === 0
        ? notes.checks.map((check) => `${check.id}：在`)
        : failingNotes.map((check) => `${check.id}：缺 ${check.missing.join("、")}`),
  });
  checks.push({
    id: GATE_CHECK_IDS.notesSourceLinks,
    passed: missingSources.length === 0,
    summary: "源码链接与对应源码义务在 Release notes 里可点",
    evidence:
      missingSources.length === 0
        ? [`来源：${notes.sources.join(", ")}`, `${String(notes.charCount)} 字符`]
        : missingSources.map((path) => `缺文件：${path}`),
  });

  const failed = checks.filter((check) => !check.passed);
  const staticFindings: readonly CredentialFinding[] = [
    ...baseline.findings,
    ...boundaries.findings,
    ...personal.findings,
  ];
  const credentials: CredentialReport = {
    filesScanned: baseline.filesScanned + boundaries.filesScanned + shipScan.filesScanned,
    staticFindings,
    shipSetFindings: shipScan.findings,
  };
  const shipSetReport: ShipSetReport = {
    artifacts: shipSet.declared,
    fileCount: shipSet.fileCount,
    digest: shipSet.digest,
    files: shipSet.files,
    exclusions: shipSet.exclusions,
  };
  const now = input.now ?? (() => Date.now());
  return {
    schema: RELEASE_REPORT_SCHEMA,
    generatedAt: new Date(now()).toISOString(),
    releaseTag: input.releaseTag,
    verdict: failed.length === 0 ? "pass" : "blocked",
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    checks,
    licenses: licenseEntries,
    shipSet: shipSetReport,
    credentials,
    releaseNotes: notes,
  };
}
