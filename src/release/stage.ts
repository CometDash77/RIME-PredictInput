/**
 * 把许可证与第三方声明**放进发布产物**（#27 验收①：许可证文件纳入发布产物）。
 *
 * 只做这一件事：把 `LICENSE` 与生成好的 `THIRD-PARTY-NOTICES.md` 复制到
 * `dist/release/`。安装器与 sidecar 的打包归 S9（#28），这里刻意不碰。
 */
import { nodeFs, type ReleaseFs } from "./fs.js";
import { NOTICES_PATH, noticesIntegrity, renderNotices } from "./notices.js";
import { ARTIFACT_LICENSE, ARTIFACT_NOTICES } from "./shipset.js";
import { collectLicenseInventory, type InventoryCollection } from "./licenses.js";

export interface StageResult {
  readonly staged: readonly { readonly source: string; readonly target: string; readonly bytes: number }[];
  readonly problems: readonly string[];
}

/** 生成 `THIRD-PARTY-NOTICES.md` 正文（写入仓库根与放进产物的那一份都用同一函数）。 */
export function buildNoticesDocument(
  root: string,
  fs: ReleaseFs = nodeFs,
  inventory: InventoryCollection = collectLicenseInventory(root, fs),
): { readonly document: string; readonly problems: readonly string[] } {
  const document = renderNotices(inventory.entries);
  const integrity = noticesIntegrity(
    document,
    inventory.entries,
    inventory.index.map((entry) => ({ name: entry.name, version: entry.version })),
  );
  return { document, problems: integrity.problems };
}

export function stageReleaseArtifacts(
  root: string,
  fs: ReleaseFs = nodeFs,
  inventory: InventoryCollection | null = null,
): StageResult {
  const { document, problems } =
    inventory === null ? buildNoticesDocument(root, fs) : buildNoticesDocument(root, fs, inventory);
  const staged: { source: string; target: string; bytes: number }[] = [];
  const license = fs.readText(`${root}/LICENSE`);
  if (license === null) {
    return { staged, problems: [...problems, "仓库根没有 LICENSE，无法放进产物"] };
  }
  fs.writeText(`${root}/${ARTIFACT_LICENSE}`, license);
  staged.push({ source: "LICENSE", target: ARTIFACT_LICENSE, bytes: license.length });
  fs.writeText(`${root}/${ARTIFACT_NOTICES}`, document);
  staged.push({ source: NOTICES_PATH, target: ARTIFACT_NOTICES, bytes: document.length });
  return { staged, problems };
}
