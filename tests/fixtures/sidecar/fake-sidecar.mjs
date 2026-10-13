// Stand-in for the real sidecar process.
//
// It speaks the same two file protocols the shipped runtime does, so these
// tests can watch "on demand launch", "single instance", "idle self exit" and
// "clean stale transients on startup" happen across real process boundaries:
//
//   * `sidecar.lock` in the app directory, created with "wx" and holding
//     `{"pid": <own pid>, "started": <ms>}` - the same record
//     `src/runtime/lifecycle.ts` SingleInstance writes and reads.
//   * `ipc/requests` and `ipc/responses` under the app directory, where a
//     request file counts as activity and anything older than a minute is a
//     stale leftover to remove.
//
// Usage: node fake-sidecar.mjs --root <app directory> [--idle-seconds N]

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const TRANSIENT_GRACE_SECONDS = 60;

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const root = option("--root");
if (root === undefined) {
  process.stderr.write("--root is required\n");
  process.exit(2);
}
const idleSeconds = Number(option("--idle-seconds") ?? "60");
if (!Number.isFinite(idleSeconds) || idleSeconds <= 0) {
  process.stderr.write("--idle-seconds must be positive\n");
  process.exit(2);
}

const lockPath = join(root, "sidecar.lock");
const requestsDirectory = join(root, "ipc", "requests");
const responsesDirectory = join(root, "ipc", "responses");
const statusPath = join(root, "status.json");

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ownerPid() {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
    return Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
  } catch {
    return null;
  }
}

/** Mirror of SingleInstance.acquire: two attempts, a dead owner heals itself. */
function acquire() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, "wx");
      writeSync(descriptor, JSON.stringify({ pid: process.pid, started: Date.now() }));
      closeSync(descriptor);
      return true;
    } catch {
      const pid = ownerPid();
      if (pid !== null && isAlive(pid)) return false;
      if (existsSync(lockPath)) unlinkSync(lockPath);
    }
  }
  return false;
}

/** Second instance: leave without a trace. */
if (!acquire()) process.exit(0);

function removeStale(directory, cutoff) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      removeStale(path, cutoff);
      if (readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true });
      continue;
    }
    if (statSync(path).mtimeMs / 1000 < cutoff) unlinkSync(path);
  }
}

removeStale(requestsDirectory, Date.now() / 1000 - TRANSIENT_GRACE_SECONDS);
removeStale(responsesDirectory, Date.now() / 1000 - TRANSIENT_GRACE_SECONDS);
writeFileSync(statusPath, JSON.stringify({ state: "ready", pid: process.pid }), "utf8");

function hasActivity() {
  return existsSync(requestsDirectory) && readdirSync(requestsDirectory).length > 0;
}

let lastActivity = Date.now();
const poll = setInterval(() => {
  if (hasActivity()) lastActivity = Date.now();
  if (Date.now() - lastActivity < idleSeconds * 1000) return;
  clearInterval(poll);
  // Only the owner releases the lock, and going away leaves no status behind.
  try {
    if (ownerPid() === process.pid) unlinkSync(lockPath);
  } catch {
    /* the owner is gone either way */
  }
  try {
    unlinkSync(statusPath);
  } catch {
    /* nothing to clean */
  }
  process.exit(0);
}, 25);
