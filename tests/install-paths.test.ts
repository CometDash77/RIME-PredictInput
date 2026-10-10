/**
 * 安装路径表（R1–R4）的离线断言面（S8/#26 验收标准①）。
 *
 * 路径在构建期编译进产物：这里只喂环境读数，把拼出来的绝对路径逐条钉死；
 * 顺带锁住 patchFilePath 的目录穿越防线与「非绝对路径直接抛错」的口径。
 */
import { describe, expect, it } from "vitest";

import {
  FILTER_MODULE_NAME,
  FILTER_PATCH_KEY,
  FILTER_REFERENCE,
  ROLE_FRONTEND,
  ROLE_LAUNCHER,
  ROLE_LUA_FILTER,
  ROLE_SIDECAR_CONSOLE,
  ROLE_SIDECAR_WINDOW,
  ROLE_SETTINGS_PAGE,
  artifactPaths,
  officialWeaselDirectory,
  patchFilePath,
  pathTable,
} from "../src/install/paths.js";

const PROGRAM_FILES = "C:\\Program Files";
const USER_PROFILE = "C:\\Users\\u";
const APP_DATA = "C:\\Users\\u\\AppData\\Roaming";

const PROGRAM_ROOT = "C:\\Program Files\\Rime\\weasel-0.17.4";
const FEATURE_ROOT = `${PROGRAM_ROOT}\\predict`;
const RIME_USER = `${APP_DATA}\\Rime`;
const LUA_DIR = `${RIME_USER}\\lua`;
const USER_DIR = `${USER_PROFILE}\\.rime-model-predict`;

const PATHS = pathTable({ programFiles: PROGRAM_FILES, userProfile: USER_PROFILE, appData: APP_DATA });

const INPUT = { programFiles: PROGRAM_FILES, userProfile: USER_PROFILE, appData: APP_DATA };

describe("R1 程序根与官方 Weasel 同处", () => {
  it("官方默认 $INSTDIR 是 %ProgramFiles%\Rime，程序文件落在 weasel-<版本>", () => {
    expect(PATHS.programRoot).toBe(PROGRAM_ROOT);
    expect(PATHS.programRoot).toBe("C:\\Program Files\\Rime\\weasel-0.17.4");
    expect(officialWeaselDirectory()).toBe("weasel-0.17.4");
    expect(officialWeaselDirectory("0.18.0")).toBe("weasel-0.18.0");
  });

  it("安装父目录可注入：注册表改写 InstallDir 时随之改变", () => {
    const custom = pathTable({ ...INPUT, installParent: "RimeDev" });
    expect(custom.programRoot).toBe("C:\\Program Files\\RimeDev\\weasel-0.17.4");
  });

  it("被替换的前端库留在程序根：TSF 注册位置不能改", () => {
    expect(PATHS.frontend).toBe(`${PROGRAM_ROOT}\\WeaselTSF.dll`);
  });
});

describe("R2 自有新增产物集中到 <程序根>\predict", () => {
  it("sidecar 双变体与设置页都在功能子目录里", () => {
    expect(PATHS.featureRoot).toBe(FEATURE_ROOT);
    expect(PATHS.sidecars.console).toBe(`${FEATURE_ROOT}\\rime-predict-sidecar.exe`);
    expect(PATHS.sidecars.window).toBe(`${FEATURE_ROOT}\\rime-predict-sidecar-gui.exe`);
    expect(PATHS.settingsPage).toBe(`${FEATURE_ROOT}\\settings.html`);
  });
});

