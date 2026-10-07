# 02 TypeScript 运行时与独立分发成本核查

- 对应 issue：CometDash77/RIME-PredictInput#4（wayfinder 地图 #1）。结论供 issue #5（支持矩阵与安装卸载产品契约 grilling）与 issue #7（架构决策）消费。
- 方法与边界：仅第一方来源核查（官方文档、官方仓库、官方发布说明、官方发行目录 nodejs.org/dist、npm 官方 registry、Microsoft Learn）。来源清单（第 6 节）标注 ✓ 的页面均在本次研究中实际抓取并核对过内容；本项目未安装依赖、未运行生产模型、未执行任何测量。官方打包/性能表述一律写作「官方声明，本项目未实测」；官方来源查不到的点写「未找到官方说明」或「需隔离测量」；本次取不到的页面/字段列入 6.2「未能核实清单」。
- 复核记录（2026-10-07，主会话对 12 项承重声明独立抽查）：11 项直接验证通过；修正 4 处——Bun.spawn 官方 SpawnOptions 含 windowsHide（U1 关闭）、Node win-x64 zip 实为 38 MB、--experimental-transform-types 移除版本为 v24.12.0/v25.2.0、U2 关闭（node:fs / node:child_process 兼容状态行已补齐）；[18] 更正为 markdown 源全文核实。

## 1. 研究问题与决策依赖

票面研究问题（原文）：重写完整预测伴随进程及本地网页设置时，Node 或 Bun 等运行/打包方式怎样满足静默按需启动、单实例、60秒空闲退出、模型所有权、跨平台本地IPC与无需Python的独立安装？哪些技术事实足以比较可用方案？

五项硬需求拆解：

1. 静默按需启动：产物被 Weasel/Lua 在按键时按需 spawn，不得闪现控制台窗口。这是两层问题——产物自身的 PE 子系统（console vs GUI），以及应用再 spawn 子进程（icacls、PowerShell、ollama）时的隐藏选项。
2. 单实例：项目已定「应用目录锁文件 + 存活检查」方案（ADR-0002），需要运行时提供等价的进程存活检查原语，且不与锁文件方案冲突。
3. 60 秒空闲退出：项目自实现 IdleTimer（monotonic 时钟），需要运行时的父进程退出语义不与「持有子进程」状态冲突。
4. 模型所有权：sidecar 负责定位/启动/终止 ollama，需要子进程终止语义在 Windows 上的官方明确说明。
5. 无 Python 独立安装：终端用户安装产物不含 Python、npm、原生编译工具链。

决策依赖：

- issue #5 需要每个运行时的发行形态（zip / msi / 单文件 exe）、体积、安装/卸载语义、许可证随附义务。
- issue #7 需要：产物 PE 子系统事实、子进程终止语义、空闲退出交互（尤其 Bun 的父进程退出语义差异）、原生通知（WM_COPYDATA + MessageBox）的纯 JS 接入通道对照。

## 2. 现状基线（本项目已确立的运行时约束，本地代码即事实）

以下为 repo 内文件事实（相对 repo 根），是所有候选比较的基准：

- src/runtime/lifecycle.ts：DEFAULT_IDLE_SECONDS = 60；IdleTimer 用 monotonicSeconds 时钟，expired() 判 now - last >= idleSeconds；SingleInstance 用锁文件 openSync(path, "wx") 抢占 + process.kill(pid, 0) 存活检查。
- src/runtime/child-process.ts：spawnHidden = node:child_process spawn，stdio: "ignore"、windowsHide: true、child.unref?.()；terminate() 先 child.kill() 再 child.kill("SIGKILL")。
- docs/adr/0002-node-runtime-substitutes.md：单实例从命名互斥体 CreateMutexW("Local\RimeModelPredict.Sidecar") 改为应用目录锁文件 + process.kill(pid,0)，第二实例静默退出返回 0。错误路径 MessageBox 用 powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden 调 [System.Windows.Forms.MessageBox]::Show(...)，文案经环境变量 RIME_MODEL_PREDICT_ALERT 传递（防引号注入）；代价 = 错误路径多一次进程启动 + 依赖 Windows 自带 PowerShell。
- docs/adr/0001-completion-notify-port.md 与 src/runtime/completion-notify.ts：完成通知抽为端口 NativeWindowMessenger.send(windowClass, messageId, payload, timeoutMs)；常量 WEASEL_WINDOW_CLASS = "WeaselIPCWindow_1.0"、WM_COPYDATA = 0x004a、COPYDATA_ID = 0x5250_4d31、SMTO_ABORTIFHUNG = 0x0003、超时 300ms；默认实现 unsupportedCompletionNotifier 显式空实现（不发送，返回 false），降级表现 = 预测结果等下一次按键才刷新；后续二选一：编译小原生助手（沿用旧 rime_model_predict_launcher.c 逻辑）或 Lua 侧自行刷新。
- src/ipc/file-ipc.ts 与 src/ipc/app-paths.ts：文件 IPC（ipc/requests、ipc/responses），先写 .part 再 fsyncSync + renameSync 原子改名，.ready 标记文件；纯文件系统操作，与运行时无关。
- src/settings/private-directory.ts：win32 下 spawnSync icacls.exe 收紧 ACL（/inheritance:r 与 /grant:r DOMAIN\user:(OI)(CI)F），windowsHide: true。
- src/providers/ollama.ts：findOllamaCli 扫 env PATH 与 %LOCALAPPDATA%\Programs\Ollama\ollama.exe；模型库 %USERPROFILE%\.ollama\models；ollama serve 经 spawnHidden 自有子进程启动；pull 为 [cli, "pull", ...]，取消时 terminate()；错误码 ollama_missing / ollama_start_failed。
- src/cli/main.ts：--idle-seconds 默认 60；锁抢占失败静默退出返回 0。
- package.json：engines {"node": ">=22.6"}；build = tsc -p tsconfig.json 产出 dist/ 普通 JS（bin = dist/cli/main.js）；运行时依赖仅 zod ^4.6.5（MIT，npm registry latest 核实）；python 只出现在开发期 fixture 工具（tools/oracle/dump_fixtures.py），不在运行路径。

