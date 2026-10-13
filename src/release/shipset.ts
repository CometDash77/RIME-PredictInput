/**
 * 发布物（ship-set）的判据与枚举（#27 验收⑤）。
 *
 * 声明与枚举分开：`SHIP_SET_ENTRIES` 是「谁该进产物」的**声明**，`collectShipSet` 是
 * 从磁盘**枚举**出来的实际结果。gate 要求两者一致——声明里写了却不存在、或磁盘上
 * 多出没声明的东西，都会挡下发布。
 *
 * 被排除项不是「我们不打算发布」，而是「这些东西一旦混进去就是事故」：本地历史材料、
 * 中间产物、评测缓存与个人评测数据。因此排除清单同时是扫描面：产物里出现被排除项，
 * 等于打包命令写错了。
 */
import { nodeFs, manifestDigest, sha256Hex, toPosix, type ReleaseFs } from "./fs.js";
import { NOTICES_PATH } from "./notices.js";

/** 发布物目录（相对仓库根）。 */
export const ARTIFACT_DIR = "dist/release";

/**
 * 进产品发布附件的**文本**清单：sidecar 单文件 exe 由 `pnpm build:exe` 产出、
 * 安装器由 S9（#28）产出，两者都在 Products Release 上单独挂文件；这里管的是
 * 必须和它们一起发出去的许可证/声明面。
 */
export const ARTIFACT_LICENSE = `${ARTIFACT_DIR}/LICENSE`;
export const ARTIFACT_NOTICES = `${ARTIFACT_DIR}/${NOTICES_PATH}`;

/** 进发布产物的东西：自有许可证 + 第三方声明（外加 S9 挂的 exe/安装器）。 */
export const SHIP_SET_ENTRIES: readonly string[] = [
  ARTIFACT_LICENSE,
  ARTIFACT_NOTICES,
];

/** 绝不进发布物的路径前缀（仓库根相对）。 */
export const EXCLUDED_PREFIXES: readonly string[] = [
  "reference/",
  ".scratch/",
  ".local/",
  "eval/.cache/",
  "eval/holdout/",
  "eval/arms/",
  "eval/fixtures/",
  "eval/scripts/",
  "reference/runtime-baseline/",
  "node_modules/",
  "docs/",
  "research/",
];

/** 绝不进发布物的顶层文件。 */
export const EXCLUDED_FILES: readonly string[] = [
  "docs/agents/workspace.json",
  ".env",
  ".npmrc",
];

/**
 * 评测语料的唯一的「合成」自证面：留出集构建器的来源声明。
 * 它必须是纯合成（#12 HITL 决定），所以 gate 直接读源码里的这句话，而不是靠记忆。
 */
export const SYNTHETIC_CORPUS_MARKERS: readonly string[] = [
  "纯合成",
  "本票新撰",
];

export const CORPUS_SOURCES: readonly string[] = ["src/eval/samples.ts", "eval/README.md"];

export interface ShipSetReportInternal {
  readonly declared: readonly string[];
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  readonly files: readonly string[];
  readonly fileCount: number;
  readonly digest: string;
  readonly exclusions: readonly string[];
  readonly scanned: readonly string[];
}

/** 声明里已存在的条目：不存在的用 `missing` 报出来，不算进摘要。 */
export function collectShipSet(root: string, fs: ReleaseFs = nodeFs): ShipSetReportInternal {
  const declared = [...SHIP_SET_ENTRIES].sort();
  const present: string[] = [];
  const missing: string[] = [];
  for (const entry of declared) {
    if (fs.readText(`${root}/${entry}`) === null) missing.push(entry);
    else present.push(entry);
  }
  // 产物目录里实际躺着的东西也要算进来：打包脚本多拷了一份许可证是一回事，
  // 多拷了一份**不该发的**文本是另一回事——后者只能靠枚举发现，不能只信声明。
  // 只认「文本类条目」（无扩展名或 .md/.txt/.json）：发布工具自身的编译产物
  // （`dist/release/*.js` 与 sourcemap）本来就在这个目录里，它们不是发布内容。
  const shipped = fs
    .list(`${root}/${ARTIFACT_DIR}`)
    .filter((name) => !/\.(js|mjs|cjs|map)$/i.test(name))
    .map((name) => `${ARTIFACT_DIR}/${name}`)
    .filter((path) => fs.readText(`${root}/${path}`) !== null);
  const files = [...new Set([...present, ...shipped.filter((path) => !isExcluded(path))])].sort();
  const extra = files.filter((path) => !declared.includes(path));
  const entries = files.map((path) => ({ path, sha256: sha256Hex(fs.readText(`${root}/${path}`) ?? "") }));
  return {
    declared,
    missing,
    extra,
    files,
    fileCount: files.length,
    digest: manifestDigest(entries),
    exclusions: [...EXCLUDED_PREFIXES],
    scanned: files,
  };
}

/** 某个仓库根相对路径是否命中排除项。 */
export function isExcluded(path: string): boolean {
  const posix = toPosix(path);
  if (EXCLUDED_FILES.includes(posix)) return true;
  return EXCLUDED_PREFIXES.some((prefix) => posix.startsWith(prefix));
}

/** 枚举全仓时用来剪枝：这些目录连进都不用进。 */
export const PRUNE_DIRECTORIES: readonly string[] = [
  ".git",
  "node_modules",
  "reference",
  ".scratch",
  ".local",
  "dist",
  "build",
  "coverage",
];
