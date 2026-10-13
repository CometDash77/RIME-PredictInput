import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = join(root, "build/exe/rime-predict-sidecar-gui.exe");
const runDirectory = join(root, "build", `smoke-settings-${new Date().toISOString().replace(/[^0-9]/g, "")}-${randomBytes(3).toString("hex")}`);
const reportPath = join(runDirectory, "report.json");
const baseUrl = "http://127.0.0.1:48371";
const exec = promisify(execFile);
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const check = (condition, message) => { if (!condition) throw new Error(message); };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function withTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(message)), milliseconds); })]);
  } finally { clearTimeout(timer); }
}
const report = {
  format: 1, startedAt: new Date().toISOString(), source, runDirectory, status: "running",
  requests: [], checks: {}, noInstallOrUac: true, noModelOrUpdateRequests: true,
};
let child;
let exited;
let token;
let output = "";

function isolatedEnv(profile, appData, localAppData) {
  // Windows passes only the first case-insensitive key to child processes.
  const replacements = { USERPROFILE: profile, HOME: profile, APPDATA: appData, LOCALAPPDATA: localAppData };
  const result = {};
  const seen = new Set(Object.keys(replacements).map((key) => key.toLowerCase()));
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    result[key] = value;
  }
  return { ...result, ...replacements };
}

async function hasListener() {
  return await new Promise((done, fail) => {
    const socket = createConnection({ host: "127.0.0.1", port: 48371 });
    socket.setTimeout(800);
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("error", (error) => { socket.destroy(); if (error.code === "ECONNREFUSED") done(false); else fail(error); });
    socket.once("timeout", () => { socket.destroy(); fail(new Error("Listener check timed out")); });
  });
}

async function listenerPids() {
  const script = "$ErrorActionPreference='Stop'; @(Get-NetTCPConnection -LocalPort 48371 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -join ','";
  const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
  return stdout.trim() === "" ? [] : stdout.trim().split(",").map((pid) => Number(pid));
}

async function request(method, path, options = {}) {
  check(path === "/" || path === "/session" || path === "/api/session/end", "Smoke attempted a prohibited request");
  const response = await fetch(baseUrl + path, { method, signal: AbortSignal.timeout(1500), ...options });
  const body = await response.text();
  report.requests.push({ method, path, status: response.status });
  return { response, body };
}

try {
  check(process.platform === "win32", "Packaged GUI smoke requires Windows");
  await mkdir(runDirectory, { recursive: true });
  if (await hasListener()) {
    report.status = "blocked";
    report.reason = "Port 48371 already has a listener; no process was started or terminated.";
    process.exitCode = 2;
  } else {
    const executable = join(runDirectory, "rime-predict-sidecar-gui.exe");
    const profile = join(runDirectory, "profile");
    const appData = join(profile, "AppData", "Roaming");
    const localAppData = join(profile, "AppData", "Local");
    await Promise.all([mkdir(appData, { recursive: true }), mkdir(localAppData, { recursive: true })]);
    await copyFile(source, executable);
    await copyFile(join(root, "assets/settings.html"), join(runDirectory, "settings.html"));
    report.executableSha256 = digest(await readFile(executable));
    report.pageSha256 = digest(await readFile(join(runDirectory, "settings.html")));
    report.environmentIsolated = true;
    token = randomBytes(32).toString("base64url");
    check(token.length === 43, "Unexpected temporary token length");
    const launchedAt = Date.now();
    child = spawn(executable, ["--source", "settings", "--token", token, "--idle-seconds", "4"], {
      cwd: runDirectory, env: isolatedEnv(profile, appData, localAppData), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    report.pid = child.pid;
    child.stdout.on("data", (chunk) => { output = (output + chunk.toString()).slice(-8192); });
    child.stderr.on("data", (chunk) => { output = (output + chunk.toString()).slice(-8192); });
    exited = new Promise((done, fail) => {
      child.once("error", fail);
      child.once("exit", (code, signal) => {
        const exit = { code, signal, elapsedMs: Date.now() - launchedAt };
        report.exit = exit;
        done(exit);
      });
    });
    // Attach rejection handling immediately, including failures during startup polling.
    exited.catch(() => undefined);
    const readyDeadline = Date.now() + 10000;
    let ownerVerified = false;
    while (Date.now() < readyDeadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("GUI sidecar exited before HTTP readiness");
      try {
        const status = JSON.parse(await readFile(join(profile, ".rime-model-predict", "status.json"), "utf8"));
        if (status.pid === child.pid && await hasListener()) {
          const pids = await listenerPids();
          check(pids.length > 0 && pids.every((pid) => pid === child.pid), "Port listener belongs to a different process; refusing HTTP requests");
          ownerVerified = true;
          break;
        }
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
      await delay(100);
    }
    check(ownerVerified, "GUI sidecar did not become ready before timeout");
    report.checks.listenerOwnedBySpawnedProcess = true;
    const page = await request("GET", "/");
    check(page.response.status === 200, "Settings page was not HTTP 200");
    check(!page.body.includes("__NONCE__"), "Page nonce placeholder was not replaced");
    const policy = page.response.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1];
    check(nonce !== undefined && page.body.includes(`nonce="${nonce}"`), "Page inline nonce does not match CSP");
    report.checks.http200AndNonceReplaced = true;
    report.pageBytes = Buffer.byteLength(page.body);
    const session = await request("POST", "/session", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    check(session.response.status === 200 && JSON.parse(session.body).status === "session_ready", "Session registration failed");
    report.checks.sessionRegistered = true;
    const end = await request("POST", "/api/session/end", { headers: { Authorization: `Bearer ${token}` } });
    check(end.response.status === 200 && JSON.parse(end.body).status === "ended", "Session end failed");
    report.checks.sessionEnded = true;
    const exit = await withTimeout(exited, 10000, "GUI sidecar failed to exit after idle timeout");
    check(exit.code === 0 && exit.signal === null, "GUI sidecar did not exit normally");
    report.exit = exit;
    report.checks.idleExit = true;
    const stopped = JSON.parse(await readFile(join(profile, ".rime-model-predict", "status.json"), "utf8"));
    report.lastSidecarState = stopped.state;
    check(stopped.state === "stopped", "Sidecar did not persist its stopped state");
    report.checks.stoppedStatePersisted = true;
    report.status = "passed";
  }
} catch (error) {
  report.status = "failed";
  report.reason = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    report.terminatedOwnChildAfterFailure = child.kill();
    await withTimeout(exited?.catch(() => undefined), 3000, "Own child did not terminate promptly").catch(() => undefined);
  }
  // Never save the disposable session token in output or evidence.
  if (output !== "") report.output = token === undefined ? output : output.replaceAll(token, "<temporary-token>");
  report.finishedAt = new Date().toISOString();
  await mkdir(runDirectory, { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, report: reportPath, reason: report.reason }));
}
