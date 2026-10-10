#!/usr/bin/env node
/**
 * 发布工程 CLI（#27）：`pnpm release:check` / `release:notices` / `release:stage`。
 *
 * 单独成入口而不是挂进 sidecar 的子命令：sidecar 单文件 exe 里不需要、也不该带上
 * 一套发布工具。产物本身只带结论——`dist/release/licenses.json` 与 `release-report.json`。
 *
 * 退出码：0 通过 / 1 被挡下（报告里逐条写明缺什么）/ 2 用法错误。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { nodeFs, type ReleaseFs } from "./fs.js";
import { runGate } from "./gate.js";
import type { InventoryCollection } from "./licenses.js";
import { buildNoticesDocument, stageReleaseArtifacts } from "./stage.js";
import { LICENSE_INVENTORY_NAME, RELEASE_ARCHIVE_DIR, RELEASE_REPORT_NAME, RELEASE_TAG_PATTERN } from "./types.js";

const USAGE = [
  "用法: node dist/release/main.js check [--tag v0.1.0]",
  "       node dist/release/main.js notices [--write]",
  "       node dist/release/main.js stage",
].join("\n");

export interface ReleaseCliArgs {
  readonly command: "check" | "notices" | "stage";
  readonly tag: string;
  readonly write: boolean;
}

export function parseReleaseArgs(argv: readonly string[]): ReleaseCliArgs {
  const command = argv[0];
  if (command !== "check" && command !== "notices" && command !== "stage") {
    throw new Error(`无法识别的命令: ${command ?? ""}`);
  }
  let tag = "v0.1.0";
  let write = false;
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--tag") {
      const value = argv[index + 1];
      if (value === undefined || !RELEASE_TAG_PATTERN.test(value)) {
        throw new Error("--tag 需要形如 v0.1.0 或 v0.1.0.3 的发布 tag");
      }
      tag = value;
      index += 1;
      continue;
    }
    if (flag === "--write") {
      write = true;
      continue;
    }
    throw new Error(`无法识别的参数: ${flag ?? ""}`);
  }
  return { command, tag, write };
}

export function repoRootFrom(moduleUrl: string): string {
  // dist/release/main.js -> 仓库根
  return resolve(dirname(fileURLToPath(moduleUrl)), "..", "..");
}

function reportPathOf(root: string, name: string): string {
  return join(root, RELEASE_ARCHIVE_DIR, name);
}

export interface ReleaseCliOptions {
  readonly fs?: ReleaseFs;
  readonly now?: () => number;
  /** 许可证收集器；测试注入替身以免依赖真实 `node_modules`。 */
  readonly inventory?: () => InventoryCollection;
}

export function runReleaseCli(argv: readonly string[], root: string, options: ReleaseCliOptions = {}): number {
  const fs = options.fs ?? nodeFs;
  let args: ReleaseCliArgs;
  try {
    args = parseReleaseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "参数无效"}\n${USAGE}\n`);
    return 2;
  }

  if (args.command === "notices") {
    const { document, problems } =
      options.inventory === undefined
        ? buildNoticesDocument(root, fs)
        : buildNoticesDocument(root, fs, options.inventory());
    if (problems.length > 0) {
      process.stderr.write(`notices 自检失败：\n${problems.map((line) => `  - ${line}`).join("\n")}\n`);
      return 1;
    }
    if (args.write) {
      fs.writeText(join(root, "THIRD-PARTY-NOTICES.md"), document);
      process.stdout.write("已写入 THIRD-PARTY-NOTICES.md\n");
    } else {
      process.stdout.write(document);
    }
    return 0;
  }

  if (args.command === "stage") {
    const { staged, problems } = stageReleaseArtifacts(root, fs, options.inventory?.() ?? null);
    for (const item of staged) process.stdout.write(`放入产物：${item.target}（${String(item.bytes)} 字节）\n`);
    if (problems.length > 0) {
      process.stderr.write(`stage 失败：\n${problems.map((line) => `  - ${line}`).join("\n")}\n`);
      return 1;
    }
    return 0;
  }

  const report = runGate({
    root,
    releaseTag: args.tag,
    fs,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.inventory === undefined ? {} : { inventory: options.inventory }),
  });
  fs.writeText(
    reportPathOf(root, RELEASE_REPORT_NAME),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  fs.writeText(
    reportPathOf(root, LICENSE_INVENTORY_NAME),
    `${JSON.stringify({ schema: report.schema, generatedAt: report.generatedAt, entries: report.licenses }, null, 2)}\n`,
  );
  process.stdout.write(
    `${report.verdict === "pass" ? "PASS" : "BLOCKED"} ${report.releaseTag}：` +
      `${String(report.summary.passed)}/${String(report.summary.total)} 项检查通过\n`,
  );
  for (const check of report.checks) {
    if (check.passed) continue;
    process.stdout.write(`  ✗ ${check.id}：${check.summary}\n`);
    for (const line of check.evidence) process.stdout.write(`      - ${line}\n`);
  }
  process.stdout.write(`报告：${join(RELEASE_ARCHIVE_DIR, RELEASE_REPORT_NAME)}\n`);
  return report.verdict === "pass" ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = runReleaseCli(process.argv.slice(2), repoRootFrom(import.meta.url));
}

