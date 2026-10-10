/**
 * 安装计划的执行器薄壳：只执行 `InstallOp`，不在 IO 层重新决策。
 *
 * 边界（票面验收标准③）：
 * - 「写什么、删什么、注册什么」全部由 `planInstall` / `planUninstall` 在环境快照上判定。
 *   执行器不读回摘要来决定跳过某次写入——那会变成第二次决策，而且用的是与计划不同的观测点。
 * - 执行器只做计划做不到的两件事：把操作排成稳定顺序、把失败的步骤原样记下来供重试。
 *
 * 顺序：同种操作内按路径升序，种类之间沿用计划里首次出现的次序。`planUninstall` 的
 * unregister → stop-sidecar → delete → delete-tree → guide 是语义顺序（先反注册再删前端、
 * 先停进程再删文件），全局按路径重排会把它打散，所以只做种类内的路径排序。
 *
 * 失败处理：第一个失败即停，后续操作不执行——它们的前提是前面已经成功（卸载尤其如此）。
 * 自愈靠重跑：重新取一份快照、重新规划，计划本身对已消失项是幂等的（验收标准②⑤⑥）。
 *
 * IO 端口由调用方注入，执行器自身不碰文件系统、不碰进程表，因此可以被纯快照重放测试覆盖
 * （验收标准⑦）。
 */

import type { InstallOp, InstallPlan } from "../domain/install-plan.js";

/** 一次产物写入：摘要是它的身份，字节由端口实现按摘要取。 */
export interface ArtifactWrite {
  readonly path: string;
  readonly digest: string;
}

export interface InstallExecutorPorts {
  /** 写入一份随包产物。 */
  writeArtifact(write: ArtifactWrite): Promise<void>;
  /** 删除单个文件；目标已不存在视为成功（卸载重跑的幂等性，验收标准⑤）。 */
  removeFile(path: string): Promise<void>;
  /** 删除整棵目录树；目标已不存在视为成功。 */
  removeTree(path: string): Promise<void>;
  /** 注册 TSF 前端（替换后的 WeaselTSF.dll 留在程序根的原因，见 paths.ts 的 R1）。 */
  registerTsf(path: string): Promise<void>;
  /** 反注册 TSF 前端。 */
  unregisterTsf(path: string): Promise<void>;
  /**
   * 读 `status.json` 里的 pid：文件不可读、字段缺失或不是正整数时返回 null。
   * 返回 null 表示「没有可终止的进程」，执行器不去猜。
   */
  readSidecarPid(statusFile: string): Promise<number | null>;
  /** 查 pid 的进程映像路径；进程已经不在时返回 null。 */
  processImage(pid: number): Promise<string | null>;
  /**
   * 终止一个已经校验过映像的进程。
   * 把 `image` 一起传下去，是为了让实现能在真正下手前再复核一次——校验与终止之间仍有时间窗。
   */
  stopProcess(pid: number, image: string): Promise<void>;
}

/** 失败的种类决定重试语义。 */
export type ExecutionFailureKind =
  /** IO 失败：原样重跑同一计划就有机会推进。 */
  | "io"
  /** `status.json` 指向的进程不是本插件的伴随进程：绝不盲杀，需人先手动退出再重跑。 */
  | "sidecar-manual";

export interface ExecutionFailure {
  /** 失败的步骤，原样记下供重试。 */
  readonly op: InstallOp;
  readonly kind: ExecutionFailureKind;
  readonly message: string;
}

export interface ExecutionResult {
  readonly completed: boolean;
  /** 已成功执行的步骤数（含被收集的 guide）。 */
  readonly applied: number;
  /** 计划里的还原指引，按顺序收集；执行器不落 IO，交给调用方呈现。 */
  readonly guide: readonly string[];
  /** 第一个失败的步骤；`completed` 为 true 时不存在。 */
  readonly failed?: ExecutionFailure;
  /** 仅 `failed.kind === "io"` 时为 true；成功时为 false。需人先动手的失败不算可重试。 */
  readonly retryable: boolean;
}