describe("R3 用户侧只有两处接入点", () => {
  it("RIME 用户目录：四个 Lua 模块与启动器 DLL 同目录", () => {
    expect(PATHS.rimeUserDirectory).toBe(RIME_USER);
    expect(PATHS.luaDirectory).toBe(LUA_DIR);
    expect(PATHS.launcherLibrary).toBe(`${LUA_DIR}\\rime_model_predict_launcher.dll`);
    expect(PATHS.luaModules).toEqual([
      `${LUA_DIR}\\model_predict_filter.lua`,
      `${LUA_DIR}\\model_predict_host.lua`,
      `${LUA_DIR}\\model_predict_ipc.lua`,
      `${LUA_DIR}\\model_predict_json.lua`,
    ]);
  });

  it("RIME 用户目录可注入：HKCU 的 RimeUserDir 改写后整体跟着走", () => {
    const custom = pathTable({ ...INPUT, rimeUserDirectory: "D:\\RimeData" });
    expect(custom.rimeUserDirectory).toBe("D:\\RimeData");
    expect(custom.luaDirectory).toBe("D:\\RimeData\\lua");
    expect(custom.preservedPaths).toContain("D:\\RimeData");
  });

  it("自有数据目录：%USERPROFILE%\.rime-model-predict 及其全部派生路径", () => {
    expect(PATHS.userDirectory).toBe(USER_DIR);
    expect(PATHS.settingsFile).toBe(`${USER_DIR}\\settings.json`);
    expect(PATHS.statusFile).toBe(`${USER_DIR}\\status.json`);
    expect(PATHS.lockFile).toBe(`${USER_DIR}\\sidecar.lock`);
    expect(PATHS.diagnosticsLog).toBe(`${USER_DIR}\\diagnostics.log`);
    expect(PATHS.requestsDirectory).toBe(`${USER_DIR}\\ipc\\requests`);
    expect(PATHS.responsesDirectory).toBe(`${USER_DIR}\\ipc\\responses`);
  });

  it("接入写法：custom 补丁键与滤镜引用固定", () => {
    expect(FILTER_PATCH_KEY).toBe("engine/filters/@next");
    expect(FILTER_REFERENCE).toBe(`lua_filter@*${FILTER_MODULE_NAME}`);
    expect(FILTER_REFERENCE).toBe("lua_filter@*model_predict_filter");
    expect(patchFilePath(PATHS, "luna_pinyin")).toBe(`${RIME_USER}\\luna_pinyin.custom.yaml`);
  });

  it("方案标识不是普通文件名时拒绝：防目录穿越", () => {
    for (const bad of ["", "../evil", "a/b", "a\\b", "a b"]) {
      expect(() => patchFilePath(PATHS, bad)).toThrow("schema id must be a plain file name");
    }
  });
});

describe("清单口径：瞬态、保留、终止契约、角色映射", () => {
  it("瞬态清单 = 卸载终局要全清的运行时文件与诊断日志", () => {
    expect(PATHS.transientPaths).toEqual([
      `${USER_DIR}\\ipc\\requests`,
      `${USER_DIR}\\ipc\\responses`,
      `${USER_DIR}\\status.json`,
      `${USER_DIR}\\sidecar.lock`,
      `${USER_DIR}\\diagnostics.log`,
    ]);
  });

  it("保留清单只含用户数据：设置文件与 RIME 用户目录", () => {
    expect(PATHS.preservedPaths).toEqual([`${USER_DIR}\\settings.json`, RIME_USER]);
  });

  it("终止契约：状态文件 + 两个合法进程映像", () => {
    expect(PATHS.sidecarStop).toEqual({
      statusFile: `${USER_DIR}\\status.json`,
      images: [`${FEATURE_ROOT}\\rime-predict-sidecar.exe`, `${FEATURE_ROOT}\\rime-predict-sidecar-gui.exe`],
    });
  });

  it("九个角色 → 路径齐全，程序文件与接入项各归各位", () => {
    const roles = artifactPaths(PATHS);
    expect(Object.keys(roles).sort()).toEqual([
      "frontend",
      "launcher",
      "lua-filter",
      "lua-host",
      "lua-ipc",
      "lua-json",
      "settings-page",
      "sidecar-console",
      "sidecar-window",
    ]);
    expect(roles[ROLE_FRONTEND]).toBe(`${PROGRAM_ROOT}\\WeaselTSF.dll`);
    expect(roles[ROLE_SIDECAR_CONSOLE]).toBe(`${FEATURE_ROOT}\\rime-predict-sidecar.exe`);
    expect(roles[ROLE_SIDECAR_WINDOW]).toBe(`${FEATURE_ROOT}\\rime-predict-sidecar-gui.exe`);
    expect(roles[ROLE_SETTINGS_PAGE]).toBe(`${FEATURE_ROOT}\\settings.html`);
    expect(roles[ROLE_LAUNCHER]).toBe(`${LUA_DIR}\\rime_model_predict_launcher.dll`);
    expect(roles[ROLE_LUA_FILTER]).toBe(`${LUA_DIR}\\model_predict_filter.lua`);
  });
});

describe("输入校验", () => {
  it("四个输入都必须是绝对路径，各自报自己的名字", () => {
    expect(() => pathTable({ ...INPUT, programFiles: "Program Files" })).toThrow(
      "program files directory must be an absolute path",
    );
    expect(() => pathTable({ ...INPUT, userProfile: "u" })).toThrow(
      "user profile directory must be an absolute path",
    );
    expect(() => pathTable({ ...INPUT, appData: "AppData" })).toThrow(
      "application data directory must be an absolute path",
    );
    expect(() => pathTable({ ...INPUT, rimeUserDirectory: "Rime" })).toThrow(
      "RIME user directory must be an absolute path",
    );
  });
});
