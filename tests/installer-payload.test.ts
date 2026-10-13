import { describe, expect, it, vi } from "vitest";
import { sha256, validatePayload } from "../src/installer/payload.js";
import type { BundleFile } from "../src/installer/payload.js";

type MutableFile = { -readonly [K in keyof BundleFile]: BundleFile[K] };

function pe(subsystem = 2, dll = false, x86 = false): Uint8Array {
  const bytes = new Uint8Array(256);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x5a4d, true);
  view.setUint32(0x3c, 64, true);
  view.setUint32(64, 0x00004550, true);
  view.setUint16(68, x86 ? 0x14c : 0x8664, true);
  view.setUint16(84, 112, true);
  view.setUint16(86, dll ? 0x2000 : 0x0002, true);
  view.setUint16(88, x86 ? 0x10b : 0x20b, true);
  view.setUint16(156, subsystem, true);
  return bytes;
}

function launcherPe(symbol = "rime_model_predict_start"): Uint8Array {
  const bytes = new Uint8Array(1024);
  bytes.set(pe(2, true));
  const view = new DataView(bytes.buffer);
  view.setUint16(70, 1, true);
  view.setUint16(84, 240, true);
  view.setUint32(196, 16, true);
  view.setUint32(200, 0x1000, true);
  view.setUint32(204, 128, true);
  view.setUint32(340, 0x1000, true);
  view.setUint32(344, 512, true);
  view.setUint32(348, 512, true);
  view.setUint32(532, 1, true);
  view.setUint32(536, 1, true);
  view.setUint32(540, 0x1048, true);
  view.setUint32(544, 0x1040, true);
  view.setUint32(548, 0x1050, true);
  view.setUint32(576, 0x1060, true);
  view.setUint32(584, 0x1100, true);
  bytes.set(new TextEncoder().encode(symbol), 608);
  return bytes;
}

