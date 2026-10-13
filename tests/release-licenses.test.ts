/**
 * 许可证清单与第三方声明（#27 验收①②）：清单必须读自安装树，声明必须与之一致。
 */
import { describe, expect, it } from "vitest";

import {
  copyrightLine,
  collectLicenseInventory,
  inventoryFromSources,
  INVENTORY_PACKAGES,
  isSpdxIdentifier,
  repoRelativePath,
} from "../src/release/licenses.js";
import { noticesIntegrity, renderNotices } from "../src/release/notices.js";
import { nodeFs } from "../src/release/fs.js";
import { fakeInventory, fakeSources } from "./release-fixtures.js";

const REPO_ROOT = ".";

const REAL_TIMEOUT_MS = 30_000;

describe("清单读自安装树（验收②）", () => {
  it("六个依赖 + 内嵌 Node 运行时全部有条目，且每条都带真实许可证正文", () => {
    const inventory = collectLicenseInventory(REPO_ROOT, nodeFs);
    expect(inventory.entries).toHaveLength(INVENTORY_PACKAGES.length + 1);
    expect(inventory.index.map((entry) => entry.id)).toEqual([
      ...INVENTORY_PACKAGES.map((declared) => declared.specifier),
      "node-runtime",
    ]);
    for (const entry of inventory.entries) {
      expect(entry.text, `${entry.name} 缺许可证正文`).not.toBeNull();
      expect((entry.text ?? "").length).toBeGreaterThan(200);
      expect(entry.textSource, `${entry.name} 缺正文出处`).not.toBeNull();
      expect(isSpdxIdentifier(entry.license), `${entry.name} 的许可证标识异常：${entry.license}`).toBe(true);
      // 正文出处必须是仓库相对路径：归档后才能被复核，且不夹带机器路径。
      expect(entry.textSource ?? "").not.toMatch(/^[A-Za-z]:/);
    }
  }, REAL_TIMEOUT_MS);

  it("票面点名的依赖角色正确：koffi/zod 随产物走，工具链只算构建期", () => {
    const inventory = collectLicenseInventory(REPO_ROOT, nodeFs);
    const roleOf = (id: string): string => inventory.index.find((entry) => entry.id === id)?.role ?? "missing";
    expect(roleOf("koffi")).toBe("bundled");
    expect(roleOf("zod")).toBe("bundled");
    for (const specifier of ["@yao-pkg/pkg", "esbuild", "typescript", "vitest"]) {
      expect(roleOf(specifier)).toBe("build-only");
    }
    expect(roleOf("node-runtime")).toBe("embedded-runtime");
  }, REAL_TIMEOUT_MS);

  it("内嵌运行时正文逐字来自归档文件，且带 Node 自身的第三方组件清单", () => {
    const inventory = collectLicenseInventory(REPO_ROOT, nodeFs);
    const runtime = inventory.entries.find((entry) => entry.role === "embedded-runtime");
    expect(runtime?.license).toBe("MIT");
    expect(runtime?.textSource).toBe("docs/license/Node.js-v22.23.2-LICENSE.txt");
    expect(runtime?.text).toContain("Copyright Node.js contributors");
    // 内嵌组件（OpenSSL/V8/ICU 等）的许可证必须一并在正文里，否则等于只声明了 Node 自身。
    expect(runtime?.text ?? "").toMatch(/OpenSSL/);
    expect(runtime?.text ?? "").toMatch(/V8/);
  }, REAL_TIMEOUT_MS);
});

describe("清单折叠（纯函数）", () => {
  it("条目顺序与声明一一对应，缺条目或空正文直接报错", () => {
    const { packages, embeddedRuntime } = fakeSources();
    const folded = inventoryFromSources({ packages, embeddedRuntime });
    expect(folded.entries).toHaveLength(INVENTORY_PACKAGES.length + 1);
    expect(folded.index[0]?.id).toBe("koffi");

    expect(() =>
      inventoryFromSources({ packages: packages.slice(1), embeddedRuntime }),
    ).toThrow(/条目数不符/);

    const hollow = packages.map((source, position) =>
      position === 0 ? { ...source, text: "   \n" } : source,
    );
    expect(() => inventoryFromSources({ packages: hollow, embeddedRuntime })).toThrow(/未随包附带许可证正文/);
  });

  it("版权行优先取许可证正文里的 Copyright 行，取不到才退回 package.json 的 author", () => {
    expect(copyrightLine("Permission is hereby granted...\nCopyright (c) 2026 Someone\n", "Author Name")).toBe(
      "Copyright (c) 2026 Someone",
    );
    expect(copyrightLine("Permission is hereby granted...", "Author Name")).toBe("Author Name");
    expect(copyrightLine(null, null)).toBeNull();
  });

  it("机器外路径只留文件名，不把绝对路径写进清单", () => {
    expect(repoRelativePath("D:/repo", "D:/repo/node_modules/zod/LICENSE")).toBe("node_modules/zod/LICENSE");
    expect(repoRelativePath("D:/repo", "C:/Program Files/nodejs/LICENSE")).toBe("LICENSE");
  });
});

describe("第三方声明与清单一致（验收①）", () => {
  it("渲染结果包含每条正文，并与清单逐条对齐", () => {
    const inventory = fakeInventory();
    const document = renderNotices(inventory.entries);
    const integrity = noticesIntegrity(
      document,
      inventory.entries,
      inventory.index.map((entry) => ({ name: entry.name, version: entry.version })),
    );
    expect(integrity.problems).toEqual([]);
    expect(integrity.passed).toBe(true);
  });

  it("正文被改写、条目被删、文件缺失都会报出来", () => {
    const inventory = fakeInventory();
    const document = renderNotices(inventory.entries);
    const required = inventory.index.map((entry) => ({ name: entry.name, version: entry.version }));

    expect(noticesIntegrity(null, inventory.entries, required).problems).toEqual([
      "THIRD-PARTY-NOTICES.md 不在仓库里",
    ]);

    const tampered = document.replace("LICENSE for zod@4.6.5", "LICENSE for zod@9.9.9");
    const problems = noticesIntegrity(tampered, inventory.entries, required).problems;
    expect(problems.some((line) => line.includes("zod") && line.includes("正文与安装树不一致"))).toBe(true);

    const removed = document.replace(/## typescript [^\n]*\n/, "");
    expect(noticesIntegrity(removed, inventory.entries, required).problems.some((line) => line.includes("typescript"))).toBe(true);
  });

  it("仓库里的 THIRD-PARTY-NOTICES.md 与当前安装树逐字一致", () => {
    const inventory = collectLicenseInventory(REPO_ROOT, nodeFs);
    const document = nodeFs.readText(`${REPO_ROOT}/THIRD-PARTY-NOTICES.md`);
    const integrity = noticesIntegrity(
      document,
      inventory.entries,
      inventory.index.map((entry) => ({ name: entry.name, version: entry.version })),
    );
    expect(integrity.problems).toEqual([]);
  }, REAL_TIMEOUT_MS);
});