推论：五项硬需求中，单实例、空闲退出、模型所有权、IPC 的主体逻辑都是项目自身 TS 代码；运行时差异集中在「产物形态与静默 spawn」「存活检查/终止原语」「原生通知接入通道」「发行形态与许可义务」四块。

## 3. 候选运行时逐项核查

### 3.1 Node.js SEA（Single Executable Applications）

官方状态 [1]：Stability: 1.1 - Active development（introduced in v19.7.0）。生成方式 = 将 blob 注入 node 二进制（官方文档以 postject 工具注入）；v25.5.0 起官方提供 --build-sea CLI 内置生成 [1]。

- 静默/按需启动：产物是「node 二进制 + blob」注入后的单文件 exe。SEA 官方文档对 Windows console/GUI 子系统零提及（检索 console / GUI / subsystem 无相关命中）→ 未找到官方说明，PE 子系统需隔离测量（测量清单 #1、#2）。应用自身再 spawn 子进程时，windowsHide 为官方选项（"Hide the subprocess console window that would normally be created on Windows systems. Default: false"，可显式 true）[2]。
- 单实例：官方 API 文档未见内置单实例机制 → 未找到官方说明。存活检查原语官方支持："Sending signal 0 can be used as a platform independent way to test for the existence of a process." [3] —— 与 ADR-0002 锁文件方案直接兼容。
- 权限：zip 解压 / 单文件 exe 形态无需管理员与安装器；icacls.exe ACL 操作经 spawnSync 调用属常规 child_process 用法 [2]。
- 体积/内存/冷启动：官方发行目录提供 node-v24.21.0-win-x64.zip = 38 MB（官方 dist 目录页，2026-09-08 构建；解压后体积未实测）[8]；SEA 产物体积、内存、冷启动官方无数字 → 需隔离测量。
- 跨平台矩阵：官方注记——跨平台生成 SEA 时 useCodeCache 与 useSnapshot 必须为 false（"to avoid generating incompatible executables"）[1]；blob 平台无关，注入各平台官方 node 二进制（nodejs.org/dist 提供 windows-x64/arm64、darwin、linux 各形态）[8]。三平台矩阵以官方二进制覆盖为准。
- 许可证：Node.js 本体 MIT（nodejs/node LICENSE）[10]；再分发需随附 Node 许可文本及 node 二进制内第三方组件的许可材料（官方仓库随附）。
- 资源清理：subprocess.kill 默认 SIGTERM；Windows 无 POSIX 信号，官方原文：SIGKILL、SIGTERM、SIGINT、SIGQUIT 一律强制终止（类似 SIGKILL），SIGWINCH 抛 ENOSYS 且子进程继续运行 [2]。kill 无进程树级联说明 → 父进程退出后 ollama 进程树是否残留需隔离测量（#9）。空闲退出定时器为项目自实现，与运行时无关。
- node_modules 处理（官方说法）：SEA 的输入是 bundled script（"create a single executable application from their bundled script"）[1]，即依赖需先经打包器 bundle；资源嵌入走 sea-config assets + sea.getAsset()/getAssetAsBlob()/getRawAsset()（v21.7.0 起）与 getAssetKeys()（v24.8.0）[1]；v26.9.0 起提供 useVfs 只读虚拟文件系统——经标准 node:fs 访问，"Packages bundled under the node_modules asset prefix also resolve"（限定挂载根内）[1]；vfsArchive 可整体嵌入预构建 ZIP（与 assets 互斥）[1]。本项目运行时依赖仅 zod，bundle 后走 SEA 在官方机制内（未实测）。

