/**
 * 安装路径表（spec #18 施工图 B 段 R1–R4）。
 *
 * 票面合同要求「路径在构建期编译进产物」：本模块只有普通常量与纯函数，随 `tsc`
 * 编译进 `dist/`，运行期不读任何外部路径配置；调用方（S9 安装器）把环境读数作为
 * 参数注入进来。
 *
 * 四条规则的落点（逐条证据见 ADR 0008）：
 * - R1 程序根与官方 Weasel 同处：官方安装器的默认 `$INSTDIR` 是 `%ProgramFiles%\Rime`
 *   （x64 与 ARM64 都取 `$PROGRAMFILES64`），程序文件实际落在 `$INSTDIR\weasel-<版本>`
 *   （fork `output/install.nsi:21,126-143,212`）；被替换的 `weaselx64.dll` 必须留在
 *   程序根；原生 setup 复制到官方系统注册位置。
 * - R2 自有**新增**产物（sidecar 双变体、设置页资产）集中到 `<程序根>\predict`。
 * - R3 用户侧接入点只有两处：RIME 用户目录（Lua 模块；custom 由用户手动合并）与
 *   `%USERPROFILE%\.rime-model-predict`。
 * - R4 见文件头。
 *
 * R2 与 R3 的边界：本仓库的 Lua 组件是**接入项**而不是程序文件——librime-lua 只在
 * `<RIME 用户目录>\lua\?.lua` 里 `require` 模块（librime-lua `src/modules.cc:56-63`），
 * 而启动器 DLL 又必须与 Lua 模块同目录（`assets/lua/model_predict_host.lua:104-131`
 * 用 `module_directory()` + `loadlib` 相对解析），所以二者一起落在 R3 的接入点里。
 *
 * 官方安装位置可被用户改写（`HKLM\Software\Rime\Weasel` 的 `InstallDir`），所以
 * `installParent` 允许注入；缺省值是与上游一致的 `Rime`。
 */

import { isAbsolute, join } from "node:path";

import { OFFICIAL_WEASEL } from "../domain/install-plan.js";
import type { SidecarStopContract } from "../domain/install-plan.js";
import { APP_DIRECTORY, appPaths } from "../ipc/app-paths.js";
import { SIDECAR_LOCK_FILE } from "../runtime/lifecycle.js";

/** 官方安装器默认 `$INSTDIR` 的最后一段（`install.nsi:130-142`）。 */
export const OFFICIAL_INSTALL_PARENT = "Rime";

/** 官方程序目录名前缀（`install.nsi:21`）。 */
export const WEASEL_DIRECTORY_PREFIX = "weasel-";

/** R2：自有新增产物在程序根下的功能子目录名。 */
export const FEATURE_DIRECTORY = "predict";

/** R3：RIME 用户目录在 `%APPDATA%` 下的缺省目录名（`WeaselSetup.cpp:106-108`）。 */
export const RIME_USER_DIRECTORY_NAME = "Rime";

/** R3：librime-lua 的模块目录名，必须叫 `lua`（`modules.cc:56-63` 写死）。 */
export const RIME_LUA_DIRECTORY_NAME = "lua";

/** 旧版设置位置在 `%LOCALAPPDATA%` 下的目录名（与 `settings/store.ts:149` 同源）。 */
export const LEGACY_APP_DIRECTORY_NAME = "rime-model-predict";

/** 随包产物文件名：sidecar 双变体（ADR 0003）、设置页资产、启动器 DLL。 */
export const CONSOLE_SIDECAR_NAME = "rime-predict-sidecar.exe";
export const WINDOW_SIDECAR_NAME = "rime-predict-sidecar-gui.exe";
export const SETTINGS_PAGE_NAME = "settings.html";
export const LAUNCHER_LIBRARY_NAME = "rime_model_predict_launcher.dll";

/** 被替换的官方前端库名（留在程序根，R1）。 */
export const FRONTEND_LIBRARY_NAME = "weaselx64.dll";

/** librime-lua 引用的滤镜模块名；`*` 前缀让 librime-lua 直接 `require` 它。 */
export const FILTER_MODULE_NAME = "model_predict_filter";

