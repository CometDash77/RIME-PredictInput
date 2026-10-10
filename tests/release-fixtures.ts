/**
 * 发布 gate 测试的离线机器（S10/#27）。
 *
 * 所有判据都跑在注入文件系统之上，所以测试可以：
 * - 离线重放真实判据（不读真实 `node_modules`、不依赖时钟）；
 * - 喂进**故意违规**的假仓库，证明 gate 真的会挡下发布（验收⑥的关键反例）。
 */
import type { ReleaseFs } from "../src/release/fs.js";
import type { InventoryCollection, InventoryEntry, PackageSource } from "../src/release/licenses.js";
import { INVENTORY_PACKAGES } from "../src/release/licenses.js";
import type { LicenseEntry, ReleaseReport } from "../src/release/types.js";
import { RELEASE_REPORT_SCHEMA } from "../src/release/types.js";

export type MemoryFs = ReleaseFs & { readonly files: Map<string, string> };

/** 内存文件系统：路径一律正斜杠（与 gate 内部口径一致）。 */
export function memoryFs(initial: Record<string, string> = {}): MemoryFs {
  const files = new Map<string, string>(Object.entries(initial));
  /** `./x`、`.\\x`、`x` 三种写法归一，才能用同一张表当「一个仓库」。 */
  const normalize = (path: string): string =>
    path.split("\\").join("/").replace(/^\.\/+/, "").replace(/^\.$/, "");
  const box = {
    files,
    readText: (path: string): string | null => files.get(normalize(path)) ?? null,
    writeText: (path: string, text: string): void => {
      files.set(normalize(path), text);
    },
    list: (path: string): readonly string[] => {
      // 只列直接子项，与 readdirSync 同语义。
      const prefix = normalize(path).replace(/\/+$/, "");
      if (prefix.length === 0 || prefix === ".") return [];
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(`${prefix}/`)) continue;
        const rest = key.slice(prefix.length + 1);
        const head = rest.split("/")[0];
        if (head !== undefined) names.add(head);
      }
      return [...names].sort();
    },
    walk: (base: string): readonly string[] => {
      const prefix = normalize(base).replace(/\/+$/, "");
      return [...files.keys()]
        .filter((path) => (prefix === "." || prefix.length === 0 ? true : path.startsWith(`${prefix}/`)))
        .map((path) => (prefix === "." || prefix.length === 0 ? path : path.slice(prefix.length + 1)))
        .sort();
    },
  };
  return box;
}

const FAKE_VERSIONS: Readonly<Record<string, string>> = {
  koffi: "2.16.3",
  zod: "4.6.5",
  "@yao-pkg/pkg": "6.23.0",
  esbuild: "0.28.2",
  typescript: "7.0.2",
  vitest: "5.0.3",
};

const FAKE_LICENSES: Readonly<Record<string, string>> = {
  koffi: "MIT",
  zod: "MIT",
  "@yao-pkg/pkg": "MIT",
  esbuild: "MIT",
  typescript: "Apache-2.0",
  vitest: "MIT",
};

/** 假安装树：正文里放一个只有这里才有的版权行，用来验证「声明抄自安装树」。 */
export function fakeSources(): { readonly packages: readonly PackageSource[]; readonly embeddedRuntime: PackageSource } {
  const packages = INVENTORY_PACKAGES.map(({ specifier }) => {
    const version = FAKE_VERSIONS[specifier] ?? "0.0.0";
    return {
      name: specifier,
      version,
      license: FAKE_LICENSES[specifier] ?? "MIT",
      homepage: `https://example.invalid/${specifier}`,
      textSource: `node_modules/${specifier}/LICENSE`,
      text: `LICENSE for ${specifier}@${version}\nCopyright (c) 2026 ${specifier} authors <${specifier}-maintainer@example.invalid>\n`,
      copyright: `Copyright (c) 2026 ${specifier} authors`,
    };
  });
  return {
    packages,
    embeddedRuntime: {
      name: "Node.js runtime",
      version: "22",
      license: "MIT",
      homepage: "https://nodejs.org/",
      textSource: "docs/license/Node.js-v22.23.2-LICENSE.txt",
      text: "Node.js is licensed for use as follows:\nCopyright Node.js contributors. All rights reserved.\nCopyright (c) 2026 nodejs contributors <node-maintainer@example.invalid>\n",
      copyright: "Copyright Node.js contributors. All rights reserved.",
    },
  };
}

export function fakeInventory(overrides: Partial<InventoryCollection> = {}): InventoryCollection {
  const { packages, embeddedRuntime } = fakeSources();
  const index: InventoryEntry[] = [];
  const entries: LicenseEntry[] = [];
  INVENTORY_PACKAGES.forEach(({ specifier, role }, position) => {
    const source = packages[position];
    if (source === undefined) return;
    index.push({ id: specifier, role, name: source.name, version: source.version, license: source.license });
    entries.push({
      name: source.name,
      version: source.version,
      license: source.license,
      role,
      homepage: source.homepage,
      textSource: source.textSource,
      text: source.text,
      note: source.copyright,
    });
  });
  index.push({ id: "node-runtime", role: "embedded-runtime", name: embeddedRuntime.name, version: "22", license: "MIT" });
  entries.push({
    name: embeddedRuntime.name,
    version: "22",
    license: "MIT",
    role: "embedded-runtime",
    homepage: embeddedRuntime.homepage,
    textSource: embeddedRuntime.textSource,
    text: embeddedRuntime.text,
    note: embeddedRuntime.copyright,
  });
  return {
    entries,
    index,
    hostNodeVersion: "24.16.0",
    runtimeTarget: "node22-win-x64",
    ...overrides,
  };
}

/** 报告里必须出现的检查 id（判据名单；改了判据就必须改这里）。 */
export const EXPECTED_CHECK_IDS: readonly string[] = [
  "policy.own-license",
  "policy.fork-license",
  "licenses.inventory",
  "licenses.embedded-node",
  "credentials.harness",
  "credentials.source-scan",
  "credentials.runtime-boundaries",
  "credentials.ship-set-scan",
  "distribution.personal-data",
  "distribution.synthetic-corpus",
  "distribution.ship-set-plan",
  "notes.required-content",
  "notes.source-links",
];

export function reportSchemaOf(report: ReleaseReport): number {
  return report.schema === RELEASE_REPORT_SCHEMA ? RELEASE_REPORT_SCHEMA : -1;
}