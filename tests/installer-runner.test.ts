import { join, resolve } from "node:path";
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import type { InstallExecutorPorts } from "../src/install/executor.js";
import { pathTable } from "../src/install/paths.js";
import { parseInstallerArgs, main } from "../src/installer/main.js";
import { sha256 } from "../src/installer/payload.js";
import type { BundleFile, BundleManifest } from "../src/installer/payload.js";
import { runInstaller } from "../src/installer/runner.js";
import type { InstallerRequest, InstallerPorts, InstallJournal, Registration } from "../src/installer/runner.js";
import { windowsInstallerPorts } from "../src/installer/windows.js";

function pe(dll: boolean, x86: boolean, subsystem = 2, launcher = false): Uint8Array {
  const bytes = new Uint8Array(launcher ? 1024 : 256);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x5a4d, true); view.setUint32(0x3c, 64, true);
  view.setUint32(64, 0x4550, true); view.setUint16(68, x86 ? 0x14c : 0x8664, true);
  view.setUint16(84, 112, true); view.setUint16(86, dll ? 0x2000 : 2, true);
  view.setUint16(88, x86 ? 0x10b : 0x20b, true); view.setUint16(156, subsystem, true);
  if (launcher) {
    view.setUint16(70, 1, true); view.setUint16(84, 240, true);
    view.setUint32(148, 512, true); // SizeOfHeaders
    view.setUint32(196, 16, true); // NumberOfRvaAndSizes
    view.setUint32(200, 0x1000, true); view.setUint32(204, 128, true);
    view.setUint32(336, 512, true); view.setUint32(340, 0x1000, true);
    view.setUint32(344, 512, true); view.setUint32(348, 512, true);
    view.setUint32(532, 1, true); view.setUint32(536, 1, true);
    view.setUint32(540, 0x1050, true); view.setUint32(544, 0x1040, true); view.setUint32(548, 0x1048, true);
    view.setUint32(576, 0x1060, true); view.setUint32(592, 0x1100, true);
    bytes.set(new TextEncoder().encode("rime_model_predict_start\0"), 608);
    bytes[768] = 0xc3;
  }
  return bytes;
}

const request: InstallerRequest = {
  action: "install", bundle: resolve("test-bundle"), journal: resolve("test-journal"), version: "0.1.0",
  programFiles: resolve("test-program"), installParent: "Rime", userProfile: resolve("test-user"), appData: resolve("test-user", "AppData"),
};

