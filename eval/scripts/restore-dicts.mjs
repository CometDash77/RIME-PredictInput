/**
 * Restores the gitignored eval dictionary cache (eval/.cache/dicts) from the
 * frozen manifest: downloads each dict file from GitHub raw at the pinned
 * commit and verifies sha256 + byte length against eval/holdout/manifest.json.
 *
 * The rig (src/eval/rig.ts loadFrozen) and eval:check both require this cache;
 * a fresh clone has none. Run: node eval/scripts/restore-dicts.mjs
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const manifestPath = path.join(repoRoot, "eval", "holdout", "manifest.json");
const dictsDir = path.join(repoRoot, "eval", ".cache", "dicts");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const repos = {};

let failures = 0;
for (const [name, schema] of Object.entries(manifest.schemas)) {
  const short = schema.repo.split("/")[1];
  const destDir = path.join(dictsDir, short);
  await mkdir(destDir, { recursive: true });
  repos[schema.repo] = { commit: schema.commit };
  for (const [file, expected] of Object.entries(schema.files)) {
    const dest = path.join(destDir, file);
    const existing = await readFile(dest).catch(() => null);
    if (existing !== null) {
      const sha = createHash("sha256").update(existing).digest("hex");
      if (sha === expected.sha256 && existing.byteLength === expected.bytes) {
        console.log("ok     " + name + "/" + file + " (cached)");
        continue;
      }
    }
    const url = "https://raw.githubusercontent.com/" + schema.repo + "/" + schema.commit + "/cn_dicts/" + file;
    const response = await fetch(url);
    if (!response.ok) {
      console.error("FAIL   " + name + "/" + file + " HTTP " + response.status + " " + url);
      failures += 1;
      continue;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha !== expected.sha256 || bytes.byteLength !== expected.bytes) {
      console.error("FAIL   " + name + "/" + file + " digest drift: got " + bytes.byteLength + "B/" + sha);
      failures += 1;
      continue;
    }
    await writeFile(dest, bytes);
    console.log("ok     " + name + "/" + file + " (" + bytes.byteLength + "B)");
  }
}

await writeFile(
  path.join(dictsDir, "provenance.json"),
  JSON.stringify({ repos, restored_at: new Date().toISOString() }, null, 2) + "\n",
  "utf8",
);

if (failures > 0) {
  console.error(failures + " file(s) failed");
  process.exit(1);
}
console.log("dict cache restored: " + dictsDir);
