/**
 * 发布工具的注入面：文件系统、摘要与路径拼接。
 *
 * gate 的每条规则都跑在这一层之上，因此全部规则都能在内存机器上离线重放——包括
 * 「故意放一份带作者路径的产物进去，gate 必须挡下」这种反例（#27 验收⑥）。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export interface ReleaseFs {
  /** 读 UTF-8 文本；不存在或读不动返回 null（检查自己决定算不算失败）。 */
  readText(path: string): string | null;
  /** 写 UTF-8 文本，必要时建目录；失败抛错。 */
  writeText(path: string, text: string): void;
  /** 列目录（只返回文件名）；目录不存在返回空数组。 */
  list(path: string): readonly string[];
  /** 递归列出文件，返回相对 `base` 的路径，正斜杠分隔、码位升序。 */
  walk(base: string): readonly string[];
}

export function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** 真实文件系统。摘要统一用 sha256 十六进制，报告里出现的哈希都是这一种。 */
export const nodeFs: ReleaseFs = {
  readText(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  writeText(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "utf8");
  },
  list(path) {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
  walk(base) {
    const found: string[] = [];
    const visit = (directory: string): void => {
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const child = join(directory, entry.name);
        // 只跟真目录：符号链接一律按文件处理，避免 pnpm 存储里的链环造成无限递归。
        if (entry.isDirectory()) visit(child);
        else found.push(toPosix(relative(base, child)));
      }
    };
    visit(base);
    found.sort();
    return found;
  },
};

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 清单摘要：逐文件「路径 + 内容哈希」的规范化文本再取哈希。
 * 只哈希路径不足以发现「同一批文件内容被换过」，只哈希内容又不足以发现增删。
 */
export function manifestDigest(entries: readonly { readonly path: string; readonly sha256: string }[]): string {
  const lines = entries.map((entry) => `${entry.sha256}  ${entry.path}`);
  return sha256Hex(lines.join("\n") + "\n");
}