### 3.2 Node.js 便携 zip vs 用户已装 Node

- 官方 dist 同时提供 Windows 安装器（.msi）与二进制（.zip/.7z/.exe）[8][9]。zip 形态解压即用，不需要安装器；node-v24.21.0-win-x64.zip 38 MB 为官方目录数据 [8]。
- 便携 zip：版本钉死、无安装器、每份 38 MB，可随应用分发或首次运行落地。用户已装 Node：零额外体积，但版本不受控（engines >=22.6 是项目声明线，见 3.3）。设置页与协议均为本地运行、无中央服务器，随包携带运行时更贴合「无 Python 的独立安装」硬需求；二者取舍属产品决策（issue #5），本文只给事实。
- 官方不提供「应用脚本合并进 zip」的现成便携形态；应用侧要么双分发（应用 + zip），要么自制安装器。

### 3.3 Node 版本现状与 type stripping（跑 TS 源 vs 跑 dist）

- LTS 时间线（官方 release schedule [5]）：22.x Maintenance LTS (Jod)，EOL 2027-04-30；24.x Active LTS (Krypton)，EOL 2028-04-30；26.x Current（2026-05-05 发布，计划 2026-10-28 转 LTS），EOL 2029-04-30；20.x 已于 2026-04-30 EOL。dist 最新 Current 条目为 v26.10.0（2026-09-21）[8]。
- type stripping 版本史（官方 typescript 模块文档 [4] + 发布公告 [6][7]）：v22.6.0 引入 --experimental-strip-types（"Node.js introduces the --experimental-strip-types flag for initial TypeScript support"）；v22.7.0 加 --experimental-transform-types；v23.6.0 与 v22.18.0 默认开启（"Node.js will be able to execute TypeScript files without additional configuration: node file.ts"，当时仍标注 experimental）；v24.12.0 "Type stripping is now stable"；v24.12.0（LTS 24.x）与 v25.2.0 移除 --experimental-transform-types（官方文档版本史，PR 61803）。模块级 Stability: 2 - Stable [4]。
- 对本项目：package.json engines >=22.6，但构建用 tsc 产出 dist/ 普通 JS——跑 dist 产物：任何满足 engines 的 Node（>=22.6）皆可，与 type stripping 无关；直接跑 TS 源码：22.6–22.17 需显式 flag，22.18+/23.6+ 默认可用，24.12+ 起 stable；且 type stripping 仅支持 erasable 语法（类型语法替换为空白，不做类型检查）[4]。结论：运行时选型按「跑 dist」评估；type stripping 只影响开发期与 prototype 便利性。

### 3.4 Bun

