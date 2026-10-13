import { createHash } from "node:crypto";

export interface BundleFile {
  readonly role: string;
  readonly source: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly origin: "fork" | "repo";
  readonly destination: "program" | "feature" | "lua";
  readonly name: string;
}

export interface BundleManifest {
  readonly format: 1;
  readonly productVersion: string;
  readonly fork: {
    readonly version: string;
    readonly tag: string;
    readonly commit: string;
    readonly sourceUrl: string;
    readonly releaseUrl: string;
    readonly archive: string;
    readonly archiveBytes: number;
    readonly archiveSha256: string;
  };
  readonly files: readonly BundleFile[];
}

const REQUIRED_ROLES = [
  "frontend", "frontend-x86", "sidecar-console", "sidecar-window", "settings-page", "launcher",
  "lua-filter", "lua-host", "lua-ipc", "lua-json", "setup", "server", "rime",
  "license", "notices", "installer-tool-license", "restore-guide", "activation-guide",
] as const;

const FORK_ROLES = new Set<string>(["frontend", "frontend-x86", "setup", "server", "rime"]);
const FORK_SUPPORT_FILES = new Set([
  "weasel.ime", "weaselx64.ime", "weaseldeployer.exe", "license.txt", "readme.txt",
  "start_service.bat", "stop_service.bat",
]);
const LUA_NAMES: Readonly<Record<string, string>> = {
  "lua-filter": "model_predict_filter.lua",
  "lua-host": "model_predict_host.lua",
  "lua-ipc": "model_predict_ipc.lua",
  "lua-json": "model_predict_json.lua",
};
const FORBIDDEN_SEGMENTS = new Set([
  "src", "test", "tests", "node_modules", "userdb", "users", "appdata",
  "credentials", "models", "training", "corpus", "datasets",
]);
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function fail(message: string): never {
  throw new Error(`Invalid installer payload: ${message}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a nonempty string`);
  return value;
}

function digest(value: unknown, label: string): string {
  const result = string(value, label);
  if (!HEX_SHA256.test(result)) fail(`${label} must be a lowercase SHA-256 digest`);
  return result;
}

function safeSegment(segment: string): boolean {
  return SAFE_SEGMENT.test(segment)
    && !segment.endsWith(".")
    && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment)
    && !FORBIDDEN_SEGMENTS.has(segment.toLowerCase())
    && !/(?:\.custom\.|^settings\.json$|^diagnostics\.log$|\.userdb(?:\.|$))/i.test(segment);
}

/** The reader receives canonical slash-separated paths contained in a staged bundle. */
function sourcePath(value: unknown): string {
  const result = string(value, "file.source");
  if (!result.split("/").every(safeSegment)) fail(`unsafe source path ${result}`);
  return result;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validatePe(file: BundleFile, bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 64 || view.getUint16(0, true) !== 0x5a4d) fail(`${file.role} is not a PE image (MZ)`);
  const offset = view.getUint32(0x3c, true);
  if (offset < 64 || offset > bytes.byteLength - 24 || view.getUint32(offset, true) !== 0x00004550) {
    fail(`${file.role} is not a PE image (PE signature)`);
  }
  const machine = view.getUint16(offset + 4, true);
  const optionalSize = view.getUint16(offset + 20, true);
  const optional = offset + 24;
  if (optionalSize < 70 || optionalSize > bytes.byteLength - optional) fail(`${file.role} has a truncated PE optional header`);
  const magic = view.getUint16(optional, true);
  if (magic !== 0x10b && magic !== 0x20b) fail(`${file.role} has an unsupported PE optional header`);
  if (!((machine === 0x14c && magic === 0x10b) || (machine === 0x8664 && magic === 0x20b))) {
    fail(`${file.role} must have matching x86 or AMD64 PE headers`);
  }
  const lowerName = file.name.toLowerCase();
  const x86 = file.role === "frontend-x86" || lowerName === "weasel.ime";
  const x64 = ["frontend", "sidecar-console", "sidecar-window", "server", "rime"].includes(file.role)
    || file.role === "launcher" || lowerName === "weaselx64.ime";
  if (x86 && machine !== 0x14c) fail(`${file.role} must be an x86 PE image`);
  if (x64 && machine !== 0x8664) fail(`${file.role} must be an AMD64 PE image`);
  const isDll = (view.getUint16(offset + 22, true) & 0x2000) !== 0;
  if (isDll !== /\.(?:dll|ime)$/.test(lowerName)) fail(`${file.role} PE DLL flag disagrees with filename`);
  const subsystem = view.getUint16(optional + 68, true);
  const expected = file.role === "sidecar-console" ? 3 : file.role === "sidecar-window" ? 2 : undefined;
  if (expected !== undefined && subsystem !== expected) fail(`${file.role} has wrong PE subsystem`);
  if (file.role === "launcher") validateLauncherExport(view, offset, optionalSize);
}

