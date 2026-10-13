import { isAbsolute, join, resolve } from "node:path";

import { planInstall, planUninstall } from "../domain/install-plan.js";
import type { EnvironmentSnapshot, InstallPlan, PayloadTarget, TsfState } from "../domain/install-plan.js";
import { executePlan } from "../install/executor.js";
import type { ExecutionResult, InstallExecutorPorts } from "../install/executor.js";
import { pathTable } from "../install/paths.js";
import type { InstallPaths, PathTableInput } from "../install/paths.js";
import { sha256, validatePayload } from "./payload.js";
import type { BundleManifest } from "./payload.js";

export interface InstallerRequest extends PathTableInput {
  readonly action: "install" | "uninstall";
  readonly bundle: string;
  readonly journal: string;
  readonly version: string;
}

export interface Registration {
  readonly view: "x64" | "x86";
  readonly path: string;
}

/** Observation ports return facts only. All ownership and plan decisions live here. */
export interface InstallerPorts {
  readBundle(path: string): Uint8Array;
  kind(path: string): Promise<"missing" | "file" | "directory" | "link">;
  readFile(path: string): Promise<Uint8Array>;
  entries(path: string): Promise<readonly string[]>;
  registrations(): Promise<readonly Registration[]>;
  readSidecarPid(path: string): Promise<number | null>;
  readJournal(directory: string): Promise<unknown | null>;
  writeJournal(directory: string, value: InstallJournal): Promise<void>;
  executor(sources: ReadonlyMap<string, string>, paths: InstallPaths): InstallExecutorPorts;
}

export interface InstallJournal {
  readonly format: 1;
  readonly action: "install" | "uninstall";
  readonly version: string;
  readonly fork: BundleManifest["fork"];
  readonly manifest: BundleManifest;
  readonly knownFrontends: readonly KnownFrontend[];
  readonly status: "planned" | "completed" | "failed";
  readonly plan: InstallPlan;
  readonly result?: ExecutionResult;
}

export interface KnownFrontend {
  readonly view: "x64" | "x86";
  readonly sha256: string;
}

export interface InstallerResult {
  readonly paths: InstallPaths;
  readonly plan: InstallPlan;
  readonly execution: ExecutionResult;
  readonly guide: readonly string[];
}

function requireAbsolute(value: string, label: string): void {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
}

/** Does not enumerate user data: only declared targets and our private feature directory. */
async function snapshotFiles(target: PayloadTarget, featureRoot: string, ports: InstallerPorts): Promise<Record<string, string | null>> {
  const files: Record<string, string | null> = {};
  const observe = async (path: string): Promise<void> => {
    const kind = await ports.kind(path);
    if (kind === "link") throw new Error(`Refusing linked installer target: ${path}`);
    if (kind === "directory") throw new Error(`Expected an installer file: ${path}`);
    if (kind === "file") {
      try { files[path] = sha256(await ports.readFile(path)); }
      catch { files[path] = null; }
    }
  };
  for (const artifact of Object.values(target.artifacts)) await observe(artifact.path);
  const scan = async (directory: string): Promise<void> => {
    const kind = await ports.kind(directory);
    if (kind === "link") throw new Error(`Refusing linked feature directory: ${directory}`);
    if (kind === "missing") return;
    if (kind !== "directory") throw new Error(`Expected feature directory: ${directory}`);
    for (const name of await ports.entries(directory)) {
      if (name === "." || name === ".." || /[\\/]/.test(name)) throw new Error("Invalid directory entry");
      const path = join(directory, name);
      if (await ports.kind(path) === "directory") await scan(path);
      else await observe(path);
    }
  };
  await scan(featureRoot);
  return files;
}

function frontendDigests(manifest: BundleManifest): KnownFrontend[] {
  return manifest.files.flatMap<KnownFrontend>((file) => file.role === "frontend" ? [{ view: "x64" as const, sha256: file.sha256 }]
    : file.role === "frontend-x86" ? [{ view: "x86" as const, sha256: file.sha256 }] : []);
}

function previousFrontends(value: unknown): readonly KnownFrontend[] {
  if (value === null) return [];
  if (typeof value !== "object" || !("format" in value) || value.format !== 1) throw new Error("Invalid previous installer journal");
  // Older journals contain no ownership evidence. Do not infer it from a marker or path.
  if (!("knownFrontends" in value)) return [];
  if (!Array.isArray(value.knownFrontends)) throw new Error("Invalid frontend ownership journal");
  return value.knownFrontends.map((entry: unknown): KnownFrontend => {
    if (entry === null || typeof entry !== "object" || !("view" in entry) || !("sha256" in entry)
      || (entry.view !== "x64" && entry.view !== "x86") || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error("Invalid frontend ownership digest");
    }
    return { view: entry.view, sha256: entry.sha256 };
  });
}

interface TsfObservation { readonly ownership: TsfState; readonly currentComplete: boolean }

