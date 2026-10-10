/**
 * 构建期许可证与版权清单（#27 验收②）。
 *
 * 清单不是照着记忆写的：每个条目的标识符、版本、版权行与许可证正文都从**安装树里
 * 那一份**读出来（`node_modules/<pkg>/package.json` + 同目录的 LICENSE 文件），
 * 读不到就报错、绝不猜。这样「依赖换了版本、许可证换了措辞」会在下次构建时暴露，
 * 而不是等到发布之后。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { nodeFs, toPosix, type ReleaseFs } from "./fs.js";
import { EMBEDDED_RUNTIME_TARGET, EMBEDDED_RUNTIME_TARGET_VERSION, EMBEDDED_RUNTIME_VERSION, type LicenseEntry, type LicenseRole } from "./types.js";

/** 票面第②条点名的依赖：运行时随产物走的 + 构建期工具链。 */
export const INVENTORY_PACKAGES: readonly { readonly specifier: string; readonly role: LicenseRole }[] = [
  { specifier: "koffi", role: "bundled" },
  { specifier: "zod", role: "bundled" },
  { specifier: "@yao-pkg/pkg", role: "build-only" },
  { specifier: "esbuild", role: "build-only" },
  { specifier: "typescript", role: "build-only" },
  { specifier: "vitest", role: "build-only" },
];

/** 许可证文件的候选名；命中第一个存在的即可。 */
const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying)/i;

/** 许可证标识是否为可识别的 SPDX 形状（`MIT`、`Apache-2.0`、`GPL-3.0-only`…）。 */
export function isSpdxIdentifier(value: string): boolean {
  return /^[A-Za-z0-9.+-]+$/.test(value);
}

export interface PackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly license?: unknown;
  readonly licenses?: unknown;
  readonly homepage?: unknown;
  readonly repository?: unknown;
  readonly author?: unknown;
}

/** 清单条目的**来源**形状：一份可被替身喂进来的最小包体，便于离线重放。 */
export interface PackageSource {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly homepage: string | null;
  /** 许可证正文的存放位置，仓库内用相对仓库根的路径。 */
  readonly textSource: string;
  readonly text: string;
  readonly copyright: string | null;
}

export interface InventorySources {
  readonly packages: readonly PackageSource[];
  readonly embeddedRuntime: PackageSource;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function repositoryUrl(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const candidate = (value as { url?: unknown }).url;
    if (typeof candidate === "string") return candidate;
  }
  return null;
}

function authorLine(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const candidate = (value as { name?: unknown }).name;
    if (typeof candidate === "string") return candidate;
  }
  return null;
}

function licenseIdentifier(manifest: PackageManifest): string {
  const direct = textOf(manifest.license);
  if (direct !== null) return direct;
  const legacy = manifest.licenses;
  if (Array.isArray(legacy)) {
    const first = legacy[0];
    if (typeof first === "object" && first !== null) {
      const type = (first as { type?: unknown }).type;
      if (typeof type === "string") return type;
    }
    if (typeof first === "string") return first;
  }
  return "UNKNOWN";
}

/** 版权行优先从许可证正文里认（`Copyright (c) …`），认不到才退回 package.json 的 author。 */
export function copyrightLine(text: string | null, fallback: string | null): string | null {
  if (text !== null) {
    const match = /copyright[^\n]*/i.exec(text);
    if (match !== null) return match[0].trim();
  }
  return fallback;
}

/** 仓库内路径转相对路径；仓库外的（比如全局 Node 安装目录）只留文件名。 */
export function repoRelativePath(root: string, path: string): string {
  const rel = toPosix(relative(root, path));
  if (rel.length === 0) return ".";
  if (rel.startsWith("../") || isAbsolute(rel)) {
    const parts = toPosix(path).split("/");
    return parts[parts.length - 1] ?? path;
  }
  return rel;
}

export function hostNodeLicensePath(execPath: string): string {
  return join(execPath.slice(0, Math.max(execPath.lastIndexOf("\\"), execPath.lastIndexOf("/"))), "LICENSE");
}

/** 在目录里找第一个可读的许可证文件；找不到返回 null。 */
export function findLicenseFile(
  directory: string,
  fs: ReleaseFs,
): { readonly path: string; readonly text: string } | null {
  for (const name of fs.list(directory)) {
    if (!LICENSE_FILE_PATTERN.test(name)) continue;
    const text = fs.readText(join(directory, name));
    if (text === null || text.trim().length === 0) continue;
    return { path: join(directory, name), text };
  }
  return null;
}

/** 从安装树读一份包的许可证事实；读不到许可证正文就返回 null（由调用方报错）。 */
export function readPackageSource(
  root: string,
  packageDir: string,
  manifest: PackageManifest,
  fs: ReleaseFs,
): PackageSource | null {
  const found = findLicenseFile(packageDir, fs);
  if (found === null) return null;
  return {
    name: textOf(manifest.name) ?? packageDir,
    version: textOf(manifest.version) ?? "0.0.0",
    license: licenseIdentifier(manifest),
    homepage: repositoryUrl(manifest.repository) ?? textOf(manifest.homepage),
    textSource: repoRelativePath(root, found.path),
    text: found.text,
    copyright: copyrightLine(found.text, authorLine(manifest.author)),
  };
}

/**
 * 用 Node 自己的解析算法定位依赖：与构建时实际加载的是同一份文件，
 * 而不是「按目录名猜一个」——pnpm 的存储布局下两者并不等价。
 */