- 单文件产物（官方声明，本项目未实测）[13]："Bun's bundler implements a --compile flag for generating a standalone binary from a TypeScript or JavaScript file."；"Bun bundles all imported files and packages into the executable, along with a copy of the Bun runtime. All built-in Bun and Node.js APIs are supported." —— 依赖与 node_modules 自动打进产物，官方机制明确，无需外部打包器。
- 交叉编译（官方）[13]："Use the --target flag to compile your standalone executable for a different operating system, architecture, or version of Bun than the machine you're running bun build on."；目标：bun-linux-x64、bun-linux-arm64、bun-windows-x64、bun-windows-arm64、bun-darwin-arm64、bun-darwin-x64；Windows 目标默认 x64 且自动补 .exe。三平台矩阵官方覆盖（Windows x64/arm64、macOS x64/arm64、Linux x64/arm64）。
- Windows 支持状态（官方）[15]："Bun requires Windows 10 version 1809 or later."；"Bun ships as a single, dependency-free executable. Install it with the install script, a package manager, or Docker on macOS, Linux, and Windows."；官方发布直链提供 bun-windows-x64.zip 与 bun-windows-aarch64.zip（安装页下载卡片给出）[15][19]。
- 静默/按需启动：Bun 产物 PE 子系统与 --windows-icon 等元数据在官方 executables 文档无说明（检索命中均为示例代码）→ 未找到官方说明，需隔离测量（#1、#3）[13]。应用自身再 spawn 子进程（icacls、PowerShell、ollama）时，Bun.spawn 官方 SpawnOptions 明确含 windowsHide?: boolean 与 windowsVerbatimArguments?: boolean（官方 child-process 文档 markdown 源全文核实，见 6.2 U1 关闭记录）[18]。
- 空闲退出交互（官方语义差异，对 #7 架构决策重要）[18]："The parent bun process does not terminate until all child processes have exited. Use proc.unref() to detach the child process from the parent." —— Bun.spawn 的子进程默认阻止父进程退出。本项目 OwnedChildProcess 若迁到 Bun，必须在空闲退出路径显式 unref 或先 terminate，否则 60 秒空闲退出永不触发。此为官方声明，实际交互需隔离测量（#3）。
- 子进程终止（官方）[18]：proc.kill(15) 与 proc.kill("SIGTERM") 均为官方文档示例；resourceUsage() 提供 maxRSS/cpuTime。
- bun:ffi 调 user32（官方说法 + 待验证）[14]：bun:ffi 顶部官方警告原文："bun:ffi is experimental, with known bugs and limitations. Do not rely on it in production. The most stable way to interact with native code from Bun is to write a Node-API module."；机制上 dlopen 任何支持 C ABI 的库（Windows 后缀 .dll），而 WM_COPYDATA 所需 FindWindowW / SendMessageTimeoutW / MessageBoxW 均属 user32.dll 的 C ABI 函数（Microsoft 官方文档页存在，[35]–[38]）；官方 Windows 注记："The Windows API type HANDLE does not represent a virtual address, and using ptr for it does not work as expected. Use u64 to safely represent HANDLE values." —— 直接决定句柄传递写法。结论：官方机制存在，但官方无 user32 / WM_COPYDATA 实例文档；COPYDATASTRUCT 结构体布局与跨线程 SendMessage 行为未测，需隔离验证（#8）。
- 单实例：官方文档未见内置单实例机制 → 未找到官方说明；锁文件方案兼容，但 Bun 侧 process.kill(pid,0) 等价存活性检查未单独核实（归测量清单 #10）。
- 权限：单文件 exe 无需安装器；icacls 经 Bun.spawn 调用时可用官方 windowsHide?: boolean 选项隐藏子进程窗口 [18]。
- 体积/冷启动：官方文档与发布页未见单文件产物体积或冷启动数字（官网营销页的 speed 声明非本项目场景，不采信）→ 需隔离测量（#5–#7）。
- 许可证 [16]：官方 LICENSE.md 原文 "Bun itself is MIT-licensed."；"Bun statically links JavaScriptCore (and WebKit) which is LGPL-2 licensed"，并引用 LGPL2 静态链接义务（须以 object 格式提供应用，便于用户修改库后重链接；patched WebKit 在 github.com/oven-sh/webkit）；另附静态链接库清单（boringssl 多许可、tinycc LGPL v2.1、zstd BSD/GPLv2、libicu ICU 许可等）。再分发 Bun 产物需按官方 LICENSE.md 随附 MIT + LGPL-2 及第三方许可材料——义务比 Node 重（issue #5 评估）。
- node:fs / node:child_process 兼容：官方 nodejs-compat 文档声明 "It reflects the latest version of Bun's compatibility with Node.js v26"；node:fs 🟢 "Fully implemented. 98% of Node.js's test suite passes"；node:child_process 🟡（IPC 句柄受限、缺 subprocess.channel.ref()/unref()、spawnSync 不在 output 返回额外 stdio 管道）[17]。对本项目影响：文件 IPC 走 node:fs 原子写，兼容状态良好；OwnedChildProcess 不依赖 IPC 通道，缺失项无碍（见 6.2 U2 关闭记录）。

### 3.5 Deno

- deno compile（官方）[20]：官方 manual 含 Cross Compilation 小节："You can cross-compile binaries for other platforms by using the --target flag."；示例含 "deno compile --target aarch64-apple-darwin main.ts" 与 "deno compile --target x86_64-pc-windows-msvc --icon ./icon.ico main.ts" —— Windows 交叉编译与图标设置为官方支持；Supported Targets 表包含 Windows/x86_64 对应 x86_64-pc-windows-msvc（完整表格未截全，6.2 U4）；运行时 flags（含权限 flags）必须在编译期指定（"the runtime flags used to execute the script must be specified at compilation time. This includes permission flags."）；页面另有 Bundling dependencies、Code Signing、Self-Extracting Executables 等小节（细节未细抓）。
- FFI（官方）[21]：Deno.dlopen —— "Opens an external dynamic library and registers symbols, making foreign functions available to be called."；Windows 专属支持说明在 manual 与 API 参考页均未命中 → 未找到官方说明，user32 调用可行性需隔离验证（#8）。
- 静默/按需启动：Deno 产物 PE 子系统官方无说明 → 未找到官方说明，需隔离测量（#1、#4）。
- spawn 子进程（官方 API）[22]：Deno.CommandOptions 列出 windowsRawArguments、uid、gid 等选项，无 windowsHide（已核实该 API 页）→ Deno 侧 spawn icacls.exe 等控制台程序时的无窗行为未找到官方说明，需实测（#12）。
- 单实例：官方文档未见内置单实例机制 → 未找到官方说明；存活检查等价 API 未核实（#10）。
- 体积/冷启动：官方无本项目场景数字 → 需隔离测量（#5–#7）。
- 许可证 [23]：MIT License（"Copyright 2018-2026 the Deno authors"，LICENSE 文件头部核实）；V8/Rust 生态第三方组件的随附义务未逐条清点。
- node:fs / npm 依赖兼容：未核实（6.2 U5）；本项目依赖仅 zod，Deno compile 对 npm 依赖的支持需先核实再评估。