/** 随包 Lua 模块（模块名，不含扩展名）；落在 `<RIME 用户目录>\lua\`。 */
export const LUA_MODULE_NAMES = [
  "model_predict_filter",
  "model_predict_host",
  "model_predict_ipc",
  "model_predict_json",
] as const;

/**
 * schema 里的滤镜引用写法。
 *
 * librime-lua 的 `<klass>` 以 `*` 开头时走 `require`（`src/lua_gears.cc:93-108`），
 * 否则读 Lua 全局符号。用 `*` 就不必占用用户的 `rime.lua`（那个文件只加载一份，
 * 用户可能已经在里面写了自己的东西），接入面退化成「一个目录 + 一条补丁」。
 */
export const FILTER_REFERENCE = `lua_filter@*${FILTER_MODULE_NAME}`;

/** custom 补丁里向列表末尾追加的键（RIME patch 的 `@next` 定位符）。 */
export const FILTER_PATCH_KEY = "engine/filters/@next";

/** custom 补丁文件名后缀。 */
export const RIME_PATCH_SUFFIX = ".custom.yaml";

/** 角色名（`PayloadTarget.artifacts` 的键）：TSF 注册的承担者。 */
export const ROLE_FRONTEND = "frontend";

/** 角色名：程序侧自有产物与用户侧接入项。 */
export const ROLE_SIDECAR_CONSOLE = "sidecar-console";
export const ROLE_SIDECAR_WINDOW = "sidecar-window";
export const ROLE_SETTINGS_PAGE = "settings-page";
export const ROLE_LAUNCHER = "launcher";
export const ROLE_LUA_FILTER = "lua-filter";
export const ROLE_LUA_HOST = "lua-host";
export const ROLE_LUA_IPC = "lua-ipc";
export const ROLE_LUA_JSON = "lua-json";

export interface PathTableInput {
  /** `%ProgramFiles%`（x64 进程里是 64 位路径）。 */
  readonly programFiles: string;
  /** `%USERPROFILE%`。 */
  readonly userProfile: string;
  /** `%APPDATA%`。 */
  readonly appData: string;
  /** 官方程序父目录名；缺省 `Rime`，可注入注册表里读到的实际值。 */
  readonly installParent?: string;
  /** RIME 用户目录；缺省 `<appData>\Rime`（可注入 `HKCU\...\RimeUserDir` 的实际值）。 */
  readonly rimeUserDirectory?: string;
}

/** 终止伴随进程的契约（权威定义在领域层，路径表只是它的一个实例）。 */
export type { SidecarStopContract };

export interface InstallPaths {
  /** R1：程序根。 */
  readonly programRoot: string;
  /** R2：自有新增产物的功能子目录。 */
  readonly featureRoot: string;
  /** 被替换的官方前端库（留在程序根）。 */
  readonly frontend: string;
  readonly sidecars: { readonly console: string; readonly window: string };
  readonly settingsPage: string;
  /** R3：RIME 用户目录与其 `lua` 子目录。 */
  readonly rimeUserDirectory: string;
  readonly luaDirectory: string;
  /** 启动器 DLL（与 Lua 模块同目录）。 */
  readonly launcherLibrary: string;
  readonly luaModules: readonly string[];
  /** R3：`%USERPROFILE%\.rime-model-predict` 及其派生路径。 */
  readonly userDirectory: string;
  readonly settingsFile: string;
  readonly diagnosticsLog: string;
  readonly statusFile: string;
  readonly lockFile: string;
  readonly requestsDirectory: string;
  readonly responsesDirectory: string;
  /** 卸载终局全清的瞬态运行时文件与诊断日志（#15 Q2/Q3）。 */
  readonly transientPaths: readonly string[];
  /** 绝不触碰的用户数据：设置文件、RIME 用户目录、共享模型目录之外的一切。 */
  readonly preservedPaths: readonly string[];
  readonly sidecarStop: SidecarStopContract;
}

function requireAbsolute(value: string, what: string): string {
  if (!isAbsolute(value)) throw new Error(`${what} must be an absolute path`);
  return value;
}

/** 官方程序目录名：`weasel-<版本>`，版本随 fork 基底走。 */
export function officialWeaselDirectory(version: string = OFFICIAL_WEASEL.version): string {
  return `${WEASEL_DIRECTORY_PREFIX}${version}`;
}

