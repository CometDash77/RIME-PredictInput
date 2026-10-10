/**
 * 单实例、空闲释放与启动清理。
 *
 * #24 验收第 1 条要求「Lua 只在需要预测时按需拉起 sidecar；锁文件保证单实例，
 * 默认 60 秒空闲自退，启动时清理过期瞬态运行时文件」。这三件事的实现落在
 * src/runtime/lifecycle.ts 与 src/runtime/runtime.ts 上，这里用真实文件与真实
 * 进程核对：锁文件必须能被另一个进程认出来（tests/fixtures/sidecar/
 * fake-sidecar.mjs 就是那个假 sidecar），否则「按需拉起」只会拉起第二个实例。
 *
 * 滤镜侧的 IPC 行为在 tests/lua-filter.test.ts，本文件只管进程边界。
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { appPaths } from "../src/ipc/app-paths.js";
import { FileIpc } from "../src/ipc/file-ipc.js";
import {
  DEFAULT_IDLE_SECONDS,
  IdleTimer,
  SIDECAR_LOCK_FILE,
  SingleInstance,
} from "../src/runtime/lifecycle.js";

const SIDECAR_SCRIPT = fileURLToPath(new URL("./fixtures/sidecar/fake-sidecar.mjs", import.meta.url));
const ENGINE_ID = "a".repeat(40);

const workspaces: string[] = [];
const children = new Set<ChildProcess>();

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "rime-lifecycle-"));
  workspaces.push(root);
  return root;
}

function lockOwner(root: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(join(root, SIDECAR_LOCK_FILE), "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error("condition was not met before the timeout");
}

interface RunningSidecar {
  readonly pid: number;
  readonly exited: Promise<number | null>;
}

function spawnSidecar(root: string, idleSeconds = 60): RunningSidecar {
  const child = spawn(
    process.execPath,
    [SIDECAR_SCRIPT, "--root", root, "--idle-seconds", String(idleSeconds)],
    { stdio: "ignore", windowsHide: true },
  );
  children.add(child);
  child.on("exit", () => {
    children.delete(child);
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      resolve(code);
    });
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("假 sidecar 没有启动起来");
  return { pid, exited };
}

/** 起一个进程再等它退出，拿到的 pid 就是「已经不在」的那种 pid。 */
async function deadProcessId(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
  const pid = child.pid;
  await new Promise<void>((resolve) => {
    child.on("exit", () => {
      resolve();
    });
  });
  if (pid === undefined) throw new Error("取不到已退出进程的 pid");
  return pid;
}

afterEach(() => {
  for (const child of children) child.kill();
  children.clear();
  while (workspaces.length > 0) {
    const root = workspaces.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("sidecar 只允许一个实例", () => {
  it("同一个应用目录里只能有一个持有者，放开之后才轮到下一个", () => {
    const root = workspace();
    const lockPath = join(root, SIDECAR_LOCK_FILE);
    const first = new SingleInstance(lockPath);
    const second = new SingleInstance(lockPath);

    expect(first.acquire()).toBe(true);
    expect(lockOwner(root)).toBe(process.pid);
    expect(second.acquire()).toBe(false);

    first.close();
    expect(existsSync(lockPath)).toBe(false);
    expect(second.acquire()).toBe(true);
    second.close();
  });

  it("close 只删掉自己持有的锁", () => {
    const root = workspace();
    const lockPath = join(root, SIDECAR_LOCK_FILE);
    const owner = new SingleInstance(lockPath);
    expect(owner.acquire()).toBe(true);

    // 锁被换成了别的 pid：这时候不能替别人解锁。
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 1, started: Date.now() }), "utf8");
    owner.close();
    expect(existsSync(lockPath)).toBe(true);
  });

  it("持有者已经不在、或者锁文件坏掉时，新实例接手", async () => {
    const root = workspace();
    const lockPath = join(root, SIDECAR_LOCK_FILE);

    const dead = await deadProcessId();
    writeFileSync(lockPath, JSON.stringify({ pid: dead, started: Date.now() }), "utf8");
    const recovery = new SingleInstance(lockPath);
    expect(recovery.acquire()).toBe(true);
    expect(lockOwner(root)).toBe(process.pid);
    recovery.close();

    writeFileSync(lockPath, "{ not json", "utf8");
    const corrupt = new SingleInstance(lockPath);
    expect(corrupt.acquire()).toBe(true);
    expect(lockOwner(root)).toBe(process.pid);
    corrupt.close();
  });

  it("锁文件协议在运行时与 sidecar 进程之间互认", async () => {
    const root = workspace();
    const lockPath = join(root, SIDECAR_LOCK_FILE);

    // 运行时先占住锁：假 sidecar 应当安静地走人，不留下任何痕迹。
    const owner = new SingleInstance(lockPath);
    expect(owner.acquire()).toBe(true);
    const blocked = spawnSidecar(root);
    expect(await blocked.exited).toBe(0);
    expect(lockOwner(root)).toBe(process.pid);
    expect(existsSync(join(root, "status.json"))).toBe(false);
    owner.close();

    // 反过来：假 sidecar 占住锁时，运行时也拿不到。
    const running = spawnSidecar(root);
    await waitUntil(() => lockOwner(root) === running.pid);
    expect(new SingleInstance(lockPath).acquire()).toBe(false);
  });
});

