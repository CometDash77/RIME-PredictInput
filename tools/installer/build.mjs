// Build from pinned local inputs; production gate checks public release provenance.
// The resulting installer needs no network. This script never installs the product.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const args = new Map();
let candidate = false;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--candidate") { candidate = true; continue; }
  const key = process.argv[i];
  const value = process.argv[++i];
  if (!key?.startsWith("--") || !value || args.has(key)) throw new Error("Invalid build arguments");
  args.set(key, value);
}
const required = key => { const value = args.get(key); if (!value) throw new Error(`Missing ${key}`); return path.resolve(value); };
const archive = required("--fork-archive");
const payloadZip = required("--payload-zip");
const lock = JSON.parse(readFileSync(required("--fork-lock"), "utf8"));
const makensis = required("--makensis");
const sevenzip = required("--sevenzip");
const vcvars = required("--vcvarsall");
const toolchain = JSON.parse(readFileSync(path.join(root, "tools/installer/toolchain.json"), "utf8"));
function run(exe, argv, opts = {}) {
  const result = spawnSync(exe, argv, { cwd: root, encoding: "utf8", windowsHide: true, ...opts });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(exe)} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  return result.stdout;
}
for (const [file, expected] of [[makensis, toolchain.nsis.compilerSha256], [sevenzip, toolchain.sevenzip.exeSha256], [path.join(path.dirname(sevenzip), "7z.dll"), toolchain.sevenzip.dllSha256]]) {
  if (hash(readFileSync(file)) !== expected) throw new Error(`Tool hash mismatch: ${path.basename(file)}`);
}
if (!run(makensis, ["/VERSION"]).trim().endsWith("3.10")) throw new Error("NSIS version mismatch");
const archiveBytes = readFileSync(archive);
if (hash(archiveBytes) !== lock.sha256 || archiveBytes.length !== lock.bytes) throw new Error("Fork archive hash/size mismatch");
const payloadBytes = readFileSync(payloadZip);
if (hash(payloadBytes) !== lock.payloadSha256 || payloadBytes.length !== lock.payloadBytes) throw new Error("Fork payload zip hash/size mismatch");
if (!candidate && (lock.releaseVerified !== true || lock.draft !== false || lock.prerelease !== false || !Number.isSafeInteger(lock.assetId))) {
  throw new Error("A verified published fork release receipt is required; local output is not a release");
}
if (!candidate) {
  const { verifyPublishedFork } = await import(pathToFileURL(path.join(root,"dist/installer/provenance.js")).href);
  await verifyPublishedFork(lock,{sha256:hash(archiveBytes),bytes:archiveBytes.length},async endpoint =>
    JSON.parse(run("gh",["api",`repos/CometDash77/weasel/${endpoint}`])));
}
const product = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const out = path.join(root, "build/installer");
// Fresh unique workspace: no recursive delete of an externally supplied location.
const work = path.join(out, `stage-${Date.now()}`);
const bundle = path.join(work, "bundle");
const extracted = path.join(out, `extract-${Date.now()}`);
mkdirSync(bundle, { recursive: true });
mkdirSync(extracted, { recursive: true });