function fixture() {
  const paths = pathTable(request);
  const bundle = new Map<string, Uint8Array>();
  const disk = new Map<string, Uint8Array>();
  disk.set(join(paths.programRoot, "data", "default.yaml"), new TextEncoder().encode("official shared configuration"));
  const links = new Set<string>();
  const journals: InstallJournal[] = [];
  const calls: string[] = [];
  let registrations: Registration[] = [];
  let failWrite: string | undefined;
  let failJournal = false;
  let ignoreRegister = false;
  let partialRegister = false;
  let ignoreUnregister = false;
  const forkNames: Readonly<Record<string, string>> = { frontend: "weaselx64.dll", "frontend-x86": "weasel.dll", setup: "WeaselSetup.exe", server: "WeaselServer.exe", rime: "rime.dll" };
  const repoNames: Readonly<Record<string, string>> = {
    "sidecar-console": "rime-predict-sidecar.exe", "sidecar-window": "rime-predict-sidecar-gui.exe", "settings-page": "settings.html", launcher: "rime_model_predict_launcher.dll",
    "lua-filter": "model_predict_filter.lua", "lua-host": "model_predict_host.lua", "lua-ipc": "model_predict_ipc.lua", "lua-json": "model_predict_json.lua",
    license: "LICENSE", notices: "THIRD-PARTY-NOTICES.md", "installer-tool-license": "NSIS-LICENSE.txt", "restore-guide": "RESTORE.md", "activation-guide": "ACTIVATE.md",
  };
  const files: BundleFile[] = [];
  for (const [role, name] of Object.entries({ ...forkNames, ...repoNames })) {
    const origin = forkNames[role] === undefined ? "repo" : "fork";
    const destination = origin === "fork" ? "program" : role.startsWith("lua-") || role === "launcher" ? "lua" : "feature";
    const bytes = /\.(exe|dll)$/.test(name) ? pe(name.endsWith(".dll"), role === "setup" || role === "frontend-x86", role === "sidecar-console" ? 3 : 2, role === "launcher") : new TextEncoder().encode(role);
    const source = `${origin}/${name}`;
    bundle.set(resolve(request.bundle, source), bytes);
    files.push({ role, name, source, origin, destination, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const archive = new TextEncoder().encode("release archive fixture");
  bundle.set(resolve(request.bundle, "fork/archive.zip"), archive);
  const manifest: BundleManifest = { format: 1, productVersion: "0.1.0", fork: { version: "0.17.4-predict.2", tag: "predict-0.17.4.2", commit: "a".repeat(40), sourceUrl: "https://github.com/CometDash77/weasel/tree/predict-0.17.4.2", releaseUrl: "https://github.com/CometDash77/weasel/releases/tag/predict-0.17.4.2", archive: "fork/archive.zip", archiveBytes: archive.length, archiveSha256: sha256(archive) }, files };
  const saveManifest = () => bundle.set(join(request.bundle, "manifest.json"), new TextEncoder().encode(JSON.stringify(manifest)));
  saveManifest();
  const systemX64 = resolve("Windows", "System32", "weasel.dll");
  const systemX86 = resolve("Windows", "SysWOW64", "weasel.dll");
  const ports: InstallerPorts = {
    readBundle: (path) => { const bytes = bundle.get(path); if (bytes === undefined) throw new Error("missing payload"); return bytes; },
    kind: async (path) => links.has(path) ? "link" : disk.has(path) ? "file" : [...disk.keys()].some((entry) => entry.startsWith(path + "/") || entry.startsWith(path + "\\")) ? "directory" : "missing",
    readFile: async (path) => { const bytes = disk.get(path); if (bytes === undefined) throw new Error("missing file"); return bytes; },
    entries: async (path) => [...new Set([...disk.keys(), ...links].filter((entry) => entry.startsWith(path + "/") || entry.startsWith(path + "\\")).map((entry) => entry.slice(path.length + 1).split(/[\\/]/)[0] ?? ""))],
    registrations: async () => registrations,
    readJournal: async () => journals.at(-1) ?? null,
    readSidecarPid: async () => null,
    writeJournal: async (_directory, journal) => { if (failJournal) throw new Error("journal unavailable"); journals.push(structuredClone(journal)); calls.push("journal:" + journal.status); },
    executor: (sources): InstallExecutorPorts => ({
      writeArtifact: async ({ path }) => { calls.push("write:" + path); if (failWrite === path) throw new Error("locked file"); const source = sources.get(path); if (source === undefined) throw new Error("missing source"); disk.set(path, ports.readBundle(source)); },
      removeFile: async (path) => { calls.push("delete:" + path); disk.delete(path); },
      removeTree: async (path) => { calls.push("delete-tree:" + path); for (const entry of disk.keys()) if (entry === path || entry.startsWith(path + "/") || entry.startsWith(path + "\\")) disk.delete(entry); },
      registerTsf: async () => { calls.push("register"); if (ignoreRegister) return; const x64 = files.find((f) => f.role === "frontend"); const x86 = files.find((f) => f.role === "frontend-x86"); if (x64 === undefined || x86 === undefined) throw new Error("no fronts"); disk.set(systemX64, ports.readBundle(resolve(request.bundle, x64.source))); if (partialRegister) { registrations = [{ view: "x64", path: systemX64 }]; return; } disk.set(systemX86, ports.readBundle(resolve(request.bundle, x86.source))); registrations = [{ view: "x64", path: systemX64 }, { view: "x86", path: systemX86 }]; },
      unregisterTsf: async () => { calls.push("unregister"); if (!ignoreUnregister) registrations = []; },
      readSidecarPid: async () => null, processImage: async () => null, stopProcess: async () => { throw new Error("Unexpected process stop"); },
    }),
  };
  return { paths, ports, bundle, disk, links, journals, calls, manifest, saveManifest,
    setFailWrite: (path?: string) => { failWrite = path; }, setFailJournal: () => { failJournal = true; }, setIgnoreRegister: () => { ignoreRegister = true; },
    setPartialRegister: () => { partialRegister = true; }, setIgnoreUnregister: () => { ignoreUnregister = true; },
    setOfficial: () => { disk.set(systemX64, new TextEncoder().encode("official")); registrations = [{ view: "x64", path: systemX64 }]; },
    systemX64, systemX86,
    upgradeFrontends: () => {
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        if (file === undefined || !["frontend", "frontend-x86"].includes(file.role)) continue;
        const bytes = new Uint8Array(ports.readBundle(resolve(request.bundle, file.source)));
        bytes[bytes.length - 1] = 99;
        bundle.set(resolve(request.bundle, file.source), bytes);
        files[index] = { ...file, sha256: sha256(bytes) };
      }
      saveManifest();
    },
  };
}

describe("real installer runner with injected IO", () => {
  it("refuses a fresh machine before mutation instead of registering a frontend without shared data", async () => {
    const f = fixture();
    f.disk.delete(join(f.paths.programRoot, "data", "default.yaml"));
    await expect(runInstaller(request, f.ports)).rejects.toThrow("请先安装官方 Weasel 0.17.4");
    expect(f.calls).toEqual([]);
    expect(f.disk.size).toBe(0);
  });
  it("installs, repeats without mutations, and uninstalls through the S8 seam while preserving custom/settings/models", async () => {
    const f = fixture();
    const custom = join(f.paths.rimeUserDirectory, "luna.custom.yaml");
    const models = resolve(request.userProfile, ".ollama", "models", "blob");
    for (const path of [custom, f.paths.settingsFile, models]) f.disk.set(path, new TextEncoder().encode("preserve"));
    const installed = await runInstaller(request, f.ports);
    expect(installed.execution.completed).toBe(true);
    expect(f.calls[0]).toBe("journal:planned");
    expect(installed.guide.join(" ")).toContain("ACTIVATE.md");
    const repeated = await runInstaller(request, f.ports);
    expect(repeated.plan.ops).toEqual([]);
    const uninstalled = await runInstaller({ ...request, action: "uninstall" }, f.ports);
    expect(uninstalled.execution.completed).toBe(true);
    expect(uninstalled.plan.ops[0]?.kind).toBe("unregister");
    for (const path of [custom, f.paths.settingsFile, models]) expect(new TextDecoder().decode(f.disk.get(path))).toBe("preserve");
    expect(f.disk.has(f.paths.frontend)).toBe(false);
  });

  it("records the failed operation and resumes from a new snapshot after an interrupted write", async () => {
    const f = fixture();
    f.setFailWrite(f.paths.frontend);
    const first = await runInstaller(request, f.ports);
    expect(first.execution.completed).toBe(false);
    expect(first.execution.failed?.op).toEqual({ kind: "write", path: f.paths.frontend, digest: f.manifest.files.find((entry) => entry.role === "frontend")?.sha256 });
    expect(f.journals.at(-1)?.status).toBe("failed");
    expect(f.calls).not.toContain("register");
    f.setFailWrite();
    expect((await runInstaller(request, f.ports)).execution.completed).toBe(true);
  });

  it("rejects a corrupt bundle before any installation or journal mutation", async () => {
    const f = fixture();
    f.bundle.set(resolve(request.bundle, "fork/WeaselServer.exe"), new Uint8Array([0]));
    await expect(runInstaller(request, f.ports)).rejects.toThrow("size mismatch");
    expect(f.calls).toEqual([]);
    expect(f.disk.size).toBe(1);
  });

  it("requires a durable journal before writes and retains completed native setup on verification failure", async () => {
    const blocked = fixture(); blocked.setFailJournal();
    await expect(runInstaller(request, blocked.ports)).rejects.toThrow("journal unavailable");
    expect(blocked.disk.size).toBe(1);
    const unregistered = fixture(); unregistered.setIgnoreRegister();
    const result = await runInstaller(request, unregistered.ports);
    expect(result.execution.completed).toBe(false);
    expect(result.execution.failed?.op.kind).toBe("register");
    expect(unregistered.disk.has(join(unregistered.paths.programRoot, "WeaselSetup.exe"))).toBe(true);
    expect(unregistered.journals.at(-1)?.status).toBe("failed");
  });

  it("does not take registration ownership from a marker or a foreign COM DLL", async () => {
    const f = fixture(); f.setOfficial();
    const result = await runInstaller(request, f.ports);
    expect(result.plan.ops.some((op) => op.kind === "register")).toBe(true);
    expect(result.guide.join(" ")).toContain("还原官方");
  });

  it("refuses feature junctions before producing a destructive plan", async () => {
    const f = fixture();
    f.disk.set(join(f.paths.featureRoot, "owned.tmp"), new Uint8Array([1]));
    f.links.add(join(f.paths.featureRoot, "foreign"));
    await expect(runInstaller(request, f.ports)).rejects.toThrow("linked");
    expect(f.calls).toEqual([]);
  });

  it("stops uninstall before deleting files if a status PID belongs to a foreign process", async () => {
    const f = fixture();
    await runInstaller(request, f.ports);
    f.ports.readSidecarPid = async () => 42;
    const realExecutor = f.ports.executor;
    f.ports.executor = (sources, paths) => ({
      ...realExecutor(sources, paths),
      readSidecarPid: async () => 42,
      processImage: async () => resolve("foreign", "app.exe"),
      stopProcess: async () => { throw new Error("Must never terminate a foreign process"); },
    });
    const before = f.calls.length;
    const uninstalled = await runInstaller({ ...request, action: "uninstall" }, f.ports);
    expect(uninstalled.execution.completed).toBe(false);
    expect(uninstalled.execution.failed?.kind).toBe("sidecar-manual");
    expect(uninstalled.execution.retryable).toBe(false);
    expect(f.calls.slice(before).some((call) => call.startsWith("delete"))).toBe(false);
    expect(f.disk.has(f.paths.frontend)).toBe(true);
  });

  it("removes interrupted feature leftovers without scanning unrelated program or Lua files", async () => {
    const f = fixture();
    const leftover = join(f.paths.featureRoot, "interrupted.tmp");
    const programOther = join(f.paths.programRoot, "foreign.txt");
    const luaOther = join(f.paths.luaDirectory, "foreign.lua");
    for (const path of [leftover, programOther, luaOther]) f.disk.set(path, new TextEncoder().encode("extra"));
    const result = await runInstaller(request, f.ports);
    expect(result.execution.completed).toBe(true);
    expect(f.disk.has(leftover)).toBe(false);
    expect(f.disk.has(programOther)).toBe(true);
    expect(f.disk.has(luaOther)).toBe(true);
  });

  it("retains prior verified frontend hashes so an older fork is still ours during uninstall", async () => {
    const f = fixture();
    await runInstaller(request, f.ports);
    const oldKnown = f.journals.at(-1)?.knownFrontends;
    f.upgradeFrontends();
    const result = await runInstaller({ ...request, action: "uninstall" }, f.ports);
    expect(result.plan.ops[0]?.kind).toBe("unregister");
    expect(result.execution.completed).toBe(true);
    expect(f.journals.at(-1)?.knownFrontends).toEqual(expect.arrayContaining([...(oldKnown ?? [])]));
    expect(f.journals.at(-1)?.knownFrontends).toHaveLength(4);
  });

  it("re-registers both COM views for complete old and mixed old/new fork upgrades", async () => {
    for (const mixed of [false, true]) {
      const f = fixture();
      await runInstaller(request, f.ports);
      f.upgradeFrontends();
      if (mixed) {
        const front = f.manifest.files.find((file) => file.role === "frontend");
        if (front === undefined) throw new Error("missing frontend");
        f.disk.set(f.systemX64, f.ports.readBundle(resolve(request.bundle, front.source)));
      }
      const result = await runInstaller(request, f.ports);
      expect(result.plan.ops.some((op) => op.kind === "register")).toBe(true);
      expect(result.execution.completed).toBe(true);
      expect((await runInstaller(request, f.ports)).plan.ops).toEqual([]);
    }
  });

  it("unregisters a half-installed fork before deleting setup, and stops if any owned COM view remains", async () => {
    for (const failedUnregister of [false, true]) {
      const f = fixture(); f.setPartialRegister();
      const install = await runInstaller(request, f.ports);
      expect(install.execution.completed).toBe(false);
      if (failedUnregister) f.setIgnoreUnregister();
      const before = f.calls.length;
      const result = await runInstaller({ ...request, action: "uninstall" }, f.ports);
      expect(result.plan.ops[0]?.kind).toBe("unregister");
      expect(result.execution.completed).toBe(!failedUnregister);
      if (failedUnregister) {
        expect(result.execution.failed?.op.kind).toBe("unregister");
        expect(f.calls.slice(before).some((call) => call.startsWith("delete"))).toBe(false);
        expect(f.disk.has(join(f.paths.programRoot, "WeaselSetup.exe"))).toBe(true);
      }
    }
  });
});

describe("installer entry", () => {
  it("rejects ambiguous/missing options and traversal before invoking IO", () => {
    expect(() => parseInstallerArgs(["install"])).toThrow("Missing");
    expect(() => parseInstallerArgs(["install", "--install-parent", "Rime", "--bundle", "relative"])).toThrow("absolute");
    expect(() => parseInstallerArgs(["install", "--install-parent", "../elsewhere"])).toThrow("plain directory");
  });
  it("help succeeds without executing an install", async () => {
    expect(await main(["--help"])).toBe(0);
  });
});

describe("Windows filesystem port", () => {
  it.skipIf(process.platform !== "win32")("rejects a junction ancestor without reading its foreign payload", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "rime-installer-port-"));
    const foreign = join(temporary, "foreign");
    const link = join(temporary, "junction");
    try {
      await mkdir(foreign);
      await writeFile(join(foreign, "payload.txt"), "foreign");
      await symlink(foreign, link, "junction");
      const ports = windowsInstallerPorts();
      expect(() => ports.readBundle(join(link, "payload.txt"))).toThrow("linked path");
      await expect(ports.kind(join(link, "payload.txt"))).rejects.toThrow("linked path");
      expect(new TextDecoder().decode(await ports.readFile(join(foreign, "payload.txt")))).toBe("foreign");
    } finally {
      await unlink(link).catch(() => undefined);
      const resolvedTemporary = resolve(temporary);
      if (!resolvedTemporary.startsWith(resolve(tmpdir()) + "\\")) throw new Error("Unexpected test cleanup path");
      await rm(resolvedTemporary, { recursive: true, force: true });
    }
  });
});
