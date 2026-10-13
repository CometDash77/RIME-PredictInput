# REPORT — sidecar 随包产物形态实测（issue #9 原型）

> Issue: deck-807d9db1-5971141 (CometDash77/RIME-PredictInput #9)
> Branch: research/native-integration (抛弃式原型，prototype/ 未跟踪)
> 日期: 2026-10-07 | 环境: Windows x64, RDP 会话, node v22.23.1, bun 1.4.2, deno 2.9.7, @yao-pkg/pkg latest (内置 node v22.23.2)
> 测量基建: run.ps1 (编译+测量) / run-measurements.mjs (P1-P8) / helper.exe (C# 测量助手) / probe-*.mjs (各形态探针)
> 产物: results.json (机读全量) / build/ (bundle) / artifacts/ (九形态 exe)

## 0. 结论一览

| 项 | 结果 |
|---|---|
| PE 子系统 (P0) | **Pass** — 4 候选 x CUI/GUI 双变体全生成，pe.mjs 纯字节改写 subsystem 3->2 有效 |
| 控制台闪窗 (P1) | **Pass (环境注记)** — 全形态 none/no-window 模式 flash=0（RDP 会话，见 P1 注记） |
| 子进程控制台 (P2) | **Pass** — 全形态 CUI 子进程 childAttached=false childVisible=false |
| 冷启动 (P3) | **Pass** — 全形态 readyAll10=true；bun 269ms 最快，sea 309ms ~= node 308ms |
| 空闲内存 (P4) | **Pass (bun 注记)** — 私有内存 18-23MB；bun 86MB 反常（BEE allocator reserve） |
| Bun.spawn 阻塞 (P5) | **Pass** — 全形态行为一致: natural 阻塞 / unref 解绑 / process.exit 直退 |
| 单实例锁 (P6) | **Pass** — 9/9 形态 wx 锁 + kill(pid,0) 存活判定全过 |
| WM_COPYDATA (P7) | **Pass (sea 除外)** — node/bun/deno/pkg x gui + ps-bridge 全部 delivered；sea/sea-gui 无法加载 koffi（形态局限） |
| selftest 等价 (P8) | **Pass** — 5 产物全 code=0 status=ok，7 项检查文本与 node 直跑逐字全等 |

**推荐形态: @yao-pkg/pkg**（详见第 10 节）。

## 1. P0 PE 子系统 — Pass

- pe.mjs copy-gui: 读 PE 头 PE32+ OptionalHeader.Subsystem 偏移写 2 (GUI)，产物经 info 校验。
- forms 终态: sea 83.1MB sub=3, sea-gui sub=2 | bun 82.1 sub=3/2 | deno 103.6 sub=3/2 | pkg 80.2 sub=3/2 | node-baseline 83.0 sub=3。
- 无需改任何源码即得 GUI 变体；GUI 变体运行行为（selftest/P5/P7）与 CUI 原版一致。

## 2. P1 控制台闪窗 — Pass（环境注记）

- 方法: helper.exe consoles (EnumWindows 数 ConsoleWindowClass/CASCADIA_HOSTING_WINDOW_CLASS/PseudoConsoleWindow 可见窗口) 基线 vs 探测进程 heartbeat 期间，none 与 no-window 两种父创建旗标。
- 数据: 全 9 形态 x 2 模式 flash=0（baseline=0, during=0）。
- **环境注记**: 本机为 RDP 会话。helper spawn 前已 FreeConsole，CUI 子进程新建控制台在本会话不产生可见顶层窗口。**该结论需在真实交互桌面（物理登录会话）复核**；若复核出现闪窗，CREATE_NO_WINDOW 是现成解法（no-window 模式已验证不改变行为）。

## 3. P2 子进程控制台行为 — Pass

- 方法: 各形态（subsystem=2 GUI 变体亦测）作为父 spawn CUI helper（report 模式），读 child console attached/visible。
- 数据: 全形态 x {no-window, detached} 父旗标 x {default, hide} 子模式 -> childAttached=false, childVisible=false（deno 只测 default）。
- 结论: 无控制台形态的 sidecar 再 spawn CUI 子进程（ollama 桥、外部工具）不会弹出控制台。

## 4. P3 冷启动 — Pass

spawn -> READY stdout, 1 warmup + 10 runs, p50/p95 (ms):

| 形态 | p50 | p95 | readyAll10 |
|---|---|---|---|
| node-baseline | 308 | 347 | true |
| sea | 309 | 317 | true |
| sea-gui | 295 | 701(离群单次) | true |
| bun | **269** | **272** | true |
| bun-gui | 258 | 281 | true |
| deno | 299 | 315 | true |
| deno-gui | 291 | 299 | true |
| pkg | 313 | 326 | true |
| pkg-gui | 296 | 308 | true |

- 全形态 READY 稳定输出；sea 与 node 直跑等速；bun 最快；四候选全部落在 258-313ms 区间，无淘汰级差异。

## 5. P4 空闲内存 — Pass（bun 注记）

heartbeat 6s 第 4.5s 采样 (ws / private, MB):

| 形态 | ws | private |
|---|---|---|
| node-baseline | 42.9 | 18.8 |
| sea | 37.5 | 20.5 |
| sea-gui | 37.3 | 20.4 |
| bun | 21.0 | **86.0** |
| bun-gui | 20.7 | **79.8** |
| deno | 33.4 | 18.1 |
| deno-gui | 33.3 | 17.9 |
| pkg | 37.8 | 23.2 |
| pkg-gui | 40.4 | 22.5 |

- **bun 私有内存 ~86MB 稳定复现**（上轮 85.8），为 bun BEE allocator 的 reserve 行为；commit 内存对提交上限敏感的部署场景需注意。
- 其余形态私有 18-23MB，同量级。ollama 不在场，此为纯 idle 数据（Weasel 未装同样不影响 idle）。

## 6. P5 Bun.spawn 阻塞父退出 — Pass

- 方法: probe 各形态 spawn helper.exe sleep 8000 后，三模式退出：natural（等 child）/ unref（child.unref 后退）/ exit（process.exit 直退）。
- 终版数据（全 9 形态一致，node/sea/bun/deno/pkg 及 gui）:
  - exitblock-natural: ms 5006-5292, blocked=true, signal=SIGTERM（5s 强杀超时）
  - exitblock-unref: ms 93-576, blocked=false, code=0
  - exitblock-exit: ms 89-414, blocked=false, code=0
- 结论: 阻塞行为是 JS runtime 通用语义而非某形态缺陷；unref 与 process.exit 两种解法在全部形态有效。**sidecar 实现必须显式处理 child 生命周期（unref 或 exit）**。

## 7. P6 单实例锁 — Pass

- 方法: openSync(lockPath, "wx") + kill(prevPid, 0) 存活判定，双实例串行验证。
- 数据: 9/9 pass（first.acquired=true, second.eexist=true, prevAlive=true）。
- 注: 锁文件位于用户临时目录。真实部署的 ProgramData 位置 ACL 未测（见第 11 节遗留）。

## 8. P7 WM_COPYDATA — Pass（sea 除外）

- 方法: helper.exe recv 建 mock 窗口 WeaselIPCWindow_1.0（注册 COPYDATA_ID 0x52504D31），各形态内置探针 send，SMTO_ABORTIFHUNG 300ms；ps-bridge.ps1 为 PowerShell fallback 桥。
- 终版 sender/received（delivered 均以 helper 端 JSONL 记录 dwData=1380994353=0x52504D31 校验）:

| 发送方 | FFI | found | sent | received |
|---|---|---|---|---|
| node-baseline | koffi | true | true | ok:true |
| sea / sea-gui | koffi | - | **error: No such built-in module: koffi** | null |
| bun / bun-gui | bun:ffi | true | true | ok:true |
| deno / deno-gui | Deno.dlopen | true | true | ok:true |
| pkg / pkg-gui | koffi | true | true | ok:true |
| ps-bridge (PS 5.1) | P/Invoke | true | true | ok:true |

- **sea 形态局限（硬）**: node SEA 的 require 无法解析外部原生模块（koffi 是预编译 .node+JS 包装），SEA blob 只含快照+assets。SEA 形态要支持 WM_COPYDATA 必须去 FFI 化（改 named pipe / stdio 协议 / 内嵌纯 JS 实现）。
- **PS 桥实测坑（报告存档）**: powershell 进程内 FindWindowW 对 helper 注册的窗口恒返回 0（显式 EntryPoint="FindWindowW" 亦然；同窗口 bun:ffi/EnumWindows 均可见；机制未定论，疑似与 helper RegisterClassW 时 hInstance=0 相关）。**修复=EnumWindows+GetClassName 精确匹配替代 FindWindow**，端到端 delivered=1 已验证。这同时是真实 Weasel 互操作的风险提示：宿主（若经 PS/COM 桥）找窗要用枚举式。

## 9. P8 selftest 等价性 — Pass

- node dist/cli/main.js selftest baseline: status=ok, checks=7 项文本（policy identity / settings round trip / malformed envelope / file ipc / pump+status+log / idle exit / wire shape）。
- 5 产物（rime-sea/sea-gui/bun/deno/pkg.exe selftest）: 全部 code=0, status=ok, **checksMatch=true（7 项检查文本数组 JSON 逐字全等）**。
- 注: results.json 里 checksOk 显示 null 是测量脚本 map(c=>c.ok) 对字符串数组的误读，判定以 checksMatch（完整数组全等）为准。
- esbuild 打包警告存档: dist/web/launcher.js:30 与 dist/web/settings-host.js:68 的 import.meta.url 在 CJS 输出为空字符串——SEA/其他 CJS 形态若触达 web launcher/settings-host 路径会崩（selftest 未触达）。**降级触发条件之一**。

## 10. 推荐形态与降级触发条件

**推荐: @yao-pkg/pkg (rime-pkg.exe)**
- 理由: 七项实测全 Pass；koffi 与 node 直跑完全同路（代码零改动，P7 直接复用 repo 现有 FFI 层）；体积最小 80.2MB；内存/冷启动正常；内置 node v22.23.2 与 repo v22.23.1 仅 patch 差异。
- 代价: pkg 的快照打包对动态 require/原生 addon 有白名单要求；升级 node 大版本依赖 @yao-pkg 跟进。

**备选: bun --compile**
- 最快冷启动 (269ms) + 原生 bun:ffi；但 WM_COPYDATA 段需 koffi->bun:ffi 适配层（一次性改写 probe 已验证可行）；私有内存 ~86MB 需接受；bun runtime 行为差异由 P8 全等通过背书。

**node SEA 降级条件**: 仅当 sidecar IPC 完全去 FFI 化（named pipe / stdio）时可用；否则 P7 硬伤不可上线。SEA 与 node 直跑行为一致性最好（同 runtime 版本），保留为「IPC 协议重设计后」的回退项。

**deno compile**: 功能全过，非首选（体积 103.6MB，可优化：bundle 独立目录避免嵌入 node_modules；Deno.dlopen 适配；栈外）。保留数据，不推进。

**全局降级触发条件**（任一命中即回退）:
1. dist 引入 pkg/bun 无法打包的原生 addon 或动态 require 路径（P8 checksMatch 破坏）。
2. sidecar 触达 dist/web 路径（import.meta.url CJS 空值崩溃，见 P8 注记）。
3. 真实桌面会话复核 P1 出现闪窗且 CREATE_NO_WINDOW 无法消除（改 GUI 变体 or 服务化）。
4. Weasel 真实窗口（非 mock）互操作失败——PS 桥 FindWindowW 坑提示宿主侧找窗一律用枚举式。

## 11. 未测/遗留

1. **ACL**（scope 第 7 项）: 锁文件与数据文件的 ProgramData 部署位置权限继承未测（本轮锁在用户临时目录）。
2. **Weasel 真实窗口互操作**: Weasel 未安装，全部 P7 走 mock receiver；真实窗口类名/消息流需装机复测。
3. **ollama 在场内存**: P4 仅 idle；模型加载后 sidecar 的常驻内存未测。
4. 测量基建缺陷存档: helper recv 记录的 utf16 字段乱码（utf8 字段正确，不影响判定）；P1 数据受 RDP 会话限制（第 2 节注记）。

## 12. 修复史（本会话落盘项，供复盘）

pe.mjs argv 解析 | run.ps1 Build-Sea output 路径 | strip-guard -> dist/cli/main-noguard.mjs（build/ 会断相对 import，实测教训）| sea/deno entry TLA 改 then() | run.ps1 esbuild-bundles/deno-builds 步骤化 | helper.cs ready 行 \n | probe-deno FindWindowW UTF-16LE wide() | probe-deno Deno.Command stdio "ignore"->"null"（Deno 枚举无 ignore）| probe-deno SendMessageTimeoutW lParam "u64"->"pointer"（FFI 类型）| run.ps1 csc /out 引号+删旧 exe 防陈旧掩盖 | run-measurements P1 补 consoles 调用 + P7 扫描优先解析 | ps-bridge.ps1 FindWindow->EnumWindows。
