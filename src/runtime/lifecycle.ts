/**
 * 伴随进程的生命周期原语：空闲计时、单实例、自有子进程。
 *
 * 与旧实现的两处有意差异写在下面：
 * - Node 没有命名互斥体，单实例改成「应用目录里的锁文件 + 进程存活检查」；
 *   语义仍然是「第二个实例静默退出」，但可测试、可在崩溃后自愈。
 * - 停止子进程是异步的（`await stop()`），因为 Node 没有阻塞式 wait。
 */

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

import { spawnHidden, type ChildHandle, type ChildSpawner, type SpawnOptions } from "./child-process.js";
import { monotonicSeconds } from "./clock.js";
import { isJsonObject } from "../json/guards.js";

export const DEFAULT_IDLE_SECONDS = 60;
export const SIDECAR_LOCK_FILE = "sidecar.lock";

export class IdleTimer {
  readonly #idleSeconds: number;
  readonly #clock: () => number;
  #last: number;

  constructor(idleSeconds: number, clock: () => number = monotonicSeconds) {
    if (idleSeconds <= 0) throw new Error("idle seconds must be positive");
    this.#idleSeconds = idleSeconds;
    this.#clock = clock;
    this.#last = clock();
  }

  touch(): void {
    this.#last = this.#clock();
  }

  expired(now: number = this.#clock()): boolean {
    return now - this.#last >= this.#idleSeconds;
  }
}

export interface LockFileHandle {
  readonly path: string;
  /** 把锁标记为已释放；重复调用无副作用。 */
  release(): void;
}

/** 单实例锁：第二个实例拿到 false 后应当静默退出。 */
export class SingleInstance {
  readonly #path: string;
  readonly #isAlive: (pid: number) => boolean;
  #handle: LockFileHandle | null = null;

  constructor(path: string, isAlive: (pid: number) => boolean = defaultIsAlive) {
    this.#path = path;
    this.#isAlive = isAlive;
  }

  acquire(): boolean {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const descriptor = openSync(this.#path, "wx");
        writeSync(descriptor, JSON.stringify({ pid: process.pid, started: Date.now() }));
        closeSync(descriptor);
        this.#handle = {
          path: this.#path,
          release: () => {
            try {
              if (this.#holdsLock()) unlinkSync(this.#path);
            } catch {
              // 锁文件已经不在；没有需要做的清理。
            }
          },
        };
        return true;
      } catch {
        const owner = this.#readOwnerPid();
        if (owner !== null && this.#isAlive(owner)) return false;
        // 上一个实例崩溃后留下的锁：删掉再试一次。
        try {
          unlinkSync(this.#path);
        } catch {
          // 竞态下别的实例先删掉了；下一轮尝试会重新判断。
        }
      }
    }
    return false;
  }

  close(): void {
    this.#handle?.release();
    this.#handle = null;
  }

  #readOwnerPid(): number | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#path, "utf8"));
    } catch {
      return null;
    }
    if (!isJsonObject(parsed)) return null;
    const pid = parsed["pid"];
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  #holdsLock(): boolean {
    return this.#readOwnerPid() === process.pid;
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 只属于本进程的子进程：启动时无窗口，停止时先请它自己走，再强杀。 */
export class OwnedChildProcess {
  readonly #spawn: ChildSpawner;
  #child: ChildHandle | null = null;

  constructor(spawn: ChildSpawner = spawnHidden) {
    this.#spawn = spawn;
  }

  start(command: readonly string[], options: SpawnOptions = {}): void {
    this.#child = this.#spawn(command, options);
  }

  get running(): boolean {
    return this.#child?.running() ?? false;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get handle(): ChildHandle | null {
    return this.#child;
  }

  async stop(timeoutSeconds = 2): Promise<void> {
    const child = this.#child;
    if (child === null) return;
    this.#child = null;
    if (!child.running()) return;
    child.terminate();
    if (await child.waitForExit(timeoutSeconds * 1000)) return;
    child.kill();
    await child.waitForExit(timeoutSeconds * 1000);
  }
}
