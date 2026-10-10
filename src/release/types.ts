/**
 * 发布合规 gate 的数据形状（S10/#27）。
 *
 * 这里只放类型与常量：报告是要**归档**的机器可读清单，所以它的字段名一旦发布
 * 就不能随意改——schema 版本单独编号，消费方按 `schema` 判断能不能读懂。
 */

/** 报告 schema 版本；字段语义有破坏性变化时必须递增。 */
export const RELEASE_REPORT_SCHEMA = 1;

/** 归档目录（相对仓库根）：报告与许可证清单是人可复核的发布证据。 */
export const RELEASE_ARCHIVE_DIR = "dist/release-archive";
export const RELEASE_REPORT_NAME = "release-report.json";
export const LICENSE_INVENTORY_NAME = "licenses.json";

/**
 * 本产物（sidecar）在构建期内嵌的 Node 运行时目标，必须与
 * `tools/sidecar-exe/build.mjs` 的 `-t` 实参逐字一致；两者漂移由 gate 的
 * `licenses.embedded-node` 检查捕获。
 */
export const EMBEDDED_RUNTIME_TARGET = "node22-win-x64";

/**
 * `@yao-pkg/pkg` 为 `node22-win-x64` 拉取的运行时版本（pkg-fetch 的 expected-shas
 * 里 payload 就是这一版）。归档的许可证正文取 `nodejs/node` 同版本 tag 的 `LICENSE`。
 */
export const EMBEDDED_RUNTIME_TARGET_VERSION = "v22.23.2";
export const EMBEDDED_RUNTIME_VERSION = "22";
export const EMBEDDED_RUNTIME_LICENSE_URL =
  `https://raw.githubusercontent.com/nodejs/node/${EMBEDDED_RUNTIME_TARGET_VERSION}/LICENSE`;

export const REPO_URL = "https://github.com/CometDash77/RIME-PredictInput";
export const FORK_URL = "https://github.com/CometDash77/weasel";
export const FORK_BRANCH = "predict-0.17.4";
export const UPSTREAM_WEASEL = "https://github.com/rime/weasel";
export const UPSTREAM_WEASEL_TAG = "0.17.4";
export const UPSTREAM_WEASEL_COMMIT = "9cc96e20dc71b80876b12f689bb5863c76c2a7ed";
export const LIBRIME_URL = "https://github.com/rime/librime";
export const LIBRIME_COMMIT = "1c23358157934bd6e6d6981f0c0164f05393b497";

/** 单一发布 tag 的正则：`v0.1.0` 或带四段构建号的 `v0.1.0.3`。 */
export const RELEASE_TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$/;

/** 本仓库自有代码的许可证（票面第①条：MIT）。 */
export const OWN_LICENSE_SPDX = "MIT";

/** fork 派生物继续按 GPL-3.0-only 公开对应源码（票面第①条）。 */
export const FORK_LICENSE_SPDX = "GPL-3.0-only";

/** 报告里的一条检查结果；`id` 稳定，供归档消费方按名索引。 */
export interface ReleaseCheck {
  readonly id: string;
  readonly passed: boolean;
  readonly summary: string;
  /** 判据的可复核明细：通过时写「扫了什么」，失败时写「缺什么」。 */
  readonly evidence: readonly string[];
}

export interface ShipSetReport {
  readonly artifacts: readonly string[];
  readonly fileCount: number;
  readonly digest: string;
  readonly files: readonly string[];
  readonly exclusions: readonly string[];
}

export interface CredentialFinding {
  /** 相对仓库根的路径，或 `ipc-path:…` 一类的位置标识。 */
  readonly location: string;
  readonly rule: string;
  readonly count: number;
  readonly allowed: number;
}

export interface CredentialReport {
  readonly filesScanned: number;
  readonly staticFindings: readonly CredentialFinding[];
  readonly shipSetFindings: readonly CredentialFinding[];
}

export interface ReleaseNoteCheck {
  readonly id: string;
  readonly passed: boolean;
  readonly missing: readonly string[];
}

export interface ReleaseNotesReport {
  readonly sources: readonly string[];
  readonly charCount: number;
  readonly checks: readonly ReleaseNoteCheck[];
}

export type ReleaseVerdict = "pass" | "blocked";

export interface ReleaseReport {
  readonly schema: number;
  readonly generatedAt: string;
  readonly releaseTag: string;
  readonly verdict: ReleaseVerdict;
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
  };
  readonly checks: readonly ReleaseCheck[];
  readonly licenses: readonly LicenseEntry[];
  readonly shipSet: ShipSetReport;
  readonly credentials: CredentialReport;
  readonly releaseNotes: ReleaseNotesReport;
}

/** 许可证清单里的一条；正文入档，便于离线复核。 */
export interface LicenseEntry {
  /** SPDX 标识符；无法从 package.json 判定时是 `UNKNOWN`。 */
  readonly license: string;
  /** 条目角色：随产物分发 / 仅构建期使用 / 内嵌运行时。 */
  readonly role: LicenseRole;
  readonly name: string;
  readonly version: string;
  readonly homepage: string | null;
  /** 许可证正文的来源路径（相对仓库根）或来源 URL。 */
  readonly textSource: string | null;
  readonly text: string | null;
  /** 正文缺失时必须说明为什么仍然合规（例如内嵌运行时用官方 § 说明替代）。 */
  readonly note: string | null;
}

export type LicenseRole = "bundled" | "build-only" | "embedded-runtime";

export interface LicenseCollector {
  (root: string): readonly LicenseEntry[];
}

/** 一个发布 gate 检查；与 `ReleaseCheck` 同形，别名只是为了让 gate 代码读起来更直白。 */
export type GateCheck = ReleaseCheck;

/** 检查 id 的完整清单；报告归档后消费方按这些名字读结论。 */
export const GATE_CHECK_IDS = {
  ownLicense: "policy.own-license",
  forkLicense: "policy.fork-license",
  credentialHarness: "credentials.harness",
  sourceScan: "credentials.source-scan",
  shipSetScan: "credentials.ship-set-scan",
  runtimeBoundaries: "credentials.runtime-boundaries",
  textRules: "credentials.text-rules",
  shipSetPlan: "distribution.ship-set-plan",
  personalData: "distribution.personal-data",
  syntheticCorpus: "distribution.synthetic-corpus",
  notesCoverage: "notes.required-content",
  notesSourceLinks: "notes.source-links",
} as const;