async function observeTsf(current: readonly KnownFrontend[], known: readonly KnownFrontend[], ports: InstallerPorts): Promise<TsfObservation> {
  const registrations = await ports.registrations();
  if (registrations.length === 0) return { ownership: "none", currentComplete: false };
  let owned = false;
  let currentComplete = true;
  for (const view of ["x64", "x86"] as const) {
    const registration = registrations.find((entry) => entry.view === view);
    if (registration === undefined) { currentComplete = false; continue; }
    const kind = await ports.kind(registration.path);
    if (kind === "link" || kind === "directory") throw new Error("Cannot verify registered TSF image safely");
    if (kind === "missing") { currentComplete = false; continue; }
    // Unreadable registered images fail closed, especially before an uninstall deletes setup.
    const digest = sha256(await ports.readFile(registration.path));
    if (known.some((frontend) => frontend.view === view && frontend.sha256 === digest)) owned = true;
    if (!current.some((frontend) => frontend.view === view && frontend.sha256 === digest)) currentComplete = false;
  }
  return { ownership: owned ? "ours" : "official", currentComplete };
}

/** Validate the complete payload before observing or mutating the installation. */
export async function runInstaller(request: InstallerRequest, ports: InstallerPorts): Promise<InstallerResult> {
  requireAbsolute(request.bundle, "bundle directory");
  requireAbsolute(request.journal, "journal directory");
  const manifestText = new TextDecoder().decode(ports.readBundle(join(request.bundle, "manifest.json")));
  const manifest = validatePayload(JSON.parse(manifestText) as unknown,
    (source) => ports.readBundle(resolve(request.bundle, source)), request.version);
  const currentFrontends = frontendDigests(manifest);
  const priorFrontends = previousFrontends(await ports.readJournal(request.journal));
  const knownFrontends = [...new Map([...priorFrontends, ...currentFrontends].map((frontend) => [`${frontend.view}:${frontend.sha256}`, frontend])).values()];
  const paths = pathTable(request);
  // This package replaces an existing official frontend; it does not distribute
  // dictionaries. Refuse a fresh machine before any product mutation.
  if (request.action === "install" && await ports.kind(join(paths.programRoot, "data", "default.yaml")) !== "file") {
    throw new Error("请先安装官方 Weasel 0.17.4 并保留共享 data 目录，再运行模型预测替换安装器。");
  }
  const artifacts: Record<string, { path: string; digest: string }> = {};
  const sources = new Map<string, string>();
  for (const file of manifest.files) {
    const root = file.destination === "program" ? paths.programRoot : file.destination === "feature" ? paths.featureRoot : paths.luaDirectory;
    const path = join(root, file.name);
    artifacts[file.role] = { path, digest: file.sha256 };
    sources.set(path, resolve(request.bundle, file.source));
  }
  const target: PayloadTarget = {
    artifacts, frontend: "frontend", transient: paths.transientPaths,
    preserves: paths.preservedPaths, sidecarStop: paths.sidecarStop,
  };
  const sidecarPid = await ports.readSidecarPid(paths.statusFile);
  const tsf = await observeTsf(currentFrontends, knownFrontends, ports);
  const snapshot: EnvironmentSnapshot = {
    files: await snapshotFiles(target, paths.featureRoot, ports),
    // S8's single state cannot represent partial/older registration. Installation must
    // re-register unless both views match the new payload; uninstall uses ownership.
    tsf: request.action === "install" && tsf.ownership === "ours" && !tsf.currentComplete ? "official" : tsf.ownership,
    // Model storage is never enumerated or touched by this installer.
    sharedModels: [],
    ...(sidecarPid === null ? {} : { sidecarPid }),
  };
  const plan = request.action === "install" ? planInstall(snapshot, target) : planUninstall(snapshot, target);
  const journal: InstallJournal = { format: 1, action: request.action, version: manifest.productVersion, fork: manifest.fork, manifest, knownFrontends, status: "planned", plan };
  // A failed journal write prevents every product mutation.
  await ports.writeJournal(request.journal, journal);
  const rawExecutor = ports.executor(sources, paths);
  // Verify the native result inside its planned operation, before subsequent deletes.
  // Some native registration utilities return zero even if COM registration failed.
  const execution = await executePlan(plan, {
    ...rawExecutor,
    registerTsf: async (path) => {
      await rawExecutor.registerTsf(path);
      if (!(await observeTsf(currentFrontends, knownFrontends, ports)).currentComplete) throw new Error("TSF registration verification failed; exit Weasel and applications using it, then retry.");
    },
    unregisterTsf: async (path) => {
      await rawExecutor.unregisterTsf(path);
      if ((await observeTsf(currentFrontends, knownFrontends, ports)).ownership === "ours") throw new Error("TSF unregistration verification failed; exit Weasel and applications using it, then retry.");
    },
  });
  await ports.writeJournal(request.journal, { ...journal, status: execution.completed ? "completed" : "failed", result: execution });
  const guide = [...execution.guide];
  if (request.action === "install" && execution.completed) {
    const activation = artifacts["activation-guide"];
    guide.push(`请按 ${activation?.path ?? "随包手动接入指引"} 手动接入模型预测；安装器保留所有 <schema>.custom.yaml 原样。接入后由你手动重新部署 RIME。`);
  }
  return { paths, plan, execution, guide };
}
