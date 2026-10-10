/**
 * 把许可证清单渲染成随产物分发的 `THIRD-PARTY-NOTICES.md`，并核对它没跑偏。
 *
 * 文档里嵌的是**许可证正文本身**（不是摘要、不是链接）：发布产物要能离线自证，
 * 读到的许可证措辞与依赖里那一份逐字相同。`integrityProblems` 是给测试与 gate 用的
 * 反查：正文缺失、条目缺失、正文与安装树不一致，都会在这里被点出来。
 */
import type { LicenseEntry, LicenseRole } from "./types.js";

export const NOTICES_PATH = "THIRD-PARTY-NOTICES.md";

const ROLE_LABEL: Readonly<Record<LicenseRole, string>> = {
  bundled: "随产物分发（sidecar 运行时依赖）",
  "build-only": "仅构建期使用（不进产物）",
  "embedded-runtime": "内嵌运行时",
};

const HEADER = [
  "# 第三方许可证与版权声明（THIRD-PARTY-NOTICES）",
  "",
  "> 本文件由 `pnpm release:notices -- --write` 依据 `src/release/` 的清单生成：每个条目的版本、",
  "> 许可证标识与**许可证正文**都读自权威来源（当前安装树 `node_modules/<pkg>/`，内嵌运行时读归档的官方正文），",
  "> 不手写、不摘录。`pnpm release:check` 会在发布前核对此文件与来源一致，缺条目或正文漂移即挡下发布。",
  "",
  "本仓库自有代码按 MIT 授权（见 `LICENSE`）。本文件覆盖**随产物分发的第三方组件**，",
  "以及构建这些产物时实际用到的工具链——工具链不进产物，列在这里是为了让「这个产物是怎么造出来的」可复核。",
  "**不覆盖** GPL-3.0-only 授权的小狼毫（Weasel）衍生作品：那一份是独立发布、独立提供对应源码的，",
  "见 `docs/fork/build-and-release.md` 与 Release notes 的「源码义务清单」。",
  "",
];

function entrySection(entry: LicenseEntry): string[] {
  const lines: string[] = [];
  lines.push(`## ${entry.name} ${entry.version}`);
  lines.push("");
  lines.push(`- 角色：${ROLE_LABEL[entry.role]}`);
  lines.push(`- 许可证：${entry.license}`);
  if (entry.homepage !== null) lines.push(`- 来源：${entry.homepage}`);
  if (entry.textSource !== null) lines.push(`- 许可证正文出处：\`${entry.textSource}\``);
  if (entry.note !== null) lines.push(`- 版权行：${entry.note}`);
  lines.push("");
  lines.push("```text");
  lines.push((entry.text ?? "（许可证正文缺失）").replace(/\r\n/g, "\n").trimEnd());
  lines.push("```");
  lines.push("");
  return lines;
}

export function renderNotices(entries: readonly LicenseEntry[]): string {
  const lines = [...HEADER];
  for (const entry of entries) lines.push(...entrySection(entry));
  lines.push(
    [
      "## 内嵌 Node 运行时的第三方组件",
      "",
      "`@yao-pkg/pkg` 打出的单文件 exe 内嵌官方 Node 运行时（MIT）。上面的运行时条目里已**逐字**带上",
      "官方 `LICENSE` 正文——该文件同时包含 Node 自身与其内嵌第三方组件（OpenSSL、V8、zlib、ICU 等）的许可证。",
      "归档位置与来源见 `docs/license/README.md`，哈希与报告条目 `licenses.embedded-node` 交叉核对。",
      "",
    ].join("\n"),
  );
  return lines.join("\n");
}

export interface NoticesIntegrity {
  readonly passed: boolean;
  readonly problems: readonly string[];
}

/**
 * 反查 `THIRD-PARTY-NOTICES.md` 与安装树的一致性。
 * 判据只有两条硬规则：必须出现的条目一个不少、每条都要有许可证正文。
 */
export function noticesIntegrity(
  document: string | null,
  entries: readonly LicenseEntry[],
  requiredIds: readonly { readonly name: string; readonly version: string }[],
): NoticesIntegrity {
  const problems: string[] = [];
  if (document === null) {
    return { passed: false, problems: ["THIRD-PARTY-NOTICES.md 不在仓库里"] };
  }
  for (const required of requiredIds) {
    const heading = `## ${required.name} ${required.version}`;
    if (!document.includes(heading)) problems.push(`缺少条目：${heading}`);
  }
  for (const entry of entries) {
    if (entry.text === null || entry.text.trim().length === 0) {
      problems.push(`条目 ${entry.name}@${entry.version} 没有许可证正文`);
      continue;
    }
    const body = entry.text.replace(/\r\n/g, "\n").trimEnd();
    if (!document.includes(body)) {
      problems.push(`条目 ${entry.name}@${entry.version} 的许可证正文与安装树不一致`);
    }
  }
  return { passed: problems.length === 0, problems };
}