/** package.loadlib resolves this undecorated symbol from the x64 native launcher. */
function validateLauncherExport(view: DataView, peOffset: number, optionalSize: number): void {
  const optional = peOffset + 24;
  if (optionalSize < 120 || view.getUint32(optional + 108, true) < 1) fail("launcher PE has no export directory");
  const sectionCount = view.getUint16(peOffset + 6, true);
  const sectionTable = optional + optionalSize;
  if (sectionTable + sectionCount * 40 > view.byteLength) fail("launcher PE section table is truncated");
  const fileOffset = (rva: number, length: number): number => {
    for (let index = 0; index < sectionCount; index++) {
      const section = sectionTable + index * 40;
      const start = view.getUint32(section + 12, true);
      const size = view.getUint32(section + 16, true);
      const raw = view.getUint32(section + 20, true);
      const relative = rva - start;
      if (relative >= 0 && relative + length <= size && raw + relative + length <= view.byteLength) return raw + relative;
    }
    return fail("launcher PE export RVA is outside file sections");
  };
  const exportRva = view.getUint32(optional + 112, true);
  if (exportRva === 0) fail("launcher PE has no export directory");
  const directory = fileOffset(exportRva, 40);
  const count = view.getUint32(directory + 24, true);
  const functionCount = view.getUint32(directory + 20, true);
  if (count > Math.floor(view.byteLength / 4)) fail("launcher PE export name table is invalid");
  const names = fileOffset(view.getUint32(directory + 32, true), count * 4);
  const symbol = "rime_model_predict_start";
  for (let index = 0; index < count; index++) {
    const name = fileOffset(view.getUint32(names + index * 4, true), symbol.length + 1);
    if (view.getUint8(name + symbol.length) !== 0) continue;
    let matches = true;
    for (let character = 0; character < symbol.length; character++) {
      if (view.getUint8(name + character) !== symbol.charCodeAt(character)) matches = false;
    }
    if (matches) {
      const ordinalTable = fileOffset(view.getUint32(directory + 36, true), count * 2);
      const ordinal = view.getUint16(ordinalTable + index * 2, true);
      if (ordinal >= functionCount) fail("launcher PE export ordinal is invalid");
      const address = fileOffset(view.getUint32(directory + 28, true) + ordinal * 4, 4);
      const target = view.getUint32(address, true);
      if (target === 0) fail("launcher PE export function is missing");
      fileOffset(target, 1);
      return;
    }
  }
  fail(`launcher PE must export ${symbol}`);
}

function validateRole(file: BundleFile): void {
  const luaName = LUA_NAMES[file.role];
  if (luaName !== undefined) {
    if (file.origin !== "repo" || file.destination !== "lua" || file.name !== luaName) fail(`${file.role} has wrong origin, destination or name`);
    return;
  }
  if (FORK_ROLES.has(file.role) || (file.role !== "installer-tool-license" && !REQUIRED_ROLES.includes(file.role as typeof REQUIRED_ROLES[number]))) {
    if (file.origin !== "fork" || file.destination !== "program") fail(`${file.role} must come from the fork into program`);
    const expected: Readonly<Record<string, string>> = {
      frontend: "weaselx64.dll", "frontend-x86": "weasel.dll", setup: "WeaselSetup.exe", server: "WeaselServer.exe", rime: "rime.dll",
    };
    if (expected[file.role] !== undefined && file.name !== expected[file.role]) fail(`${file.role} has wrong filename`);
    if (!FORK_ROLES.has(file.role) && !file.name.toLowerCase().endsWith(".dll")
        && !FORK_SUPPORT_FILES.has(file.name.toLowerCase())) fail("unsupported additional fork payload");
    return;
  }
  const destination = file.role === "launcher" ? "lua" : "feature";
  if (file.origin !== "repo" || file.destination !== destination) fail(`${file.role} must come from the repo into ${destination}`);
  const lower = file.name.toLowerCase();
  if (file.role === "installer-tool-license" && file.name !== "NSIS-LICENSE.txt") fail("incorrect installer tool license filename");
  if (file.role.startsWith("sidecar-") && !lower.endsWith(".exe")) fail(`${file.role} must be an executable`);
  if (file.role === "settings-page" && !lower.endsWith(".html")) fail("settings-page must be HTML");
  if (file.role === "launcher" && file.name !== "rime_model_predict_launcher.dll") fail("launcher must be rime_model_predict_launcher.dll");
  if (["license", "notices", "restore-guide", "activation-guide", "installer-tool-license"].includes(file.role)
      && !/^(?:license|[^.][\w.-]*\.(?:md|txt))$/i.test(file.name)) fail(`${file.role} must be a license or text document`);
}

