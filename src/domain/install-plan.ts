/**
 * 安装计划接缝（spec #10「安装计划接缝（唯一新接缝）」）。
 *
 * 安装/升级/卸载/还原全部表达为纯函数：输入环境快照（现有文件、TSF 注册状态、
 * 共享模型），输出操作清单（写/删/注册/还原指引）与保留清单。执行器保持薄壳，
 * 只按清单动手；「装什么、删什么、注不注册、怎么还原」的每个判断都在这里
 * 离线可断言，发布前不依赖真机穷举。
 *
 * spec 的四个动词映射：
 * - 安装 = planInstall（空快照起步）
 * - 升级 = planInstall（摘要不一致自然重写；完全一致 = 空增量，重装幂等）
 * - 卸载 = planUninstall
 * - 还原 = guide 操作（指向官方 Weasel；重装官方始终是用户动作）
 *
 * 路径表归架构票：目标清单里的绝对路径全部由调用方注入，本模块不拼任何路径；
 * 计划里出现的每个路径必然来自快照或目标清单（测试锁死这条不变量）。
 * 共享模型与用户数据（设置、方案、词库）不是自有程序文件：前者只进保留清单，
 * 即便执行器把它的路径误扫进快照，delete 也绝不触及；后者不在扫描范围。
 */

/** TSF 注册现状：定制前端与官方 Weasel 同身份互斥，注册权只在一个前端手里。 */
export type TsfState = "official" | "ours" | "none";

/**
 * 环境快照：执行器探测的现状，契约层只读不查盘。
 * files 只含自有程序文件范围（执行器只扫自有程序根）。
 */
export interface EnvironmentSnapshot {
  /** 绝对路径 → 内容摘要（sha256 十六进制）；null = 存在但不可读，按不匹配处理。 */
  readonly files: Readonly<Record<string, string | null>>;
  readonly tsf: TsfState;
  /** 共享模型路径：只出现在保留清单，绝不出现在任何操作里。 */
  readonly sharedModels: readonly string[];
}

/** 随包目标工件：path 来自注入的路径表，digest 是载荷的期望摘要。 */
export interface PayloadArtifact {
  readonly path: string;
  readonly digest: string;
}

/** 随包目标清单：artifacts 的并集 = 自有程序文件全集；frontend 指向承担 TSF 注册的角色名。 */
export interface PayloadTarget {
  readonly artifacts: Readonly<Record<string, PayloadArtifact>>;
  readonly frontend: string;
}

/** 操作清单（spec 原文四类：写/删/注册/还原指引）；unregister 是卸载侧的注册反操作。 */
export type InstallOp =
  | { readonly kind: "write"; readonly path: string; readonly digest: string }
  | { readonly kind: "delete"; readonly path: string }
  | { readonly kind: "register"; readonly path: string }
  | { readonly kind: "unregister"; readonly path: string }
  | { readonly kind: "guide"; readonly text: string };

export interface InstallPlan {
  readonly ops: readonly InstallOp[];
  /** 保留清单：与任何 write/delete 路径永不相交——「共享模型保留」的离线断言面。 */
  readonly keeps: readonly string[];
}

/** fork 的上游基底；还原指引引用它。fork 换基时只改这里。 */
export const OFFICIAL_WEASEL = {
  version: "0.17.4",
  url: "https://github.com/rime/weasel/releases",
} as const;

/** 还原指引：确定性文本，安装器与卸载器共用同一份。 */
function restoreGuide(): string {
  return [
    "本插件替换了 Weasel（小狼毫）前端。",
    "如需还原官方版本：",
    `1. 下载官方 Weasel ${OFFICIAL_WEASEL.version}：${OFFICIAL_WEASEL.url}`,
    "2. 运行官方安装程序，它会重新注册官方前端。",
    "你的 RIME 方案与词库未被改动。",
  ].join("\n");
}

function sortedPaths(record: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(record).sort();
}

function planOf(ops: InstallOp[], snapshot: EnvironmentSnapshot): InstallPlan {
  return { ops, keeps: [...snapshot.sharedModels] };
}

/** 安装/升级：目标齐则空增量（幂等），缺则补写，多余遗留清掉（中断自愈）。 */
export function planInstall(snapshot: EnvironmentSnapshot, target: PayloadTarget): InstallPlan {
  const protectedPaths = new Set(snapshot.sharedModels);
  const targetPaths = new Set<string>();
  for (const artifact of Object.values(target.artifacts)) targetPaths.add(artifact.path);

  const ops: InstallOp[] = [];

  // 写：缺失、摘要不一致、不可读（null）一律重写——幂等与升级是同一条规则。
  // 按目标路径排序产出：计划不依赖调用方清单的键序。
  const artifacts = [...Object.values(target.artifacts)].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const artifact of artifacts) {
    if (snapshot.files[artifact.path] !== artifact.digest) {
      ops.push({ kind: "write", path: artifact.path, digest: artifact.digest });
    }
  }

  // 删：自有目录里不在目标清单内的遗留文件（中断安装的临时产物）。
  for (const path of sortedPaths(snapshot.files)) {
    if (!targetPaths.has(path) && !protectedPaths.has(path)) {
      ops.push({ kind: "delete", path });
    }
  }

  // 注册：前端被重写或注册权不在手里时（重）注册；已是我们的且前端未动 = 等价空操作。
  const frontend = target.artifacts[target.frontend];
  if (
    frontend !== undefined &&
    (snapshot.tsf !== "ours" || snapshot.files[frontend.path] !== frontend.digest)
  ) {
    ops.push({ kind: "register", path: frontend.path });
  }

  // 还原指引：只有替换了一个在场的官方前端才需要。
  if (snapshot.tsf === "official") ops.push({ kind: "guide", text: restoreGuide() });

  return planOf(ops, snapshot);
}

/** 卸载：反注册 → 全清自有文件（含遗留垃圾）→ 还原指引；共享模型只进保留清单。 */
export function planUninstall(snapshot: EnvironmentSnapshot, target: PayloadTarget): InstallPlan {
  const protectedPaths = new Set(snapshot.sharedModels);
  const ops: InstallOp[] = [];

  const frontend = target.artifacts[target.frontend];
  if (snapshot.tsf === "ours" && frontend !== undefined) {
    ops.push({ kind: "unregister", path: frontend.path });
  }

  for (const path of sortedPaths(snapshot.files)) {
    if (!protectedPaths.has(path)) ops.push({ kind: "delete", path });
  }

  if (snapshot.tsf === "ours") ops.push({ kind: "guide", text: restoreGuide() });

  return planOf(ops, snapshot);
}