/**
 * 路径表：把 R1–R4 编译成一组绝对路径。
 *
 * 纯函数：只做字符串拼装与校验，不查盘、不读环境变量；非法输入直接抛错。
 */
export function pathTable(input: PathTableInput): InstallPaths {
  const programFiles = requireAbsolute(input.programFiles, "program files directory");
  const userProfile = requireAbsolute(input.userProfile, "user profile directory");
  const appData = requireAbsolute(input.appData, "application data directory");
  const installParent = input.installParent ?? OFFICIAL_INSTALL_PARENT;
  const programRoot = isAbsolute(installParent)
    ? join(installParent, officialWeaselDirectory())
    : join(programFiles, installParent, officialWeaselDirectory());
  const featureRoot = join(programRoot, FEATURE_DIRECTORY);

  const rimeUserDirectory = requireAbsolute(
    input.rimeUserDirectory ?? join(appData, RIME_USER_DIRECTORY_NAME),
    "RIME user directory",
  );
  const luaDirectory = join(rimeUserDirectory, RIME_LUA_DIRECTORY_NAME);

  // 用户目录的瞬态/设置路径复用伴随进程自己的路径派生，避免两处各写一遍。
  const userDirectory = join(userProfile, APP_DIRECTORY);
  const user = appPaths(userDirectory);
  const statusFile = user.status;

  const sidecars = {
    console: join(featureRoot, CONSOLE_SIDECAR_NAME),
    window: join(featureRoot, WINDOW_SIDECAR_NAME),
  } as const;

  return {
    programRoot,
    featureRoot,
    frontend: join(programRoot, FRONTEND_LIBRARY_NAME),
    sidecars,
    settingsPage: join(featureRoot, SETTINGS_PAGE_NAME),
    rimeUserDirectory,
    luaDirectory,
    launcherLibrary: join(luaDirectory, LAUNCHER_LIBRARY_NAME),
    luaModules: LUA_MODULE_NAMES.map((name) => join(luaDirectory, `${name}.lua`)),
    userDirectory,
    settingsFile: user.settings,
    diagnosticsLog: user.log,
    statusFile,
    lockFile: join(userDirectory, SIDECAR_LOCK_FILE),
    requestsDirectory: user.requests,
    responsesDirectory: user.responses,
    transientPaths: [
      user.requests,
      user.responses,
      statusFile,
      join(userDirectory, SIDECAR_LOCK_FILE),
      user.log,
    ],
    preservedPaths: [user.settings, rimeUserDirectory],
    sidecarStop: { statusFile, images: [sidecars.console, sidecars.window] },
  };
}

const SCHEMA_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** 某个方案的 custom 补丁文件路径；`schemaId` 只能是普通方案标识，防目录穿越。 */
export function patchFilePath(paths: InstallPaths, schemaId: string): string {
  if (!SCHEMA_ID_PATTERN.test(schemaId)) throw new Error("schema id must be a plain file name");
  return join(paths.rimeUserDirectory, `${schemaId}${RIME_PATCH_SUFFIX}`);
}

/** 角色 → 路径：调用方填上摘要即可得到 `PayloadTarget.artifacts`。 */
export function artifactPaths(paths: InstallPaths): Readonly<Record<string, string>> {
  const roles: Record<string, string> = {
    [ROLE_FRONTEND]: paths.frontend,
    [ROLE_SIDECAR_CONSOLE]: paths.sidecars.console,
    [ROLE_SIDECAR_WINDOW]: paths.sidecars.window,
    [ROLE_SETTINGS_PAGE]: paths.settingsPage,
    [ROLE_LAUNCHER]: paths.launcherLibrary,
  };
  const luaRoles = [ROLE_LUA_FILTER, ROLE_LUA_HOST, ROLE_LUA_IPC, ROLE_LUA_JSON];
  const modules = paths.luaModules;
  for (let index = 0; index < luaRoles.length && index < modules.length; index += 1) {
    const role = luaRoles[index];
    const modulePath = modules[index];
    if (role !== undefined && modulePath !== undefined) roles[role] = modulePath;
  }
  return roles;
}