describe("空闲释放", () => {
  it("空闲到点才算过期，touch 会重新计时", () => {
    let now = 1000;
    const timer = new IdleTimer(60, () => now);

    expect(timer.expired()).toBe(false);
    now = 1059.999;
    expect(timer.expired()).toBe(false);
    now = 1060;
    expect(timer.expired()).toBe(true);

    timer.touch();
    now = 1119.999;
    expect(timer.expired()).toBe(false);
    now = 1120;
    expect(timer.expired()).toBe(true);
  });

  it("默认空闲 60 秒，非正数直接拒绝", () => {
    expect(DEFAULT_IDLE_SECONDS).toBe(60);
    expect(() => new IdleTimer(0)).toThrow(/idle seconds/);
  });

  it("假 sidecar 空闲到点自行退出，并把锁交还", async () => {
    const root = workspace();
    const running = spawnSidecar(root, 1);
    await waitUntil(() => lockOwner(root) === running.pid);

    expect(await running.exited).toBe(0);
    expect(existsSync(join(root, SIDECAR_LOCK_FILE))).toBe(false);
  });

  it("只要还有请求文件就不退出，安静下来才走", async () => {
    const root = workspace();
    const requests = appPaths(root).requests;
    mkdirSync(requests, { recursive: true });
    const running = spawnSidecar(root, 1);
    await waitUntil(() => lockOwner(root) === running.pid);

    const active = join(requests, "req-active.json");
    writeFileSync(active, "{}", "utf8");
    let settled = false;
    void running.exited.then(() => {
      settled = true;
    });

    await sleep(1600);
    expect(settled).toBe(false);

    rmSync(active);
    await waitUntil(() => settled);
    expect(await running.exited).toBe(0);
  });
});

describe("启动时清理过期瞬态文件", () => {
  it("清掉过期残骸、留下新文件、收掉空目录", () => {
    const root = workspace();
    const paths = appPaths(root);
    mkdirSync(paths.requests, { recursive: true });
    const cutoff = Date.now() / 1000 - 60;

    const staleRequest = join(paths.requests, "req-stale.json");
    const freshRequest = join(paths.requests, "req-fresh.json");
    writeFileSync(staleRequest, "{}", "utf8");
    writeFileSync(freshRequest, "{}", "utf8");
    utimesSync(staleRequest, cutoff - 10, cutoff - 10);
    utimesSync(freshRequest, cutoff + 10, cutoff + 10);

    const engineDirectory = join(paths.responses, ENGINE_ID);
    mkdirSync(engineDirectory, { recursive: true });
    const staleResponse = join(engineDirectory, "response-a.json");
    writeFileSync(staleResponse, "{}", "utf8");
    utimesSync(staleResponse, cutoff - 10, cutoff - 10);

    const ipc = new FileIpc({ requests: paths.requests, responses: paths.responses });
    ipc.cleanTransientFiles(cutoff);

    expect(readdirSync(paths.requests)).toEqual(["req-fresh.json"]);
    // 引擎目录空了就连目录一起收掉，不留垃圾在磁盘上。
    expect(existsSync(engineDirectory)).toBe(false);
    expect(existsSync(freshRequest)).toBe(true);
  });

  it("不传阈值时清掉全部瞬态文件", () => {
    const root = workspace();
    const paths = appPaths(root);
    mkdirSync(paths.requests, { recursive: true });
    const engineDirectory = join(paths.responses, ENGINE_ID);
    mkdirSync(engineDirectory, { recursive: true });
    writeFileSync(join(paths.requests, "req-fresh.json"), "{}", "utf8");
    writeFileSync(join(engineDirectory, "response-a.json"), "{}", "utf8");

    const ipc = new FileIpc({ requests: paths.requests, responses: paths.responses });
    ipc.cleanTransientFiles();

    expect(readdirSync(paths.requests)).toEqual([]);
    expect(readdirSync(paths.responses)).toEqual([]);
  });

  it("假 sidecar 启动时清掉过期残骸", async () => {
    const root = workspace();
    const paths = appPaths(root);
    mkdirSync(paths.requests, { recursive: true });
    const stale = join(paths.requests, "req-stale.json");
    writeFileSync(stale, "{}", "utf8");
    const twoMinutesAgo = Date.now() / 1000 - 120;
    utimesSync(stale, twoMinutesAgo, twoMinutesAgo);

    const running = spawnSidecar(root, 1);
    await waitUntil(() => !existsSync(stale));
    expect(await running.exited).toBe(0);
  });
});