/** 执行整份安装计划。第一个失败即停，返回结果里带着失败步骤。 */
export async function executePlan(plan: InstallPlan, ports: InstallExecutorPorts): Promise<ExecutionResult> {
  const ops = orderedOps(plan.ops);
  const guide: string[] = [];
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index];
    if (op === undefined) continue;
    const failed = await applyOp(op, ports, guide);
    if (failed !== null) {
      return { completed: false, applied: index, guide, failed, retryable: failed.kind === "io" };
    }
  }
  return { completed: true, applied: ops.length, guide, retryable: false };
}

async function applyOp(
  op: InstallOp,
  ports: InstallExecutorPorts,
  guide: string[],
): Promise<ExecutionFailure | null> {
  try {
    switch (op.kind) {
      case "write": {
        await ports.writeArtifact({ path: op.path, digest: op.digest });
        return null;
      }
      case "delete": {
        await ports.removeFile(op.path);
        return null;
      }
      case "delete-tree": {
        await ports.removeTree(op.path);
        return null;
      }
      case "register": {
        await ports.registerTsf(op.path);
        return null;
      }
      case "unregister": {
        await ports.unregisterTsf(op.path);
        return null;
      }
      case "guide": {
        guide.push(op.text);
        return null;
      }
      case "stop-sidecar": {
        return await stopSidecar(op, ports);
      }
    }
  } catch (error) {
    return { op, kind: "io", message: describeError(error) };
  }
}

/**
 * 终止 sidecar 前的守卫（S6/#15 Q6）：读 pid → 校验进程映像属于可终止清单 → 才停。
 * 校验不过时交回给人，返回「请手动退出后重试」；任何情况下都不盲目 kill。
 */
async function stopSidecar(
  op: Extract<InstallOp, { kind: "stop-sidecar" }>,
  ports: InstallExecutorPorts,
): Promise<ExecutionFailure | null> {
  const pid = await ports.readSidecarPid(op.statusFile);
  if (pid === null || pid <= 0) return null;
  const image = await ports.processImage(pid);
  if (image === null) return null;
  if (!op.images.some((allowed) => sameImage(allowed, image))) {
    return {
      op,
      kind: "sidecar-manual",
      message:
        op.statusFile +
        " 报告的进程 " +
        String(pid) +
        " 映像是 " +
        image +
        "，不在可终止清单内（" +
        op.images.join("、") +
        "）。请手动退出残留的伴随进程后重试。",
    };
  }
  await ports.stopProcess(pid, image);
  return null;
}

/** Windows 路径大小写不敏感、正反斜杠混写；比对前统一，避免把自家进程认成外人。 */
function sameImage(left: string, right: string): boolean {
  return normalizeImage(left) === normalizeImage(right);
}

function normalizeImage(value: string): string {
  const trimmed = value.trim().replace(/^"|"$/g, "");
  return trimmed.replace(/\//g, "\\").toLowerCase();
}

/**
 * 稳定排序：种类之间保持计划里的先后，种类之内按路径升序；路径也相同时保留原始次序。
 */
function orderedOps(ops: readonly InstallOp[]): readonly InstallOp[] {
  const rankOf = new Map<string, number>();
  for (const op of ops) {
    if (!rankOf.has(op.kind)) rankOf.set(op.kind, rankOf.size);
  }
  return ops
    .map((op, index) => ({ op, index }))
    .sort((left, right) => {
      const byKind = (rankOf.get(left.op.kind) ?? 0) - (rankOf.get(right.op.kind) ?? 0);
      if (byKind !== 0) return byKind;
      const leftPath = opPath(left.op);
      const rightPath = opPath(right.op);
      if (leftPath !== rightPath) return leftPath < rightPath ? -1 : 1;
      return left.index - right.index;
    })
    .map((entry) => entry.op);
}

/** 排序键：guide 不带路径，同种之内靠原始次序稳定。 */
function opPath(op: InstallOp): string {
  switch (op.kind) {
    case "guide":
      return "";
    case "stop-sidecar":
      return op.statusFile;
    default:
      return op.path;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
