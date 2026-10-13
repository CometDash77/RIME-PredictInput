/**
 * Release notes 的必备内容判据（#27 验收④）。
 *
 * 判据是**正则**而不是「像不像那份文件」：模板可以改措辞、可以重排，但那些必须让用户
 * 看到的东西——上游基底、sidecar 双变体、安装器、支持矩阵、隐私声明、安装/卸载/手动全清/还原、
 * 源码义务清单、校验方法——一条都不能少。少一条，release 就被挡在门外。
 *
 * 检查跑在**合并文本**上：fork 侧的 `docs/fork/release-template.md`（上游基底、源码义务、
 * 支持矩阵）与主仓库侧的 `docs/release-notes-template.md`（本仓产物、隐私、安装卸载）
 * 合成一份用户实际会读到的正文。
 */
import { nodeFs, type ReleaseFs } from "./fs.js";
import {
  FORK_URL,
  LIBRIME_URL,
  REPO_URL,
  UPSTREAM_WEASEL_COMMIT,
  UPSTREAM_WEASEL_TAG,
  type ReleaseNoteCheck,
  type ReleaseNotesReport,
} from "./types.js";

export const RELEASE_NOTES_SOURCES: readonly string[] = [
  "docs/release-notes-template.md",
  "docs/fork/release-template.md",
];

interface NoteRequirement {
  readonly id: string;
  readonly label: string;
  /** 全部命中才算这条内容在场。 */
  readonly required: readonly string[];
  /** 至少命中一个即可（措辞可换的地方用）。 */
  readonly anyOf?: readonly string[];
}

export const NOTE_REQUIREMENTS: readonly NoteRequirement[] = [
  {
    id: "fork-base",
    label: "fork 上游基底与源码链接",
    required: [UPSTREAM_WEASEL_TAG, UPSTREAM_WEASEL_COMMIT.slice(0, 7), FORK_URL, "predict-0.17.4"],
  },
  {
    id: "sidecar-variants",
    label: "sidecar 双变体",
    required: ["rime-predict-sidecar.exe", "rime-predict-sidecar-gui.exe"],
    anyOf: ["CUI", "GUI"],
  },
  {
    id: "installer",
    label: "安装器产物",
    required: ["weasel-0.17.4-predict", "installer.exe"],
  },
  {
    id: "support-matrix",
    label: "支持矩阵",
    required: ["Windows 10 x64", "Windows 11 x64", "x64-only"],
  },
  {
    id: "privacy-statement",
    label: "隐私声明",
    required: ["隐私"],
    anyOf: ["不持久化", "默认关闭"],
  },
  {
    id: "install-guide",
    label: "安装指引",
    required: ["安装"],
    anyOf: ["UAC"],
  },
  {
    id: "uninstall-guide",
    label: "卸载指引",
    required: ["卸载", "TSF"],
  },
  {
    id: "manual-clean",
    label: "手动全清指引",
    required: ["手动"],
    anyOf: ["全清", "清空", "清理"],
  },
  {
    id: "restore-guide",
    label: "还原指引",
    required: ["还原"],
    anyOf: ["settings.json", "官方 Weasel"],
  },
  {
    id: "source-obligations",
    label: "源码义务清单",
    required: ["GPL-3", FORK_URL + "/archive/refs/tags/predict-0.17.4", LIBRIME_URL, REPO_URL],
  },
  {
    id: "verification",
    label: "发布前校验方法",
    required: ["sha256", "release:check"],
  },
];

export interface NotesInput {
  readonly fs: ReleaseFs;
  readonly root: string;
  readonly sources?: readonly string[];
}

/** 合并所有来源文件的正文；缺文件按空串处理并由 gate 报错。 */
export function readReleaseNotes(input: NotesInput): { readonly text: string; readonly sources: readonly string[] } {
  const sources = input.sources ?? RELEASE_NOTES_SOURCES;
  const chunks: string[] = [];
  for (const source of sources) {
    const text = input.fs.readText(`${input.root}/${source}`);
    chunks.push(text ?? "");
  }
  return { text: chunks.join("\n\n"), sources };
}

export function checkReleaseNotes(text: string, requirements: readonly NoteRequirement[] = NOTE_REQUIREMENTS): readonly ReleaseNoteCheck[] {
  return requirements.map((requirement) => {
    const missing = requirement.required.filter((needle) => !text.includes(needle));
    if (requirement.anyOf !== undefined && !requirement.anyOf.some((needle) => text.includes(needle))) {
      missing.push(`（任一即可）${requirement.anyOf.join(" / ")}`);
    }
    return { id: requirement.id, passed: missing.length === 0, missing };
  });
}

export function releaseNotesReport(input: NotesInput): ReleaseNotesReport {
  const { text, sources } = readReleaseNotes(input);
  return {
    sources,
    charCount: text.length,
    checks: checkReleaseNotes(text),
  };
}

export function notesReportForRoot(root: string, fs: ReleaseFs = nodeFs): ReleaseNotesReport {
  return releaseNotesReport({ fs, root });
}
