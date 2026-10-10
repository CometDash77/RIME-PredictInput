/**
 * 评测资产 CLI（开发侧工具，不进产品运行面）：
 *   node dist/eval/main.js build  用词库缓存构建并冻结留出集
 *   node dist/eval/main.js check  冻结校验（样本哈希 + 词库缓存身份）
 *   node dist/eval/main.js run    三次一致复跑 rig
 * 命令失败语义（进程退出码）：build/check 失败 = 1；run：0 达标 / 1 不达标 /
 * 2 三次结论不一致 / 3 基建错误。
 */

import path from "node:path";
import process from "node:process";

import { readFile } from "node:fs/promises";

import { buildHoldout, checkFrozen } from "./build-holdout.js";
import { loadFrozen, runRig, summarize, type ArmConfig, type ThresholdConfig } from "./rig.js";

interface CliArgs {
  readonly command: string;
  readonly arm: string | null;
  readonly runs: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let command = "";
  let arm: string | null = null;
  let runs = 3;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) throw new Error("missing argument value");
    if (arg === "--arm") {
      i += 1;
      arm = argv[i] ?? null;
    } else if (arg === "--runs") {
      i += 1;
      runs = Number.parseInt(argv[i] ?? "3", 10);
      if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
    } else if (arg !== "" && !arg.startsWith("--")) {
      command = arg;
    } else {
      throw new Error("unknown argument: " + arg);
    }
  }
  if (command === "") throw new Error("usage: main.js build|check|run --arm <file> [--runs N]");
  return { command, arm, runs };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(import.meta.dirname, "..", "..");
  const cacheDir = path.join(root, "eval", ".cache");
  const holdoutDir = path.join(root, "eval", "holdout");
  const paths = { cacheDir, holdoutDir, reportPath: path.join(cacheDir, "build-report.json") };

  if (args.command === "build") {
    const result = await buildHoldout(paths);
    console.log("built", result.sampleCount, "samples");
    console.log("outside_complete_per_schema:", JSON.stringify(result.outsideCompletePerSchema));
    console.log("beyond_page_per_schema:", JSON.stringify(result.beyondPagePerSchema));
    console.log("rejected individuals:", result.rejected.length, "->", paths.reportPath);
    return 0;
  }

  if (args.command === "check") {
    const problems = await checkFrozen(paths);
    if (problems.length > 0) {
      console.error("frozen assets drifted:");
      for (const problem of problems) console.error(" -", problem);
      return 1;
    }
    console.log("frozen assets verified");
    return 0;
  }

  if (args.command === "run") {
    if (args.arm === null) throw new Error("run requires --arm <file>");
    const arm = JSON.parse(await readFile(args.arm, "utf8")) as ArmConfig;
    const thresholdPath = path.join(holdoutDir, "threshold.json");
    const threshold = JSON.parse(await readFile(thresholdPath, "utf8")) as ThresholdConfig;
    const bundle = await loadFrozen(holdoutDir, cacheDir);
    const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
    const reportPath = path.join(cacheDir, "reports", "run-" + stamp + ".json");
    const report = await runRig(bundle, arm, threshold, args.runs, reportPath);
    console.log(summarize(report));
    console.log("report:", reportPath);
    if (report.final_verdict === "pass") return 0;
    if (report.final_verdict === "fail") return 1;
    return 2;
  }

  throw new Error("unknown command: " + args.command);
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(3);
  });