### 3.6 打包器现状

- vercel/pkg（官方弃用，原话与日期）[24][25]：README IMPORTANT 块："`pkg` has been deprecated with `5.8.1` as the last release. There are a number of successful forked versions of `pkg` already with various feature additions. Further, we're excited about Node.js 21's support for single executable applications. Thank you for the support and contributions over the years. The repository will remain open and archived."；仓库 archived: true，最后推送 2024-01-03，MIT。
- @yao-pkg/pkg（社区延续，活跃）[26][27]：README："This is yao-pkg/pkg — the actively maintained fork of the archived vercel/pkg. New releases ship as @yao-pkg/pkg."；"pkg takes your Node.js project and ships it as a single binary that runs on devices without Node.js installed. Cross-compile for Linux, macOS, and Windows from any host."；MIT；最新 release v6.23.0（2026-09-29，GitHub API 实抓；npm registry latest 6.23.0 MIT 亦核实）。Windows 产物子系统/图标：README 未命中 → 未找到官方说明。
- nexe [28][29]：README 自述默认下载 pre-built executable（releases 页标 v3.3.3），自构建需 node BUILDING.md 环境，且 "the python binary in your path should be an acceptable version of python 3"；npm registry latest = 5.0.0-beta.4（MIT，无弃用标记）[29]；GitHub 仓库维护状态因 API 限流未能核实（6.2 U6）。总体：活跃度弱于 yao-pkg；自构建路径引入 Python（影响构建期而非分发期）。
- caxa（已死）[30][31][32]：README 首行官方原话："**Migrated to https://github.com/radically-straightforward/radically-straightforward (package)**"；npm registry 弃用标记："Package no longer supported."；npm latest 3.0.1（MIT）；GitHub 最后 release v2.0.0（2021-06-02）。→ 排除。
- 事实结论：vercel/pkg 与 caxa 均已官方停摆；nexe 弱活跃（npm 5.0.0-beta.4）；@yao-pkg/pkg 是 pkg 系唯一活跃延续（v6.23.0 / 2026-09-29，官方自述跨平台交叉编译）。若走 pkg 系路线，只剩 @yao-pkg/pkg 可考虑。

### 3.7 Electron / Tauri（一句话排除）

- Electron（官方 README）[33]："The Electron framework lets you write cross-platform desktop applications using JavaScript, HTML and CSS ... based on Node.js and Chromium" —— 常驻 GUI 框架并内嵌完整 Chromium；本项目无常驻 GUI（设置页走本地浏览器），体积与复杂度不匹配 → 不展开。
- Tauri（官方 README）[34]："Tauri is a framework for building tiny, blazingly fast binaries ... The backend of the application is a rust-sourced binary" —— 面向 GUI 应用、后端为 Rust（非本项目 TS 技术栈）→ 不展开。

### 3.8 原生通知接入通道对照（WM_COPYDATA 完成通知 + 错误路径 MessageBox）

Win32 事实基础（Microsoft Learn 全部实抓核实）[35][36][37][38]：WM_COPYDATA message (Winuser.h)、MessageBoxW function (winuser.h)、FindWindowW function (winuser.h)、SendMessageTimeoutW function (winuser.h) 官方文档页均存在。当前 TS 实现为显式空实现端口（NativeWindowMessenger），两条通知线都在等一个「怎么发」的实现。