// Only explicitly pinned files are extracted. Reject paths before invoking 7-Zip.
if (!Array.isArray(lock.files) || !lock.files.length) throw new Error("Missing pinned fork file list");
for (const f of lock.files) {
  if (typeof f.path !== "string" || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(f.path)
      || f.path.split("/").some(s => s === "." || s === "..") || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new Error("Unsafe fork lock entry");
}
run(sevenzip, ["x", "-y", `-o${extracted}`, payloadZip, ...lock.files.map(f => f.path)]);
const files = [];
function stage(role, source, origin, destination, name = path.basename(source), expected = undefined) {
  const bytes = readFileSync(source);
  const sha256 = hash(bytes);
  if (expected !== undefined && (sha256 !== expected.sha256 || bytes.length !== expected.bytes)) throw new Error(`Extracted hash mismatch: ${name}`);
  const relative = `${origin}/${name}`;
  const target = path.join(bundle, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  if (existsSync(target)) throw new Error(`Duplicate staged file: ${name}`);
  copyFileSync(source, target);
  if (hash(readFileSync(target)) !== sha256) throw new Error(`Staged hash mismatch: ${name}`);
  files.push({ role, source: relative, name, origin, destination, sha256, bytes: bytes.length });
}
for (const f of lock.files) stage(f.role, path.join(extracted, f.path), "fork", "program", path.basename(f.path), f);

// MSVC path comes from the declared toolchain, never from an author directory.
const launcher = path.join(out, "rime_model_predict_launcher.dll");
const nativeSource = path.join(root, "tools/installer/launcher.c");
const cmdQuote = value => {
  if (/["\r\n%&|<>^]/.test(value)) throw new Error("Unsupported shell metacharacter in tool path");
  return `"${value}"`;
};
const nativeCmd = `call ${cmdQuote(vcvars)} x64 >nul && cl.exe /nologo /LD /W4 /WX /O2 /utf-8 /Brepro ${cmdQuote(nativeSource)} /Fo${cmdQuote(path.join(out,"launcher.obj"))} /link /OUT:${cmdQuote(launcher)} /IMPLIB:${cmdQuote(path.join(out,"launcher.lib"))} /Brepro advapi32.lib`;
run("cmd.exe", ["/d", "/s", "/c", nativeCmd], { windowsVerbatimArguments: true });
stage("launcher", launcher, "repo", "lua");
for (const [role, name] of [["sidecar-console", "rime-predict-sidecar.exe"], ["sidecar-window", "rime-predict-sidecar-gui.exe"]]) {
  stage(role, path.join(root, "build/exe", name), "repo", "feature");
}
stage("settings-page", path.join(root,"assets/settings.html"), "repo", "feature");
for (const suffix of ["filter", "host", "ipc", "json"]) stage(`lua-${suffix}`, path.join(root,`assets/lua/model_predict_${suffix}.lua`), "repo", "lua");
stage("license", path.join(root,"dist/release/LICENSE"), "repo", "feature");
stage("notices", path.join(root,"dist/release/THIRD-PARTY-NOTICES.md"), "repo", "feature");
const nsisLicense = path.join(root,"docs/license/NSIS-3.10-LICENSE.txt");
if (hash(readFileSync(nsisLicense)) !== toolchain.nsis.licenseSha256) throw new Error("NSIS license provenance mismatch");
stage("installer-tool-license", nsisLicense, "repo", "feature", "NSIS-LICENSE.txt");
stage("restore-guide", path.join(root,"assets/installer/restore.md"), "repo", "feature");
stage("activation-guide", path.join(root,"assets/installer/activate.md"), "repo", "feature");
copyFileSync(archive, path.join(bundle,"fork/archive.bin"));
const manifest = {
  format: 1, productVersion: product.version,
  fork: { version: lock.version, tag: lock.tag, commit: lock.commit, sourceUrl: lock.sourceUrl,
    releaseUrl: lock.releaseUrl, archive: "fork/archive.bin", archiveBytes: archiveBytes.length, archiveSha256: hash(archiveBytes) },
  files: files.sort((a,b) => a.source.localeCompare(b.source)),
};
const { validatePayload } = await import(pathToFileURL(path.join(root,"dist/installer/payload.js")).href);
validatePayload(manifest, source => readFileSync(path.join(bundle,source)), product.version);
writeFileSync(path.join(bundle,"manifest.json"), JSON.stringify(manifest,null,2)+"\n");

const hostBundle = path.join(out,"installer-host.cjs");
await esbuild.build({ entryPoints:[path.join(root,"tools/installer/exe-entry.mjs")], bundle:true, platform:"node", format:"cjs", target:"node22", outfile:hostBundle, sourcemap:false });
const require = createRequire(import.meta.url);
const pkgManifestPath = require.resolve("@yao-pkg/pkg/package.json");
const pkgManifest = JSON.parse(readFileSync(pkgManifestPath,"utf8"));
const pkgBin = typeof pkgManifest.bin === "string" ? pkgManifest.bin : pkgManifest.bin.pkg;
const host = path.join(work,"installer-host.exe");
run(process.execPath, [path.join(path.dirname(pkgManifestPath),pkgBin),hostBundle,"-t",toolchain.runtime,"--output",host]);
if (!run(host,["--help"]).includes("installer-host install|uninstall")) throw new Error("Packaged installer host smoke failed");

// Restrict NSIS source interpolation and enumerate bootstrap deletion without recursion.
if ([work,out].some(value => /["$\r\n]/.test(value))) throw new Error("Unsupported NSIS path");
const output = path.join(out,`rime-predict-${product.version}${candidate?"-candidate":""}-setup.exe`);
const cleanFiles = [], cleanDirs = [];
function enumerate(directory, relative = "") {
  for (const name of readdirSync(directory, {withFileTypes:true})) {
    const rel = relative ? `${relative}\\${name.name}` : name.name;
    if (name.isSymbolicLink()) throw new Error("Linked build stage");
    if (name.isDirectory()) { enumerate(path.join(directory,name.name),rel); cleanDirs.push(rel); }
    else cleanFiles.push(rel);
  }
}
enumerate(work);
const cleanup = path.join(out,"cleanup.nsh");
writeFileSync(cleanup,[...cleanFiles.map(f=>`Delete "$Cache\\${f}"`),...cleanDirs.map(d=>`RMDir "$Cache\\${d}"`),'RMDir "$Cache"'].join("\n")+"\n");
run(makensis,["/NOCONFIG",`/DPRODUCT_VERSION=${product.version}`,`/DSTAGE=${work}`,`/DOUTPUT=${output}`,`/DCLEANUP=${cleanup}`,...(candidate?["/DCANDIDATE=1"]:[]),path.join(root,"tools/installer/setup.nsi")]);
const report = {
  format:1, status:candidate?"candidate-blocked":"packaged", releaseReady:!candidate,
  reason:candidate?"Local fork snapshot; no published fork release receipt. Candidate installer refuses installation.":null,
  productVersion:product.version, fork:manifest.fork, toolchain,
  sourceRevision:run("git",["rev-parse","HEAD"]).trim(),
  workingTreeDirty:run("git",["status","--porcelain"]).trim() !== "",
  manifestSha256:hash(readFileSync(path.join(bundle,"manifest.json"))),
  payloadVerified:files.map(f=>({role:f.role,source:f.source,sha256:f.sha256,bytes:f.bytes,verified:true})),
  installer:{name:path.basename(output),sha256:hash(readFileSync(output)),bytes:readFileSync(output).length},
  host:{sha256:hash(readFileSync(host)),bytes:readFileSync(host).length,helpSmoke:true},
  manualGate:["admin UAC","ProgramData ACL","desktop flash","Weasel window interoperability"],
};
writeFileSync(path.join(out,"build-report.json"),JSON.stringify(report,null,2)+"\n");
copyFileSync(path.join(bundle,"manifest.json"),path.join(out,"manifest.json"));
console.log(JSON.stringify({status:report.status,installer:output,report:path.join(out,"build-report.json")},null,2));
