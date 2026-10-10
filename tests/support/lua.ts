/**
 * 用 wasmoon 跑真实 Lua 滤镜的测试支架。
 *
 * 这里刻意不重写任何 Lua 逻辑：load 进去的是 `assets/lua/` 下真正要发布的三
 * 个文件（json / ipc / filter），只有宿主端口 `model_predict_host` 被换成
 * `tests/fixtures/lua/model_predict_host_stub.lua`，由本文件把它的每一次观察接到
 * Node 的真实文件系统、可控时钟和可注入的启动器上。`tests/fixtures/lua/rime_host.lua`
 * 则补上 Weasel 那一侧的上下文、notifier 与候选对象。
 *
 * 两个坑记在这里，免得下次再踩：
 *   1. wasmoon 里 Lua 没有宿主文件系统，`require` 只能靠 `package.preload` 注入源码；
 *   2. 跨语言函数不能返回 null/undefined（wasmoon 会直接崩），所以桥接一律用 "" 表示
 *      "没有"，由 stub 那一侧翻回 nil。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LuaFactory } from "wasmoon";

const ASSET_DIRECTORY = fileURLToPath(new URL("../../assets/lua/", import.meta.url));
const FIXTURE_DIRECTORY = fileURLToPath(new URL("../fixtures/lua/", import.meta.url));

/** 一个输入候选的形态，字段与 librime 的 Candidate 对齐。 */
export interface FixtureCandidate {
  readonly text: string;
  readonly preedit?: string;
  readonly start?: number;
  readonly finish?: number;
  readonly type?: string;
}

/** 滤镜 yield 出来的候选，按 "type|start|end|text|comment" 解析。 */
export interface RenderedCandidate {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly comment: string;
}

export interface LuaHarnessOptions {
  /** 应用目录的父目录（就是 %USERPROFILE% 的位置）。 */
  readonly root: string;
  /** menu/page_size，默认 5。 */
  readonly pageSize?: number;
  /** 启动器是否存在；false 用来验证"没有启动器就静默不预测"。 */
  readonly launcher?: boolean;
  /** 起始的挂钟秒数，默认 1700000000。 */
  readonly nowSeconds?: number;
}

export interface LuaHarnessPaths {
  readonly root: string;
  readonly requests: string;
  readonly responses: string;
  readonly settings: string;
}

export interface LuaHarness {
  readonly paths: LuaHarnessPaths;
  /** filter.init(env)：连接 notifier，发布初始身份。 */
  init(): Promise<void>;
  fini(): Promise<void>;
  /** 发布 fork 提供的那三个上下文属性。 */
  setContext(values: { status?: string; text?: string; revision?: string }): Promise<void>;
  setInput(text: string, candidates: readonly FixtureCandidate[], preedit?: string): Promise<void>;
  /** 触发 update_notifier（librime 每次编辑都会发）。 */
  update(): Promise<void>;
  /** 触发 commit_notifier；不传 index 表示没有选中候选。 */
  commit(index?: number): Promise<void>;
  /** 跑一次 filter.func，返回它 yield 出来的候选。 */
  run(): Promise<RenderedCandidate[]>;
  /** 当前会话已发布出去的全部 RIME 属性。 */
  properties(): Promise<Record<string, string>>;
  engineId(): Promise<string>;
  /** 启动器被请求拉起 sidecar 的次数。 */
  launchCount(): number;
  setLauncher(available: boolean): void;
  /** 推进滤镜看到的挂钟。 */
  advanceClock(seconds: number): void;
  now(): number;
  dispose(): Promise<void>;
}

function parseRendered(text: string): RenderedCandidate[] {
  if (text === "") return [];
  return text.split("\n").map((line) => {
    const parts = line.split("|");
    return {
      type: parts[0] ?? "",
      start: Number(parts[1] ?? "0"),
      end: Number(parts[2] ?? "0"),
      text: parts[3] ?? "",
      comment: parts[4] ?? "",
    };
  });
}

