# ADR 0006：Lua 滤镜资产怎么测——wasmoon 里的真 Lua + 可替换 host 端口

- 状态：已采纳（2026-10-10，issue #24）
- 背景：S5 要求「用真实文件 IPC 加假 sidecar 脚本」覆盖滤镜行为，并明确禁止 UI 自动化。但本机没有任何 Lua 解释器（`lua` / `lua5.4` / `luajit` 全部不在 PATH，`D:\VibeCoding` 下也没有），Rime 安装目录 `C:\Program Files\Rime\weasel-0.17.4` 里只有 `weasel.dll`/`rime.dll`/`WeaselServer.exe` 与 `data/`，没有 `lua/` 目录，fork 的 librime submodule 也没有 checkout（目录为空）。要真的执行滤镜，只有两条路：在 JS 里实现一个 Lua 5.3（fengari），或者在 wasm 里跑官方 Lua 5.4（wasmoon）。滤镜依赖 5.4 语义（`utf8.offset`、`string.pack`/`string.unpack`、位运算、`table.unpack`），随包的 `model_predict_json.lua` 是纯 5.4 手写 JSON + SHA-256，所以选后者。

## 决定

1. **用 wasmoon 1.16.0 执行 `assets/lua` 下的真实资产**（devDependency）。测试跑的就是将来装到用户机上的那几份 `.lua` 文件，不养第二份副本。
2. **require 靠 `package.preload` 注入源码**：wasmoon 的 Lua 没有宿主文件系统；真机上模块解析由 librime-lua 的 `package.path` 负责，两边只共享模块名，模块之间只用 `require("model_predict_ipc")` 这种标准形式互相引用。
3. **`os`/`io`/启动器收敛成 `model_predict_host.lua` 的十个函数**（`getenv`/`time`/`read_file`/`write_file`/`rename`/`exists`/`remove`/`random_hex`/`start_sidecar`/`module_directory`）。测试替换整个模块（`tests/fixtures/lua/model_predict_host_stub.lua` + JS 桥接），并有一条静态对照用例锁住「真 host 与替身的导出函数名集合完全一致」——改端口而忘了改替身会直接红。
4. **假 RIME 宿主**（`tests/fixtures/lua/rime_host.lua`）提供 `Candidate`/`ShadowCandidate`/context/schema.config/三个 notifier/`input:iter()`，并用协程驱动 `filter.func` 收集 `yield` 出来的候选；完成通知走 `update_notifier` 触发，不碰 UI。
5. **进程边界用真实子进程**（`tests/fixtures/sidecar/fake-sidecar.mjs`）：它说 `src/runtime/lifecycle.ts` 的锁文件协议（`sidecar.lock` 里 `{"pid","started"}`）与 requests/responses 目录约定，因此能验证「第二个实例静默退出」「空闲到点自退」「启动清残骸」以及两套实现的协议互认。
6. **跨语言桥接函数禁止返回 `null`/`undefined`**：wasmoon 会把 `null` 塞进 Promise 通道，抛 `TypeError: Cannot read properties of null (reading 'then')`。没有值一律用 `""` 哨兵，由 stub 侧翻回 `nil`。

## 后果

- `pnpm verify` 从 354 条涨到 376 条（`tests/lua-filter.test.ts` 11 条 + `tests/lifecycle.test.ts` 11 条）。滤镜的断言只落在「外部可观察的行为」上：落盘请求的字节、渲染出来的候选行、事件文件、进程退出码。
- **Lua 模式没有计数重复量词**：`"^[0-9a-f]{40}$"` 里的 `{40}` 是字面花括号，永远匹配不上——长度校验必须写成显式比较（`#value == length and value:match("^[0-9a-f]+$")`）。这条坑在本票里真实吃掉了「响应永远读不出来」的一次排查。
- 残留风险：wasmoon 的 Lua 5.4 与 librime-lua 内嵌版本之间仍可能有细微差异。差异面已经被两件事压小——滤镜只管纯 5.4 的标准库子集，且所有宿主能力都从 host 端口进出。
- 真机路径（真 librime-lua 装载、真 WeaselServer 窗口、真 launcher 拉起 sidecar）不在本 ADR 覆盖范围，归真机发布验收。
