// Engineering build of the sidecar single-file exe (ADR 0003; issue #9 evidence, #11 ticket).
// Pipeline: dist (via `pnpm build`) -> strip-guard -> esbuild CJS bundle ->
//   @yao-pkg/pkg node22-win-x64 -> PE GUI variant -> selftest equivalence smoke.
// The smoke is the P8 method from issue #9 built into the build: the exe selftest
// report must be byte-identical JSON to `node dist/cli/main.js selftest`.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const distMain = path.join(root, "dist", "cli", "main.js");
const outDir = path.join(root, "build", "exe");
const bundle = path.join(outDir, "sidecar-bundle.cjs");
const exeCui = path.join(outDir, "rime-predict-sidecar.exe");
const exeGui = path.join(outDir, "rime-predict-sidecar-gui.exe");
const TARGET = "node22-win-x64";
const SELFTEST_TIMEOUT_MS = 90000;

function fail(msg) {
  console.error("build:exe FAILED: " + msg);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", ...opts });
  if (r.error) throw r.error;
  return r;
}

// 0. dist must exist — `pnpm build:exe` chains `pnpm build` before this script.
if (!existsSync(distMain)) fail("dist/cli/main.js missing — run `pnpm build` first");

// 1. strip the direct-invocation guard (TLA + import.meta) from dist output.
const sg = run(process.execPath, [path.join(here, "strip-guard.mjs")], { stdio: "inherit" });
if (sg.status !== 0) fail("strip-guard failed");

// 2. self-contained CJS bundle (zod inlined; no external requires left).
await esbuild.build({
  entryPoints: [path.join(here, "exe-entry.mjs")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: bundle,
  sourcemap: false,
  logLevel: "info",
});

// 3. @yao-pkg/pkg -> single exe (bin resolved from the locked devDependency).
const require = createRequire(import.meta.url);
const pkgManifestPath = require.resolve("@yao-pkg/pkg/package.json");
const pkgManifest = JSON.parse(readFileSync(pkgManifestPath, "utf8"));
const pkgDir = path.dirname(pkgManifestPath);
const pkgBinRel = typeof pkgManifest.bin === "string" ? pkgManifest.bin : pkgManifest.bin.pkg;
const pkged = run(process.execPath, [path.join(pkgDir, pkgBinRel), bundle, "-t", TARGET, "--output", exeCui], { stdio: "inherit" });
if (pkged.status !== 0 || !existsSync(exeCui)) fail("pkg build failed");

// 4. GUI variant: PE subsystem byte flip (P0-verified method).
const pe = run(process.execPath, [path.join(here, "pe.mjs"), "copy-gui", exeCui, exeGui], { stdio: "inherit" });
if (pe.status !== 0 || !existsSync(exeGui)) fail("GUI variant failed");

// 5. smoke: selftest equivalence (P8 method) on CUI + GUI.
function selftest(exe, args) {
  const r = run(exe, args, { timeout: SELFTEST_TIMEOUT_MS });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function parseReport(stdout) {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try { return JSON.parse(stdout.slice(start)); } catch { return null; }
}

const baseline = selftest(process.execPath, [distMain, "selftest"]);
const base = parseReport(baseline.stdout);
if (baseline.code !== 0 || base?.status !== "ok") {
  fail("node baseline selftest not green: " + baseline.stdout.slice(0, 400) + baseline.stderr.slice(0, 200));
}

for (const [name, exe] of [["cui", exeCui], ["gui", exeGui]]) {
  const r = selftest(exe, ["selftest"]);
  const j = parseReport(r.stdout);
  const match = j !== null && JSON.stringify(j) === JSON.stringify(base);
  if (r.code !== 0 || !match) {
    fail(name + " selftest mismatch: code=" + r.code + " match=" + match +
      "\nstdout=" + r.stdout.slice(0, 400) + "\nstderr=" + r.stderr.slice(0, 200));
  }
  console.log("smoke " + name + ": code=0, selftest report identical (" + j.checks.length + " checks)");
}

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(1) + "MB";
console.log("build:exe OK");
console.log("  bundle: " + bundle + " (" + mb(bundle) + ")");
console.log("  cui:    " + exeCui + " (" + mb(exeCui) + ")");
console.log("  gui:    " + exeGui + " (" + mb(exeGui) + ")");