| 通道 | 官方支持状态与约束 |
| --- | --- |
| Bun FFI | bun:ffi 官方标注 experimental："Do not rely on it in production. The most stable way ... is to write a Node-API module" [14]；Windows HANDLE 须用 u64 而非 ptr [14]；COPYDATASTRUCT 布局与 SendMessageTimeoutW 跨线程行为未测。 |
| Deno FFI | Deno.dlopen 官方存在 [21]；Windows 专属说明未找到官方说明；稳定性与 user32 可行性未测。 |
| N-API / node-addon（Node 路线） | Node-API 官方定位 "an API for building native Addons" [11]；构建链 node-gyp 官方要求 Python（"Python >= v3.12 requires node-gyp >= v10"）与 Visual Studio Build Tools [12]——构建期需要 Python/VS；若分发预编译 addon，终端用户侧无 Python，与「无 Python 独立安装」在分发期兼容。 |
| 独立原生小助手 exe | 三类运行时均可用官方子进程 API 调用（Node spawn [2] / Bun.spawn [18] / Deno.Command [22]）；沿用旧 rime_model_predict_launcher.c 逻辑编译为小 exe，与运行时解耦，符合 ADR-0001 二选一方向之一。 |
| PowerShell 桥（现状） | 项目已实现（ADR-0002）：powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden + 环境变量传文案；代价 = 错误路径多一次进程启动；Windows 内置组件，无再分发义务；-WindowStyle Hidden 行为未单独核对官方文档（6.2 U7）。 |

IPC 说明：本项目 IPC 为文件 IPC（.part + fsync + rename 原子写 + .ready 标记），纯文件系统操作，与运行时选择无关；Node 侧项目代码已在用，Bun 官方兼容页含 node:fs 小节 [17]，Deno 侧未核实（6.2 U5）。

## 4. 已知 vs 未测对照表（验收核心）

| 维度 | 官方已声明（引用） | 未找到官方说明 / 需隔离测量 |
| --- | --- | --- |
| 产物 PE 子系统（console/GUI，决定被 Lua spawn 是否闪窗） | —— SEA / Bun / Deno 官方文档均零提及 | 全部候选需实测（#1–#4） |
| spawn 子进程无窗 | Node windowsHide 官方选项（Default false，可 true）[2]；Bun.spawn SpawnOptions 官方含 windowsHide?: boolean [18] | Deno.CommandOptions 无 windowsHide 选项 [22]，icacls/PS 无窗行为需实测（#12） |
| 单实例原语 | Node process.kill(pid,0) 存活检查官方支持 [3] | 三运行时官方均无内置单实例机制（未找到官方说明）；Bun/Deno 存活检查等价 API 需 prototype 验证（#10） |
| 60 秒空闲退出 | Bun：子进程默认阻止父退出、须 unref [18]；Node：unref 官方语义 [2] | Bun 迁移下 OwnedChildProcess + IdleTimer 实际交互需实测（#3） |
| 子进程终止 | Node：Windows 上 SIGKILL/SIGTERM 等强制终止 [2]；Bun：kill(15)/kill("SIGTERM") [18] | ollama 进程树是否残留（无 job object）需实测（#9）；Deno kill 语义未核实 |
| 模型所有权 | Node PATH 查找与 spawn API 官方 [2] | Bun/Deno 下查找与 spawn 行为需实测 |
| IPC 文件原子写 | Bun node:fs 小节存在 [17]；Node 项目代码已在用 | Deno node:fs 兼容未核实（U5） |
| 体积/内存/冷启动 | Node win-x64 zip 38 MB（官方 dist 数据）[8] | 其余全部需隔离测量（#5–#7） |
| 交叉编译矩阵 | SEA useCodeCache/useSnapshot=false [1]；Bun --target 六目标 [13]；Deno --target x86_64-pc-windows-msvc + --icon [20]；yao-pkg 自述 cross-compile [26] | SEA 注入流程在 Windows 构建机的实操需 prototype 演练（#2） |
| node_modules 处理 | SEA：bundled script + assets/VFS（v26.9.0 起 node_modules 前缀可解析）[1]；Bun：自动 bundle all imported packages [13]；Deno：manual 有 Bundling dependencies 小节（未细抓）[20] | SEA VFS 模式下 zod 解析需 prototype 验证 |
| 许可证 | Node MIT [10]；Bun MIT + 静态链接 JSC/WebKit LGPL-2 义务 + 第三方库清单 [16]；Deno MIT [23]；@yao-pkg MIT [26]；zod MIT（npm registry） | 再分发许可材料清单的产品化整理（issue #5） |
| 原生通知 | Win32 四 API 官方文档存在 [35]–[38]；bun:ffi HANDLE 须 u64 [14] | bun:ffi / Deno FFI 实调 user32 未测（#8）；N-API addon 构建需 Python/VS（构建期）[12] |

## 5. 建议的隔离测量清单（给后续 prototype 票，本票不执行）

