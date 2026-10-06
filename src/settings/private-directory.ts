/**
 * 用户数据目录的私有化。
 *
 * 目录里会出现用户正文、候选与设置，必须只属于当前账户：先去掉继承的 ACL，再只授予
 * 当前账户完全控制。非 Windows 直接返回，便于测试在其它平台运行。
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const UNPRIVATEABLE = "could not establish a private user data directory";

export function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true });
  if (process.platform !== "win32") return;
  const username = process.env["USERNAME"];
  const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
  const icacls = join(systemRoot, "System32", "icacls.exe");
  if (username === undefined || username === "" || !existsSync(icacls)) {
    throw new Error(UNPRIVATEABLE);
  }
  const domain = process.env["USERDOMAIN"] ?? ".";
  const account = domain + "\\" + username + ":(OI)(CI)F";
  const result = spawnSync(icacls, [directory, "/inheritance:r", "/grant:r", account], {
    stdio: "ignore",
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) throw new Error(UNPRIVATEABLE);
}