export function resolveInstalledPackage(
  specifier: string,
  hostManifestPath: string,
): { readonly manifestPath: string; readonly packageDir: string; readonly manifest: PackageManifest } | null {
  const resolve = createRequire(hostManifestPath);
  let manifestPath: string;
  try {
    manifestPath = resolve.resolve(`${specifier}/package.json`);
  } catch {
    return null;
  }
  const raw = readFileSync(manifestPath, "utf8");
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(raw) as PackageManifest;
  } catch {
    return null;
  }
  return { manifestPath, packageDir: dirname(manifestPath), manifest };
}

/**
 * 内嵌 Node 运行时的许可证正文归档位置。
 *
 * 为什么不是从本机 Node 安装目录读：Windows 的 Node 安装包里根本没有 LICENSE 文件
 * （`C:\Program Files\nodejs\` 只有 node.exe 与 npm 脚本），构建机上也一样没有。
 * 因此正文取自官方发行源（`nodejs/node` 同版本 tag 的 `LICENSE`，内含 Node 自身与
 * 其内嵌第三方组件的全部许可证）并**逐字归档**在这个受追踪的路径里。
 */
export const EMBEDDED_RUNTIME_LICENSE_PATH = `docs/license/Node.js-${EMBEDDED_RUNTIME_TARGET_VERSION}-LICENSE.txt`;

function embeddedRuntimeSource(root: string, fs: ReleaseFs): PackageSource {
  const text = fs.readText(`${root}/${EMBEDDED_RUNTIME_LICENSE_PATH}`);
  if (text === null) {
    throw new Error(`内嵌 Node 运行时的许可证正文未归档：${EMBEDDED_RUNTIME_LICENSE_PATH}`);
  }
  return {
    name: "Node.js runtime",
    version: EMBEDDED_RUNTIME_VERSION,
    license: "MIT",
    homepage: "https://nodejs.org/",
    textSource: EMBEDDED_RUNTIME_LICENSE_PATH,
    text,
    copyright: copyrightLine(text, "Copyright Node.js contributors"),
  };
}

/** 权威来源里可核对的条目：ID/角色/名称/版本/许可证标识。 */
export interface InventoryEntry {
  readonly id: string;
  readonly role: LicenseRole;
  readonly name: string;
  readonly version: string;
  readonly license: string;
}

export interface InventoryCollection {
  readonly entries: readonly LicenseEntry[];
  /** 逐条目可核对的摘要；报告与测试都读这一份。 */
  readonly index: readonly InventoryEntry[];
  readonly hostNodeVersion: string;
  readonly runtimeTarget: string;
}

function toEntry(source: PackageSource, role: LicenseRole): LicenseEntry {
  return {
    name: source.name,
    version: source.version,
    license: source.license,
    role,
    homepage: source.homepage,
    textSource: source.textSource,
    text: source.text,
    note: source.copyright,
  };
}

/** 纯函数：把「已读到的来源」折成清单，不碰文件系统，条目顺序与 INVENTORY_PACKAGES 一一对应。 */
export function inventoryFromSources(
  sources: InventorySources,
  hostNodeVersion: string = process.versions.node,
): InventoryCollection {
  if (sources.packages.length !== INVENTORY_PACKAGES.length) {
    throw new Error(
      `许可证清单条目数不符：期望 ${INVENTORY_PACKAGES.length} 条，实得 ${sources.packages.length} 条`,
    );
  }
  const entries: LicenseEntry[] = [];
  const index: InventoryEntry[] = [];
  INVENTORY_PACKAGES.forEach((declared, position) => {
    const source = sources.packages[position];
    if (source === undefined) {
      throw new Error(`许可证清单缺少依赖条目：${declared.specifier}`);
    }
    if (source.text.trim().length === 0) {
      throw new Error(`依赖 ${source.name}@${source.version} 未随包附带许可证正文`);
    }
    entries.push(toEntry(source, declared.role));
    index.push({
      id: declared.specifier,
      role: declared.role,
      name: source.name,
      version: source.version,
      license: source.license,
    });
  });
  entries.push(toEntry(sources.embeddedRuntime, "embedded-runtime"));
  index.push({
    id: "node-runtime",
    role: "embedded-runtime",
    name: sources.embeddedRuntime.name,
    version: EMBEDDED_RUNTIME_VERSION,
    license: sources.embeddedRuntime.license,
  });
  return {
    entries,
    index,
    hostNodeVersion,
    runtimeTarget: EMBEDDED_RUNTIME_TARGET,
  };
}

/**
 * 收集清单。`hostManifestPath` 用来起解析（默认仓库根的 package.json）——
 * 依赖条目全部读自当前安装树，内嵌运行时条目读自归档的官方许可证正文。
 */
export function collectLicenseInventory(
  root: string,
  fs: ReleaseFs = nodeFs,
  hostManifestPath: string = join(root, "package.json"),
): InventoryCollection {
  // Node 的解析器要求绝对路径；调用方按约定可以传相对仓库根的 `"."`。
  const host = resolve(hostManifestPath);
  const packages: PackageSource[] = [];
  for (const { specifier } of INVENTORY_PACKAGES) {
    const resolved = resolveInstalledPackage(specifier, host);
    if (resolved === null) {
      throw new Error(`依赖 ${specifier} 未安装或 package.json 不可读，无法收集许可证`);
    }
    const source = readPackageSource(root, resolved.packageDir, resolved.manifest, fs);
    if (source === null) {
      const version = textOf(resolved.manifest.version) ?? "?";
      throw new Error(`依赖 ${specifier}@${version} 未随包附带许可证正文（${toPosix(resolved.packageDir)}）`);
    }
    packages.push(source);
  }
  return inventoryFromSources({ packages, embeddedRuntime: embeddedRuntimeSource(root, fs) }, process.versions.node);
}
