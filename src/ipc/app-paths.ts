/**
 * 用户级目录布局。
 *
 * 所有路径都从 root 派生一次，避免各处自行拼接而出现两个不同的物理目录；
 * USERPROFILE 缺失时直接报错，不允许悄悄回落到相对路径。
 */
import { isAbsolute, join } from "node:path";

export const APP_DIRECTORY = ".rime-model-predict";

export interface AppPaths {
  readonly root: string;
  readonly requests: string;
  readonly responses: string;
  readonly settings: string;
  readonly log: string;
  readonly status: string;
}

export function appPaths(root: string): AppPaths {
  if (!isAbsolute(root)) throw new Error("application data path must be absolute");
  return {
    root,
    requests: join(root, "ipc", "requests"),
    responses: join(root, "ipc", "responses"),
    settings: join(root, "settings.json"),
    log: join(root, "diagnostics.log"),
    status: join(root, "status.json"),
  };
}

export function appPathsForUser(userProfile?: string | null): AppPaths {
  const base = userProfile ?? process.env["USERPROFILE"];
  if (base === undefined || base === "") throw new Error("USERPROFILE is unavailable");
  return appPaths(join(base, APP_DIRECTORY));
}
