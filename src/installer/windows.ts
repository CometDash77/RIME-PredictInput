import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { promisify } from "node:util";

import type { InstallExecutorPorts } from "../install/executor.js";
import type { InstallPaths } from "../install/paths.js";
import type { InstallJournal, InstallerPorts, Registration } from "./runner.js";

const run = promisify(execFile);
// WeaselSetup/imesetup.cpp and WeaselTSF/Globals.cpp use this shared TSF identity.
export const WEASEL_TSF_CLSID = "{A3F4CDED-B1E9-41EE-9CA6-7B4D0DE6CB0A}";

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Refuse junction/symlink ancestors as well as linked leaves. No recursive foreign traversal. */
function safePath(path: string): string {
  if (!isAbsolute(path)) throw new Error("Installer IO requires absolute paths");
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Refusing linked path: ${current}`);
    } catch (error) { if (!isMissing(error)) throw error; }
  }
  return absolute;
}

function psString(value: string): string { return `'${value.replace(/'/g, "''")}'`; }

async function powershell(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function registrations(): Promise<readonly Registration[]> {
  const key = `CLSID\\${WEASEL_TSF_CLSID}\\InprocServer32`;
  const json = await powershell(`$ErrorActionPreference='Stop'; $result=@(); foreach($v in @('Registry64','Registry32')) { $b=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::ClassesRoot,[Microsoft.Win32.RegistryView]::$v); try {$k=$b.OpenSubKey(${psString(key)}); if($null -ne $k) {try {$p=$k.GetValue(''); if($p -is [string] -and $p.Length -gt 0) {$result+=@{view=$(if($v -eq 'Registry64'){'x64'}else{'x86'});path=$p}}} finally {$k.Dispose()}}} finally {$b.Dispose()}}; ConvertTo-Json -InputObject @($result) -Compress`);
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value)) throw new Error("Invalid TSF registry observation");
  return value.map((entry: unknown): Registration => {
    if (entry === null || typeof entry !== "object" || !("view" in entry) || !("path" in entry)
      || (entry.view !== "x64" && entry.view !== "x86") || typeof entry.path !== "string") throw new Error("Invalid TSF registry value");
    return { view: entry.view, path: entry.path };
  });
}

async function processImage(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid process ID");
  const image = await powershell(`$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($null -ne $p) {if([string]::IsNullOrEmpty($p.ExecutablePath)){throw 'Cannot verify process image'}; $p.ExecutablePath}`);
  return image === "" ? null : image;
}

async function readSidecarPid(path: string): Promise<number | null> {
  try {
    const data: unknown = JSON.parse(await readFile(safePath(path), "utf8"));
    if (data !== null && typeof data === "object" && "pid" in data && typeof data.pid === "number" && Number.isSafeInteger(data.pid) && data.pid > 0) return data.pid;
    return null;
  } catch { return null; }
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const destination = safePath(path);
  await mkdir(safePath(dirname(destination)), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx");
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, safePath(destination));
  } finally { await rm(temporary, { force: true }); }
}

async function setup(paths: InstallPaths, action: "/s" | "/u"): Promise<void> {
  // Native setup installs/removes both COM views, using the same flags as upstream.
  await run(safePath(join(paths.programRoot, "WeaselSetup.exe")), [action], { cwd: safePath(paths.programRoot), windowsHide: true });
  if (action === "/s") {
    await run("reg.exe", ["add", "HKLM\\Software\\Rime\\Weasel", "/v", "InstallDir", "/t", "REG_SZ", "/d", dirname(paths.programRoot), "/f", "/reg:32"], { windowsHide: true });
  }
}

function executor(sources: ReadonlyMap<string, string>, paths: InstallPaths): InstallExecutorPorts {
  return {
    writeArtifact: async ({ path, digest }) => {
      const source = sources.get(path);
      if (source === undefined) throw new Error("Unmapped payload target");
      const bytes = await readFile(safePath(source));
      if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error("Payload changed after validation");
      await atomicWrite(path, bytes);
    },
    removeFile: async (path) => { await rm(safePath(path), { force: true }); },
    removeTree: async (path) => {
      // Explicit transient directories only. Reject links anywhere before recursive removal.
      const check = async (entry: string): Promise<void> => {
        try {
          const stat = await lstat(safePath(entry));
          if (stat.isDirectory()) for (const name of await readdir(entry)) await check(join(entry, name));
        } catch (error) { if (!isMissing(error)) throw error; }
      };
      await check(path);
      await rm(safePath(path), { recursive: true, force: true });
    },
    registerTsf: async () => setup(paths, "/s"),
    unregisterTsf: async () => setup(paths, "/u"),
    readSidecarPid, processImage,
    stopProcess: async (pid, image) => {
      await powershell(`$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($null -ne $p) {if($p.ExecutablePath -ine ${psString(image)}){throw 'Process image changed; retry'}; $r=Invoke-CimMethod -InputObject $p -MethodName Terminate; if($r.ReturnValue -ne 0){throw 'Cannot terminate sidecar'}}`);
    },
  };
}

async function writeJournal(directory: string, value: InstallJournal): Promise<void> {
  await mkdir(safePath(directory), { recursive: true });
  // The journal contains paths, hashes and operation results, never user configuration/content.
  await run("icacls.exe", [safePath(directory), "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { windowsHide: true });
  await atomicWrite(join(directory, "operation.json"), Buffer.from(JSON.stringify(value, null, 2) + "\n"));
}

export function windowsInstallerPorts(): InstallerPorts {
  if (process.platform !== "win32") throw new Error("Installer requires Windows");
  return {
    readBundle: (path) => readFileSync(safePath(path)),
    kind: async (path) => {
      try {
        const stat = await lstat(safePath(path));
        return stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "file";
      } catch (error) { if (isMissing(error)) return "missing"; throw error; }
    },
    readFile: (path) => readFile(safePath(path)),
    entries: (path) => readdir(safePath(path)),
    registrations, readSidecarPid, writeJournal, executor,
    readJournal: async (directory) => {
      try { return JSON.parse(await readFile(safePath(join(directory, "operation.json")), "utf8")) as unknown; }
      catch (error) { if (isMissing(error)) return null; throw error; }
    },
  };
}