1. PE 子系统核查（全部候选产物）：读 exe PE OptionalHeader Subsystem 字段（2=GUI，3=console），并从隐藏父进程 spawn 观察是否闪窗。
2. Node SEA 原型：bundle zod → 生成 SEA blob → postject 注入 win-x64 node 二进制 → 验证静默 spawn、到 IPC ready 的耗时、60 秒空闲退出；顺带演练 useCodeCache/useSnapshot=false 的跨平台注入约束。
3. Bun 原型：bun build --compile --target=bun-windows-x64 → 同口径测量；重点验证 Bun.spawn 子进程默认阻止父退出对 IdleTimer 的影响与 unref 行为。
4. Deno 原型：deno compile --target x86_64-pc-windows-msvc → 同口径测量；另测 Deno.Command spawn icacls 是否闪窗（无 windowsHide 官方选项）。
5. 体积：SEA 产物 / Bun 产物 / Deno 产物 / @yao-pkg 产物 / Node 便携 zip 解压后体积对比。
6. 冷启动：从进程 spawn 到 IPC ready（首个 .ready 文件）的 p50/p95（≥30 次），各产物同机对比。
7. 常驻内存：空闲与挂 ollama serve 两个状态的 Private Bytes 对比。
8. 原生通知原型：bun:ffi 与 Deno.dlopen 各写 FindWindowW + SendMessageTimeoutW(WM_COPYDATA) 最小示例（COPYDATASTRUCT 布局、HANDLE 用 u64），在 Weasel 环境验证候选窗刷新；同步测 MessageBoxW 错误路径。
9. 终止语义：spawn ollama serve 后 kill / SIGTERM / terminate，观察进程树残留（任务管理器对照），评估是否需要 job object。
10. 锁文件 + 存活检查在 Bun / Deno 的等价实现验证（process.kill(pid,0) 兼容性）。
11. @yao-pkg/pkg 对照测量（同 #2 口径），作为 SEA 的低操作成本替代。
12. ACL 收紧路径：Bun / Deno 下 icacls spawnSync 等价调用与失败分支。

## 6. 参考来源清单

### 6.1 已核实来源（✓ = 本次实际抓取并核对页面内容）

Node.js：

- [1] ✓ SEA 官方文档：https://nodejs.org/api/single-executable-applications.md
- [2] ✓ child_process 官方文档：https://nodejs.org/api/child_process.md（windowsHide、kill 的 Windows 信号语义）
- [3] ✓ process 官方文档：https://nodejs.org/api/process.md（process.kill(pid,0) 存活检查；页面超 100KB 截断但 kill 节完整）
- [4] ✓ TypeScript 模块官方文档：https://nodejs.org/api/typescript.md（type stripping 版本史与 Stable 状态）
- [5] ✓ 官方 release schedule：https://github.com/nodejs/release/blob/main/README.md（22/24/26 时间线）
- [6] ✓ v22.6.0 发布公告：https://nodejs.org/en/blog/release/v22.6.0（--experimental-strip-types 引入）
- [7] ✓ v23.6.0 发布公告：https://nodejs.org/en/blog/release/v23.6.0（unflag，node file.ts）
- [8] ✓ 官方发行目录：https://nodejs.org/dist/（latest-v24.x/：node-v24.21.0-win-x64.zip 38 MB，2026-09-08；index.json：最新 v26.10.0，2026-09-21，含 win-x64-zip/msi/exe 与 win-arm64-zip）
- [9] ✓ 官方下载页：https://nodejs.org/en/download
- [10] ✓ Node.js 许可证（MIT）：https://github.com/nodejs/node/blob/main/LICENSE
- [11] ✓ Node-API 官方文档：https://nodejs.org/api/n-api.html（"an API for building native Addons"）
- [12] ✓ node-gyp README：https://github.com/nodejs/node-gyp/blob/main/README.md（Python 与 VS Build Tools 要求）

Bun：

- [13] ✓ Single-file executable（bundler/executables）：https://github.com/oven-sh/bun/blob/main/docs/bundler/executables.mdx
- [14] ✓ bun:ffi 官方文档：https://github.com/oven-sh/bun/blob/main/docs/runtime/ffi.mdx
- [15] ✓ Bun 安装文档：https://github.com/oven-sh/bun/blob/main/docs/installation.mdx
- [16] ✓ Bun LICENSE.md：https://github.com/oven-sh/bun/blob/main/LICENSE.md
- [17] ✓ Bun Node.js 兼容页：https://github.com/oven-sh/bun/blob/main/docs/runtime/nodejs-compat.mdx
- [18] ✓ Bun.spawn 官方文档 markdown 源：https://bun.com/docs/runtime/child-process.md（/docs/api/spawn 的官方 alternate，25KB 全文核实：SpawnOptions 含 windowsHide;父进程退出语义 "The parent bun process does not terminate until all child processes have exited. Use proc.unref() to detach the child process from the parent.";kill(15)/kill("SIGTERM") 示例;resourceUsage()）
- [19] ✓ 官方 Windows 产物直链（安装页卡片给出）：https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64.zip 与 https://github.com/oven-sh/bun/releases/latest/download/bun-windows-aarch64.zip

