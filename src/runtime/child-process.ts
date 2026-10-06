/**
 * 子进程句柄：只暴露本插件真正需要的四个动作。
 *
 * 旧实现直接用 `subprocess.Popen` 并靠 `poll()/terminate()/wait()` 组合，
 * 这里把它收成一个窄接口，方便测试注入假句柄（真实进程在单测里既慢又脆）。
 */

import { spawn } from "node:child_process";

export interface ChildHandle {
  readonly pid: number | undefined;
  running(): boolean;
  /** Python 的 `poll()`：返回退出码，仍在运行则为 null。 */
  exitCode(): number | null;
  terminate(): void;
  kill(): void;
  /** 等待退出；超时返回 false（Python 抛 TimeoutExpired）。 */
  waitForExit(timeoutMs: number): Promise<boolean>;
}

export interface SpawnOptions {
  readonly env?: Readonly<Record<string, string>>;
}

export type ChildSpawner = (command: readonly string[], options?: SpawnOptions) => ChildHandle;

const EXIT_POLL_MS = 20;

function spawnWith(command: readonly string[], options: SpawnOptions = {}): ChildHandle {
  const [executable, ...rest] = command;
  if (executable === undefined) throw new Error("command must not be empty");
  const child = spawn(executable, rest, {
    // 无控制台窗口、无管道：子进程的任何输出都不该回到伴随进程。
    stdio: "ignore",
    windowsHide: true,
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
  });
  let failed = false;
  child.on("error", () => {
    failed = true;
  });
  child.unref?.();
  return {
    pid: child.pid,
    running: () => !failed && child.exitCode === null && child.signalCode === null,
    exitCode: () => (failed ? 1 : child.exitCode),
    terminate: () => {
      try {
        child.kill();
      } catch {
        // 已经退出；调用方会用 waitForExit 判断结果。
      }
    },
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // 同上。
      }
    },
    waitForExit: async (timeoutMs: number) => {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      for (;;) {
        if (!failed && child.exitCode === null && child.signalCode === null) {
          if (Date.now() >= deadline) return false;
          await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS));
          continue;
        }
        return true;
      }
    },
  };
}

export const spawnHidden: ChildSpawner = spawnWith;