export async function startHarness(options: LuaHarnessOptions): Promise<LuaHarness> {
  // 滤镜把 USERPROFILE 拼成 "<profile>\\.rime-model-predict"，这里就照这副形状造目录。
  const root = join(options.root, ".rime-model-predict");
  const paths: LuaHarnessPaths = {
    root,
    requests: join(root, "ipc", "requests"),
    responses: join(root, "ipc", "responses"),
    settings: join(root, "settings.json"),
  };
  mkdirSync(paths.requests, { recursive: true });
  mkdirSync(paths.responses, { recursive: true });

  const lua = await new LuaFactory().createEngine();
  let launchCount = 0;
  let launcherAvailable = options.launcher ?? true;
  let hexCounter = 0;
  let clock = options.nowSeconds ?? 1_700_000_000;

  const nextHex = (bytes: number): string => {
    hexCounter += 1;
    return hexCounter.toString(16).padStart(bytes * 2, "0").slice(-(bytes * 2));
  };

  // 桥接的返回值只能是 string / number / boolean：wasmoon 遇到 null 会崩。
  lua.global.set("__host_getenv", (name: string) =>
    name === "USERPROFILE" ? options.root.replace(/\//g, "\\") + "\\" : "",
  );
  lua.global.set("__host_time", () => clock);
  lua.global.set("__host_read_file", (path: string, maximum: number) => {
    try {
      const data = readFileSync(path);
      if (data.byteLength > maximum) return "";
      return data.toString("utf8");
    } catch {
      return "";
    }
  });
  lua.global.set("__host_write_file", (path: string, data: string) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data, "utf8");
      return true;
    } catch {
      return false;
    }
  });
  lua.global.set("__host_rename", (from: string, to: string) => {
    try {
      renameSync(from, to);
      return true;
    } catch {
      return false;
    }
  });
  lua.global.set("__host_exists", (path: string) => existsSync(path));
  lua.global.set("__host_remove", (path: string) => {
    try {
      unlinkSync(path);
      return true;
    } catch {
      return !existsSync(path);
    }
  });
  lua.global.set("__host_random_hex", (bytes: number) => nextHex(bytes));
  lua.global.set("__host_start_sidecar", () => {
    if (!launcherAvailable) return false;
    launchCount += 1;
    return true;
  });
  lua.global.set("__host_module_directory", () => "");

  const load = async (name: string, source: string): Promise<void> => {
    lua.global.set(`__src_${name}`, source);
    await lua.doString(`package.preload['${name}'] = load(__src_${name}, '@${name}.lua')`);
  };
  await load("model_predict_host", readFileSync(join(FIXTURE_DIRECTORY, "model_predict_host_stub.lua"), "utf8"));
  await load("model_predict_json", readFileSync(join(ASSET_DIRECTORY, "model_predict_json.lua"), "utf8"));
  await load("model_predict_ipc", readFileSync(join(ASSET_DIRECTORY, "model_predict_ipc.lua"), "utf8"));
  await load("model_predict_filter", readFileSync(join(ASSET_DIRECTORY, "model_predict_filter.lua"), "utf8"));
  await load("rime_host", readFileSync(join(FIXTURE_DIRECTORY, "rime_host.lua"), "utf8"));

  await lua.doString([
    '__filter = require("model_predict_filter")',
    // Lua 侧的错误必须冒出来，不能变成"什么都没有发生"。
    '__run = function(fn) local ok, err = pcall(fn) if not ok then return "__ERROR__ " .. tostring(err) end return "" end',
    '__value = function(fn) local ok, value = pcall(fn) if not ok then return "__ERROR__ " .. tostring(value) end return value end',
    `__harness = require("rime_host").new({ input = "", pageSize = ${String(options.pageSize ?? 5)} })`,
  ].join("\n"));

  const invoke = async (
    statement: string,
    args: readonly (string | number | boolean)[] = [],
  ): Promise<string> => {
    args.forEach((value, index) => lua.global.set(`__arg${String(index + 1)}`, value));
    const result: unknown = await lua.doString(`return __run(function() ${statement} end)`);
    const text = typeof result === "string" ? result : "";
    if (text.startsWith("__ERROR__")) throw new Error(`Lua 执行失败: ${text}`);
    return text;
  };
  const evaluate = async (expression: string): Promise<string> => {
    const result: unknown = await lua.doString(`return __value(function() return ${expression} end)`);
    const text = typeof result === "string" ? result : "";
    if (text.startsWith("__ERROR__")) throw new Error(`Lua 执行失败: ${text}`);
    return text;
  };

  return {
    paths,
    async init(): Promise<void> {
      await invoke("__filter.init(__harness.env)");
    },
    async fini(): Promise<void> {
      await invoke("__filter.fini(__harness.env)");
    },
    async setContext(values): Promise<void> {
      await invoke(
        'local json = require("model_predict_json") require("rime_host").set_context(__harness, json.decode(__arg1))',
        [JSON.stringify(values)],
      );
    },
    async setInput(text, candidates, preedit = ""): Promise<void> {
      await invoke(
        'local json = require("model_predict_json") require("rime_host").set_input(__harness, __arg1, json.decode(__arg2), __arg3)',
        [text, JSON.stringify(candidates), preedit],
      );
    },
    async update(): Promise<void> {
      await invoke('require("rime_host").update(__harness)');
    },
    async commit(index): Promise<void> {
      if (index === undefined) {
        await invoke('require("rime_host").commit(__harness, nil)');
        return;
      }
      await invoke('require("rime_host").commit(__harness, __arg1)', [index]);
    },
    async run(): Promise<RenderedCandidate[]> {
      return parseRendered(await evaluate('require("rime_host").run(__harness, __filter)'));
    },
    async properties(): Promise<Record<string, string>> {
      const encoded = await evaluate('require("model_predict_json").encode(__harness.state.properties)');
      return JSON.parse(encoded) as Record<string, string>;
    },
    async engineId(): Promise<string> {
      return await evaluate("__harness.env.engine_id");
    },
    launchCount(): number {
      return launchCount;
    },
    setLauncher(available: boolean): void {
      launcherAvailable = available;
    },
    advanceClock(seconds: number): void {
      clock += seconds;
    },
    now(): number {
      return clock;
    },
    async dispose(): Promise<void> {
      lua.global.close();
    },
  };
}