Deno：

- [20] ✓ deno compile 官方 manual：https://docs.deno.com/runtime/manual/tools/compiler/
- [21] ✓ Deno FFI 官方 manual：https://docs.deno.com/runtime/manual/runtime/ffi_api/
- [22] ✓ Deno.CommandOptions API 参考：https://docs.deno.com/api/deno/~/Deno.CommandOptions（含 windowsRawArguments/uid/gid，无 windowsHide）
- [23] ✓ Deno 许可证（MIT）：https://github.com/denoland/deno/blob/main/LICENSE

打包器与框架：

- [24] ✓ vercel/pkg README（官方弃用声明）：https://github.com/vercel/pkg/blob/main/README.md
- [25] ✓ vercel/pkg 仓库元数据（GitHub API）：https://api.github.com/repos/vercel/pkg（archived true，pushed_at 2024-01-03）
- [26] ✓ @yao-pkg/pkg README：https://github.com/yao-pkg/pkg/blob/main/README.md
- [27] ✓ @yao-pkg/pkg 最新 release（GitHub API）：https://api.github.com/repos/yao-pkg/pkg/releases/latest（v6.23.0，2026-09-29）
- [28] ✓ nexe README：https://github.com/nexe/nexe/blob/master/README.md
- [29] ✓ nexe npm registry：https://registry.npmjs.org/nexe/latest（5.0.0-beta.4，MIT）
- [30] ✓ caxa README（迁移声明）：https://github.com/leafac/caxa/blob/main/README.md
- [31] ✓ caxa npm registry（弃用标记，MIT）：https://registry.npmjs.org/caxa/latest
- [32] ✓ caxa 最新 release（GitHub API）：https://api.github.com/repos/leafac/caxa/releases/latest（v2.0.0，2021-06-02）
- [33] ✓ Electron README：https://github.com/electron/electron/blob/main/README.md
- [34] ✓ Tauri README：https://github.com/tauri-apps/tauri/blob/dev/README.md

Win32（Microsoft Learn）：

- [35] ✓ WM_COPYDATA message (Winuser.h)：https://learn.microsoft.com/en-us/windows/win32/dataxchg/wm-copydata
- [36] ✓ MessageBoxW function (winuser.h)：https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-messageboxw
- [37] ✓ FindWindowW function (winuser.h)：https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-findwindoww
- [38] ✓ SendMessageTimeoutW function (winuser.h)：https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendmessagetimeoutw

依赖：

- zod（运行时唯一依赖）npm registry latest：MIT（本次核实）。

### 6.2 未能核实清单（本次取不到或未完成）

- U1【已关闭，复核修正】Bun.spawn windowsHide：官方 child-process 文档 markdown 源全文核实 SpawnOptions 含 windowsHide?: boolean [18]（初次核查因页面 100KB 截断漏检）；选项的实际隐藏效果仍归测量清单 #3。
- U2【已关闭，复核补齐】node:fs 🟢 Fully implemented（"98% of Node.js's test suite passes"）；node:child_process 🟡（IPC 句柄受限、缺 subprocess.channel.ref()/unref()、spawnSync 额外 stdio 管道不在 output）[17]。
- U3 Deno FFI 的 Windows 专属支持说明（manual 与 API 参考页均无命中）→ 未找到官方说明。
- U4 deno compile Supported Targets 完整表格（Windows/x86_64/x86_64-pc-windows-msvc 已确认，其余平台未截全）。
- U5 Deno 的 node:fs 兼容层与 npm 依赖（zod）在 deno compile 下的支持情况。
- U6 nexe GitHub 仓库维护状态（GitHub API 限流未返回；npm registry latest = 5.0.0-beta.4 已核实）。
- U7 PowerShell -WindowStyle Hidden 的官方文档页（未单独核查；现状为项目已实现行为，见 ADR-0002）。
- U8 Bun / Deno 的 process.kill(pid,0) 等价存活检查与 spawnSync icacls 等价调用（归测量清单 #10、#12）。
- U9 三类运行时的体积 / 内存 / 冷启动官方数字（除 Node win-x64 zip 38 MB 外均无）→ 全部归测量清单 #5–#7。

---

研究时点说明：以上内容基于抓取当日（2026-10）各官方页面的实际内容；LTS 日期、版本号与 release 状态以后续官方页面为准，引用本材料时建议回链 6.1 的 URL 复核。