function fixture() {
  const forkNames: Readonly<Record<string, string>> = {
    frontend: "weaselx64.dll", "frontend-x86": "weasel.dll", setup: "WeaselSetup.exe", server: "WeaselServer.exe", rime: "rime.dll",
  };
  const repoNames: Readonly<Record<string, string>> = {
    "sidecar-console": "rime-predict-sidecar.exe", "sidecar-window": "rime-predict-sidecar-gui.exe",
    "settings-page": "settings.html", launcher: "rime_model_predict_launcher.dll",
    "lua-filter": "model_predict_filter.lua", "lua-host": "model_predict_host.lua",
    "lua-ipc": "model_predict_ipc.lua", "lua-json": "model_predict_json.lua",
    license: "LICENSE", notices: "THIRD-PARTY-NOTICES.md", "installer-tool-license": "NSIS-LICENSE.txt",
    "restore-guide": "RESTORE.md", "activation-guide": "ACTIVATE.md",
  };
  const content = new Map<string, Uint8Array>();
  const files: MutableFile[] = [];
  for (const [role, name] of Object.entries({ ...forkNames, ...repoNames })) {
    const origin = forkNames[role] === undefined ? "repo" : "fork";
    const destination = origin === "fork" ? "program" : role.startsWith("lua-") || role === "launcher" ? "lua" : "feature";
    const source = `${origin}/${name}`;
    const bytes = role === "launcher" ? launcherPe() : /\.(?:exe|dll)$/.test(name)
      ? pe(role === "sidecar-console" ? 3 : 2, name.endsWith(".dll"), role === "setup" || role === "frontend-x86")
      : new TextEncoder().encode(`offline fixture ${role}`);
    content.set(source, bytes);
    files.push({ role, name, source, origin, destination, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  const archive = pe(2, false, true);
  content.set("fork/archive.exe", archive);
  const manifest = {
    format: 1 as const,
    productVersion: "0.1.0",
    fork: {
      version: "0.17.4-predict.2", tag: "predict-0.17.4.2", commit: "a".repeat(40),
      sourceUrl: "https://github.com/CometDash77/weasel/archive/refs/tags/predict-0.17.4.2.tar.gz",
      releaseUrl: "https://github.com/CometDash77/weasel/releases/tag/predict-0.17.4.2",
      archive: "fork/archive.exe", archiveBytes: archive.byteLength, archiveSha256: sha256(archive),
    },
    files,
  };
  const read = vi.fn((path: string): Uint8Array => {
    const bytes = content.get(path);
    if (bytes === undefined) throw new Error(`missing ${path}`);
    return bytes;
  });
  return { manifest, content, read };
}

describe("installer payload manifest", () => {
  it("validates the complete offline bundle via only the injected byte reader", () => {
    const f = fixture();
    expect(validatePayload(f.manifest, f.read, "0.1.0")).toEqual(f.manifest);
    expect(f.read.mock.calls.map(([path]) => path)).toEqual([f.manifest.fork.archive, ...f.manifest.files.map((file) => file.source)]);
  });

  it("hashes bytes with the standard SHA-256 vector", () => {
    expect(sha256(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("accepts a v-prefixed release tag and immutable commit source URL", () => {
    const f = fixture();
    f.manifest.fork.tag = "v0.17.4-predict.2";
    f.manifest.fork.releaseUrl = "https://github.com/CometDash77/weasel/releases/tag/v0.17.4-predict.2";
    f.manifest.fork.sourceUrl = `https://github.com/CometDash77/weasel/tree/${f.manifest.fork.commit}`;
    expect(() => validatePayload(f.manifest, f.read, "0.1.0")).not.toThrow();
  });

  it("rejects a product version mismatch before reading any bytes", () => {
    const f = fixture();
    expect(() => validatePayload(f.manifest, f.read, "0.2.0")).toThrow("product version mismatch");
    expect(f.read).not.toHaveBeenCalled();
  });

  it.each([
    "../weaselx64.dll", "/fork/weaselx64.dll", "C:/fork/weaselx64.dll", "fork\\weaselx64.dll",
    "fork//weaselx64.dll", "fork/./weaselx64.dll", "fork/../weaselx64.dll", "src/weaselx64.dll",
    "node_modules/weaselx64.dll", "fork/.git/weaselx64.dll", "Users/bob/weaselx64.dll",
    "fork/weaselx64.dll:stream", "fork/CON.dll", "fork/weaselx64.dll.",
    "fork/userdb/weaselx64.dll", "repo/schema.custom.yaml", "repo/settings.json", "repo/models/model.bin",
  ])("rejects unsafe, source-tree or personal source path %s before I/O", (source) => {
    const f = fixture();
    const file = f.manifest.files[0];
    if (file === undefined) throw new Error("missing fixture file");
    file.source = source;
    expect(() => validatePayload(f.manifest, f.read, "0.1.0")).toThrow("unsafe source path");
    expect(f.read).not.toHaveBeenCalled();
  });

  it.each(["../bad.dll", "bad/name.dll", "bad\\name.dll", "CON", "file.", "scheme.custom.yaml"])("rejects unsafe destination basename %s", (name) => {
    const f = fixture();
    const file = f.manifest.files[0];
    if (file === undefined) throw new Error("missing fixture file");
    file.name = name;
    expect(() => validatePayload(f.manifest, f.read, "0.1.0")).toThrow("unsafe destination name");
    expect(f.read).not.toHaveBeenCalled();
  });

  it.each(["frontend", "frontend-x86", "sidecar-window", "activation-guide", "lua-json", "installer-tool-license"])("rejects missing required role %s", (role) => {
    const f = fixture();
    f.manifest.files = f.manifest.files.filter((file) => file.role !== role);
    expect(() => validatePayload(f.manifest, f.read, "0.1.0")).toThrow(`missing required role ${role}`);
    expect(f.read).not.toHaveBeenCalled();
  });

  it("rejects duplicate roles", () => {
    const f = fixture();
    const file = f.manifest.files[0];
    if (file === undefined) throw new Error("missing fixture file");
    f.manifest.files.push({ ...file });
    expect(() => validatePayload(f.manifest, f.read, "0.1.0")).toThrow("duplicate role");
  });

  it("rejects destination collisions with Windows case folding", () => {
    const f = fixture();
    const file = f.manifest.files[0];
    if (file === undefined) throw new Error("missing fixture file");
    f.manifest.files.push({ ...file, role: "extra-dll", name: file.name.toUpperCase() });
    expect(() => validatePayload(f.manifest, f.read, "0.1.0")).toThrow("duplicate destination");
  });

  it.each(["size", "digest"])("rejects installed file %s mismatch", (kind) => {
    const f = fixture();
    const file = f.manifest.files[0];
    if (file === undefined) throw new Error("missing fixture file");
    if (kind === "size") file.bytes++;
    else file.sha256 = "0".repeat(64);
    expect(() => validatePayload(f.manifest, f.read, "0.1.0")).toThrow(kind === "size" ? "size mismatch" : "SHA-256 mismatch");
  });

  it.each(["size", "digest"])("rejects embedded fork archive %s mismatch", (kind) => {
    const f = fixture();
    if (kind === "size") f.manifest.fork.archiveBytes++;
    else f.manifest.fork.archiveSha256 = "0".repeat(64);
    expect(() => validatePayload(f.manifest, f.read, "0.1.0")).toThrow(kind === "size" ? "archive size mismatch" : "archive SHA-256 mismatch");
  });

  it("rejects installing the archive itself", () => {
    const f = fixture();
    const file = f.manifest.files[0];
    if (file === undefined) throw new Error("missing fixture file");
    file.source = "fork/ARCHIVE.exe";
    expect(() => validatePayload(f.manifest, f.read, "0.1.0")).toThrow("archive cannot be an installed file");
    expect(f.read).not.toHaveBeenCalled();
  });

  it.each([
    ["version", "0.17.4"], ["version", "0.17.4-predict.0"], ["tag", "predict-0.17.4.3"],
    ["commit", "aaaaaaa"], ["sourceUrl", "https://github.com/rime/weasel/tree/predict-0.17.4.2"],
    ["sourceUrl", "https://github.com/CometDash77/weasel/tree/predict-0.17.4"],
    ["sourceUrl", "https://github.com/CometDash77/weasel/tree/predict-0.17.4.2?download=1"],
    ["releaseUrl", "https://github.com/CometDash77/weasel/releases/tag/predict-0.17.4.3"],
    ["releaseUrl", "https://github.com.evil.invalid/CometDash77/weasel/releases/tag/predict-0.17.4.2"],
  ] as const)("rejects untraceable fork %s = %s", (key, value) => {
    const f = fixture();
    f.manifest.fork[key] = value;
    expect(() => validatePayload(f.manifest, f.read, "0.1.0")).toThrow();
    expect(f.read).not.toHaveBeenCalled();
  });

  it.each([
    ["sidecar-console", pe(2)], ["sidecar-window", pe(3)], ["frontend", pe(2, true, true)],
    ["frontend", pe(2, false)], ["frontend-x86", pe(2, true)], ["frontend-x86", pe(2, false, true)], ["server", new Uint8Array(256)],
  ] as const)("rejects invalid PE or architecture/subsystem for %s", (role, bytes) => {
    const f = fixture();
    const file = f.manifest.files.find((entry) => entry.role === role);
    if (file === undefined) throw new Error("missing fixture file");
    f.content.set(file.source, bytes);
    file.bytes = bytes.byteLength;
    file.sha256 = sha256(bytes);
    expect(() => validatePayload(f.manifest, f.read, "0.1.0")).toThrow(/PE/);
  });

  it("rejects a PE header pointer past the byte buffer with a validation error", () => {
    const f = fixture();
    const file = f.manifest.files[0];
    if (file === undefined) throw new Error("missing fixture file");
    const bytes = pe(2, true);
    new DataView(bytes.buffer).setUint32(0x3c, 0xfffffff0, true);
    f.content.set(file.source, bytes);
    file.sha256 = sha256(bytes);
    expect(() => validatePayload(f.manifest, f.read, "0.1.0")).toThrow("PE signature");
  });

  it("rejects arbitrary additional source files, even if assigned a fork role", () => {
    const f = fixture();
    f.manifest.files.push({ role: "fork-source", origin: "fork", destination: "program", source: "fork/source.cpp", name: "source.cpp", bytes: 1, sha256: "0".repeat(64) });
    expect(() => validatePayload(f.manifest, f.read, "0.1.0")).toThrow("not a distributable payload file");
    expect(f.read).not.toHaveBeenCalled();
  });

  it("rejects source code renamed to a distributable destination", () => {
    const f = fixture();
    const file = f.manifest.files.find((entry) => entry.role === "license");
    if (file === undefined) throw new Error("missing fixture file");
    file.source = "repo/backend.ts";
    expect(() => validatePayload(f.manifest, f.read, "0.1.0")).toThrow("not a distributable payload file");
    expect(f.read).not.toHaveBeenCalled();
  });

  it.each([false, true])("accepts an additional fork dependency DLL (x86=%s)", (x86) => {
    const f = fixture();
    const bytes = pe(2, true, x86);
    const source = "fork/WinSparkle.dll";
    f.content.set(source, bytes);
    f.manifest.files.push({ role: "winsparkle", origin: "fork", destination: "program", source, name: "WinSparkle.dll", bytes: bytes.byteLength, sha256: sha256(bytes) });
    expect(() => validatePayload(f.manifest, f.read, "0.1.0")).not.toThrow();
  });

  it.each([
    ["ime-x86", "weasel.ime", pe(2, true, true)],
    ["ime-x64", "weaselx64.ime", pe(2, true)],
    ["deployer", "WeaselDeployer.exe", pe(2, false, true)],
    ["fork-license", "LICENSE.txt", new TextEncoder().encode("GPL-3.0-only")],
    ["fork-readme", "README.txt", new TextEncoder().encode("Weasel README")],
    ["fork-start", "start_service.bat", new TextEncoder().encode("start WeaselServer.exe")],
    ["fork-stop", "stop_service.bat", new TextEncoder().encode("WeaselServer.exe /q")],
  ] as const)("accepts known additional fork file %s", (role, name, bytes) => {
    const f = fixture();
    const source = `fork/${name}`;
    f.content.set(source, bytes);
    f.manifest.files.push({ role, origin: "fork", destination: "program", source, name, bytes: bytes.byteLength, sha256: sha256(bytes) });
    expect(() => validatePayload(f.manifest, f.read, "0.1.0")).not.toThrow();
  });

  it.each(["arbitrary.exe", "arbitrary.bat", "personal.txt"])("rejects unsupported additional fork filename %s", (name) => {
    const f = fixture();
    f.manifest.files.push({ role: "extra", origin: "fork", destination: "program", source: `fork/${name}`, name, bytes: 1, sha256: "0".repeat(64) });
    expect(() => validatePayload(f.manifest, f.read, "0.1.0")).toThrow("unsupported additional fork payload");
    expect(f.read).not.toHaveBeenCalled();
  });

  it.each([
    ["weasel.ime", pe(2, true)], ["weaselx64.ime", pe(2, true, true)], ["weasel.ime", pe(2, false, true)],
    ["WeaselDeployer.exe", new Uint8Array(256)],
  ] as const)("rejects malformed or wrong-architecture additional PE %s", (name, bytes) => {
    const f = fixture();
    const source = `fork/${name}`;
    f.content.set(source, bytes);
    f.manifest.files.push({ role: "extra", origin: "fork", destination: "program", source, name, bytes: bytes.byteLength, sha256: sha256(bytes) });
    expect(() => validatePayload(f.manifest, f.read, "0.1.0")).toThrow(/PE/);
  });

  it("rejects mismatched PE machine and optional-header width", () => {
    const f = fixture();
    const bytes = pe(2, true, true);
    new DataView(bytes.buffer).setUint16(88, 0x20b, true);
    const source = "fork/WinSparkle.dll";
    f.content.set(source, bytes);
    f.manifest.files.push({ role: "extra", origin: "fork", destination: "program", source, name: "WinSparkle.dll", bytes: bytes.byteLength, sha256: sha256(bytes) });
    expect(() => validatePayload(f.manifest, f.read, "0.1.0")).toThrow("matching x86 or AMD64 PE headers");
  });

  it("rejects a command script masquerading as the native launcher role", () => {
    const f = fixture();
    const file = f.manifest.files.find((entry) => entry.role === "launcher");
    if (file === undefined) throw new Error("missing fixture file");
    file.name = "launcher.cmd";
    expect(() => validatePayload(f.manifest, f.read, "0.1.0")).toThrow("launcher must be rime_model_predict_launcher.dll");
    expect(f.read).not.toHaveBeenCalled();
  });

  it.each([
    ["missing export directory", pe(2, true)],
    ["wrong symbol", launcherPe("luaopen_launcher")],
    ["x86 launcher", pe(2, true, true)],
  ] as const)("rejects invalid native launcher: %s", (_label, bytes) => {
    const f = fixture();
    const file = f.manifest.files.find((entry) => entry.role === "launcher");
    if (file === undefined) throw new Error("missing fixture file");
    f.content.set(file.source, bytes);
    file.bytes = bytes.byteLength;
    file.sha256 = sha256(bytes);
    expect(() => validatePayload(f.manifest, f.read, "0.1.0")).toThrow(/launcher/);
  });

  it.each([0, 0xfffffffe])("rejects a launcher export with invalid function RVA %s", (target) => {
    const f = fixture();
    const file = f.manifest.files.find((entry) => entry.role === "launcher");
    if (file === undefined) throw new Error("missing fixture file");
    const bytes = launcherPe();
    new DataView(bytes.buffer).setUint32(584, target, true);
    f.content.set(file.source, bytes);
    file.sha256 = sha256(bytes);
    expect(() => validatePayload(f.manifest, f.read, "0.1.0")).toThrow(/launcher PE export/);
  });
});