/**
 * 真实 host 与替身的导出函数集合。发布用的 host 和测试用的 stub 必须是同一套
 * 端口，任何一边多一个少一个函数都会让测试跑在与发布不同的形状上。
 */
export async function hostPorts(): Promise<{ real: readonly string[]; stub: readonly string[] }> {
  const lua = await new LuaFactory().createEngine();
  const load = async (name: string, source: string): Promise<void> => {
    lua.global.set(`__port_${name}`, source);
    await lua.doString(`package.preload['${name}'] = load(__port_${name}, '@${name}.lua')`);
  };
  const names = async (name: string): Promise<string[]> => {
    const text: unknown = await lua.doString(
      `local m = require('${name}') local t = {} for key in pairs(m) do t[#t + 1] = key end table.sort(t) return table.concat(t, ',')`,
    );
    return String(text).split(",");
  };
  await load("real_host", readFileSync(join(ASSET_DIRECTORY, "model_predict_host.lua"), "utf8"));
  await load("stub_host", readFileSync(join(FIXTURE_DIRECTORY, "model_predict_host_stub.lua"), "utf8"));
  const real = await names("real_host");
  const stub = await names("stub_host");
  lua.global.close();
  return { real, stub };
}

export { ASSET_DIRECTORY, FIXTURE_DIRECTORY };
