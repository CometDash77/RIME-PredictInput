import { isAbsolute, resolve } from "node:path";

import type { InstallerRequest } from "./runner.js";
import { runInstaller } from "./runner.js";
import { windowsInstallerPorts } from "./windows.js";

const HELP = "installer-host install|uninstall --bundle <absolute> --program-files <absolute> --install-parent <directory> --user-profile <absolute> --app-data <absolute> --rime-user-directory <absolute> --journal <absolute> --version <product-version>";

export function parseInstallerArgs(argv: readonly string[]): InstallerRequest {
  const action = argv[0];
  if (action !== "install" && action !== "uninstall") throw new Error(HELP);
  const keys = new Set(["bundle", "program-files", "install-parent", "user-profile", "app-data", "rime-user-directory", "journal", "version"]);
  const args = new Map<string, string>();
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (key === undefined || !argv[i]?.startsWith("--") || !keys.has(key) || value === undefined || value.startsWith("--") || args.has(key)) throw new Error(HELP);
    args.set(key, value);
  }
  const required = (key: string): string => {
    const value = args.get(key);
    if (value === undefined || value.trim() === "") throw new Error(`Missing --${key}`);
    if (key !== "version" && key !== "install-parent" && !isAbsolute(value)) throw new Error(`--${key} must be absolute`);
    return value;
  };
  const installParent = required("install-parent");
  if (!isAbsolute(installParent) && (installParent === "." || installParent === ".." || /[\\/]/.test(installParent))) throw new Error("--install-parent must be absolute or a plain directory name");
  return { action, bundle: required("bundle"), programFiles: required("program-files"), installParent,
    userProfile: required("user-profile"), appData: required("app-data"), rimeUserDirectory: required("rime-user-directory"),
    journal: required("journal"), version: required("version") };
}

/** Separate callable entry for the packaged EXE shim; importing this module never installs. */
export async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "/?")) { console.log(HELP); return 0; }
  try {
    const request = parseInstallerArgs(argv);
    const profile = process.env["USERPROFILE"];
    if (profile === undefined || resolve(profile).toLowerCase() !== resolve(request.userProfile).toLowerCase()) {
      throw new Error("请使用当前 Windows 账户的管理员提升运行；暂不支持切换账户输入管理员凭证。");
    }
    const programData = process.env["ProgramData"];
    if (programData === undefined || !resolve(request.journal).toLowerCase().startsWith(resolve(programData).toLowerCase() + "\\")) throw new Error("Journal must be a dedicated directory under ProgramData");
    const result = await runInstaller(request, windowsInstallerPorts());
    for (const guide of result.guide) console.log(guide);
    if (!result.execution.completed) { console.error(result.execution.failed?.message ?? "Installation did not complete"); return 1; }
    return 0;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
}