/** Offline validation: no filesystem, process, or network lookup is hidden behind this boundary. */
export function validatePayload(
  manifest: unknown,
  read: (relativePath: string) => Uint8Array,
  expectedProductVersion: string,
): BundleManifest {
  const root = object(manifest, "manifest");
  if (root["format"] !== 1) fail("unsupported manifest format");
  const productVersion = string(root["productVersion"], "productVersion");
  if (productVersion !== expectedProductVersion) fail("product version mismatch");
  const rawFork = object(root["fork"], "fork");
  const version = string(rawFork["version"], "fork.version");
  const releaseNumber = /^0\.17\.4-predict\.([1-9][0-9]*)$/.exec(version)?.[1];
  if (releaseNumber === undefined) fail("fork.version must be 0.17.4-predict.N");
  const tag = string(rawFork["tag"], "fork.tag");
  if (tag !== `v${version}` && tag !== `predict-0.17.4.${releaseNumber}`) fail("fork tag/version mismatch");
  const commit = string(rawFork["commit"], "fork.commit");
  if (!/^[a-f0-9]{40}$/.test(commit)) fail("fork.commit must be a full lowercase commit SHA");
  const sourceUrl = string(rawFork["sourceUrl"], "fork.sourceUrl");
  const prefix = "https://github.com/CometDash77/weasel";
  const allowedSources = [
    `${prefix}/tree/${tag}`, `${prefix}/tree/${commit}`,
    `${prefix}/archive/refs/tags/${tag}.zip`, `${prefix}/archive/refs/tags/${tag}.tar.gz`,
  ];
  if (!allowedSources.includes(sourceUrl)) fail("fork source URL must identify the pinned fork tag or commit");
  const releaseUrl = string(rawFork["releaseUrl"], "fork.releaseUrl");
  if (releaseUrl !== `${prefix}/releases/tag/${tag}`) fail("fork release URL/tag mismatch");
  const archiveSha256 = digest(rawFork["archiveSha256"], "fork.archiveSha256");
  const archive = sourcePath(rawFork["archive"]);
  const archiveBytes = rawFork["archiveBytes"];
  if (typeof archiveBytes !== "number" || !Number.isSafeInteger(archiveBytes) || archiveBytes <= 0) fail("invalid fork.archiveBytes");
  const rawFiles = root["files"];
  if (!Array.isArray(rawFiles)) fail("files must be an array");
  const roles = new Set<string>();
  const destinations = new Set<string>();
  const files: BundleFile[] = [];
  for (const entry of rawFiles) {
    const raw = object(entry, "file");
    const role = string(raw["role"], "file.role");
    if (!/^[a-z][a-z0-9-]*$/.test(role)) fail(`invalid role ${role}`);
    if (roles.has(role)) fail(`duplicate role ${role}`);
    roles.add(role);
    const source = sourcePath(raw["source"]);
    if (source.toLowerCase() === archive.toLowerCase()) fail("archive cannot be an installed file");
    const sourceName = source.split("/").at(-1);
    if (sourceName === undefined || !/^(?:license|[\w.-]+\.(?:exe|dll|ime|lua|cmd|bat|html|md|txt))$/i.test(sourceName)) {
      fail(`source is not a distributable payload file: ${source}`);
    }
    const name = string(raw["name"], "file.name");
    if (!safeSegment(name)) fail(`unsafe destination name ${name}`);
    const origin = raw["origin"];
    if (origin !== "fork" && origin !== "repo") fail(`invalid origin for ${role}`);
    const destination = raw["destination"];
    if (destination !== "program" && destination !== "feature" && destination !== "lua") fail(`invalid destination for ${role}`);
    const target = `${destination}/${name}`.toLowerCase();
    if (destinations.has(target)) fail(`duplicate destination ${target}`);
    destinations.add(target);
    const bytes = raw["bytes"];
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0) fail(`invalid byte length for ${role}`);
    const file: BundleFile = { role, source, name, origin, destination, bytes, sha256: digest(raw["sha256"], `file ${role} sha256`) };
    validateRole(file);
    files.push(file);
  }
  for (const role of REQUIRED_ROLES) if (!roles.has(role)) fail(`missing required role ${role}`);
  // Finish all structural checks before invoking a reader, so unsafe manifests never reach I/O.
  const archiveContent = read(archive);
  if (!(archiveContent instanceof Uint8Array) || archiveContent.byteLength !== archiveBytes) fail("fork archive size mismatch");
  if (sha256(archiveContent) !== archiveSha256) fail("fork archive SHA-256 mismatch");
  for (const file of files) {
    const bytes = read(file.source);
    if (!(bytes instanceof Uint8Array)) fail(`reader returned invalid bytes for ${file.role}`);
    if (bytes.byteLength !== file.bytes) fail(`size mismatch for ${file.role}`);
    if (sha256(bytes) !== file.sha256) fail(`SHA-256 mismatch for ${file.role}`);
    if (/\.(?:exe|dll|ime)$/i.test(file.name)) validatePe(file, bytes);
  }
  return { format: 1, productVersion, fork: { version, tag, commit, sourceUrl, releaseUrl, archive, archiveBytes, archiveSha256 }, files };
}
