// 从当前工作树导出 release gate 的「干净仓库」夹具（S10/#27）。
//
// 只导出判据真正会读的路径：许可证文本面、凭据基线文件、边界文件、语料来源、
// 模板与产物条目。基线路径从 src/release 的规则里取，避免两处各写一份清单。
//
// 用法：node tools/release/export-fixture.mjs
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const { CREDENTIAL_RULES, BOUNDARY_RULES } = await import(pathToFileURL(path.join(root, "dist/release/credential-policy.js")).href);
const { SHIP_SET_TEXT_SOURCES, GPL_COPY_PATH } = await import(pathToFileURL(path.join(root, "dist/release/gate.js")).href);
const { CORPUS_SOURCES, ARTIFACT_LICENSE, ARTIFACT_NOTICES } = await import(pathToFileURL(path.join(root, "dist/release/shipset.js")).href);
const { RELEASE_NOTES_SOURCES } = await import(pathToFileURL(path.join(root, "dist/release/release-notes.js")).href);
const { EMBEDDED_RUNTIME_LICENSE_PATH } = await import(pathToFileURL(path.join(root, "dist/release/licenses.js")).href);

const paths = [
  ...new Set([
    ...SHIP_SET_TEXT_SOURCES,
    ...CREDENTIAL_RULES.map((rule) => rule.path),
    ...BOUNDARY_RULES.map((rule) => rule.path),
    ...CORPUS_SOURCES,
    ...RELEASE_NOTES_SOURCES,
    "LICENSE",
    GPL_COPY_PATH,
    EMBEDDED_RUNTIME_LICENSE_PATH,
    ARTIFACT_LICENSE,
    ARTIFACT_NOTICES,
  ]),
].sort();

const files = {};
for (const relative of paths) {
  files[relative] = readFileSync(path.join(root, relative), "utf8");
}

const lines = [];
lines.push("/**");
lines.push(" * gate 测试用的「干净仓库」夹具：真实仓库的**最小可判据子集**。");
lines.push(" *");
lines.push(" * 本文件由 `node tools/release/export-fixture.mjs` 从当前工作树导出。判据改了、仓库文件改了");
lines.push(" * 之后重新导出即可；`tests/release-gate.test.ts` 的「夹具同形」测试会把这里的每一条与磁盘上的");
lines.push(" * 真实文件逐字比对，所以夹具不会悄悄漂移成另一套世界。");
lines.push(" *");
lines.push(" * 覆写层（`cleanRepo(overrides)`）的唯一目的：让「故意放一份带作者路径的产物进去，gate 必须挡下」");
lines.push(" * 这类反例可以离线成立（#27 验收⑥）——只证明干净样本通过，不足以证明扫描器在工作。");
lines.push(" */");
lines.push('import { memoryFs, type MemoryFs } from "./release-fixtures.js";');
lines.push("");
lines.push("/** 判据会读到的路径；缺一条 gate 就会在对应检查上报错。 */");
lines.push(`export const FIXTURE_PATHS: readonly string[] = ${JSON.stringify(paths, null, 2)};`);
lines.push("");
lines.push("/** 逐字取自工作树的内容。 */");
lines.push("export const FIXTURE_FILES: Readonly<Record<string, string>> = {");
for (const [relative, text] of Object.entries(files)) {
  lines.push(`  ${JSON.stringify(relative)}:`);
  lines.push(`    ${JSON.stringify(text)},`);
}
lines.push("};");
lines.push("");
lines.push("/** 干净仓库：夹具内容 + 内存覆写层。 */");
lines.push("export function cleanRepo(overrides: Record<string, string> = {}): MemoryFs {");
lines.push("  return memoryFs({ ...FIXTURE_FILES, ...overrides });");
lines.push("}");
lines.push("");

writeFileSync(path.join(root, "tests", "release-repo-fixture.ts"), lines.join("\n"), "utf8");
console.log(`导出 ${paths.length} 个路径到 tests/release-repo-fixture.ts`);
