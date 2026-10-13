# PROTOTYPE — sidecar 随包产物形态实测（issue #9，抛弃式）

> **这是抛弃式原型**：只回答 issue #9 的一个问题，测完即封存（提交在抛弃式分支 `prototype/sidecar-artifact-issue9`，不进 main）。复现实验请整目录重跑。

## 要回答的问题

零预装承诺（issue #5 决策 7/12）的可行性实证：**sidecar 单文件可执行产物能否在无 Node.js 的 Windows x64 上静默常驻，且行为与 node 直跑等价？**

## 分支判定（prototype 技能的两分支为何都不适用）

- 「逻辑/状态模型是否顺畅」→ 单文件可分享 HTML：**否**。本票没有要验证的状态机，selftest 的状态语义已在 `src/runtime/` 有 210 条测试覆盖。
- 「界面应该长什么样」→ 同路由多变体：**否**。本票没有任何界面。
- 实际问题类型：**实证测量**（PE 子系统、体积、冷启动、内存、WM_COPYDATA、退出语义、锁、ACL 全是「官方零说明、必须跑出来才知道」的数）。技能开头规则「the question decides the shape」裁决产物形态 = **测量 harness（抛弃式脚本 + helper.exe）+ 实测报告 REPORT.md**；技能通用规则（抛弃式命名、一条命令可跑、外显状态、结论入库、不进 main）全部照守。
- 澄清结论：issue #9 已把 7 项 scope 与验收写死，research/typescript-runtime.md §5 给了逐条清单，无「我猜用户想要这样」的残留点；唯一开放项（报告放 research/ 还是 prototype/）票面明示二选一，选 prototype/ 与原型代码同住，理由=技能规则 1（原型就近、一眼看出是原型）。

## 怎么跑（一条命令）

```powershell
pwsh ./run.ps1
```

脚本会：装 dist → 补 koffi → esbuild bundle → 构建五形态产物（Node SEA / SEA-GUI 补丁 / Bun --compile / Deno compile / @yao-pkg/pkg）→ csc 编 helper.exe → 跑 `run-measurements.mjs` → 打印逐项测量表并写 `results.json`。产物与工具链落在 `artifacts/`、`toolchain/`（已 gitignore，不进库）。

## 文件地图

- `helper.cs` — 单文件 C 助手（csc 编译）：控制台状态上报、无窗/分离 spawn、可见控制台窗口枚举、`WeaselIPCWindow_1.0` 伪接收端（收 WM_COPYDATA 记 JSONL）。
- `pe.mjs` — PE 头工具：读 Subsystem 字段（2=GUI/3=CUI）、复制并改 GUI 子系统、清签名目录。
- `probe-node.cjs` / `probe-bun.mjs` / `probe-deno.mjs` — 同口径探针（退出/心跳/子进程窗口上报/WM_COPYDATA 发送/退出阻塞/锁文件/ACL），分别用 node:child_process、Bun.spawn+bun:ffi、Deno.Command+Deno.dlopen。
- `sea-entry.mjs` / `bun-entry.mjs` / `deno-entry.mjs` — 真实 sidecar 的入口垫片（统一 `main(argv.slice(2))`，绕开各形态 argv[1] 差异）。
- `sea-config.json` + `run.ps1` — Node SEA 构建链（esbuild 单文件 bundle → blob → postject 注入）。
- `ps-bridge.ps1` — PowerShell 加载 user32 发 WM_COPYDATA 的降级通道（测延迟用）。
- `run-measurements.mjs` — 测量编排：跑全部测试、实时打印、写 `results.json`。
- `REPORT.md` — 实测报告（票面验收物：每项 Pass/Fail/未测 + 数据 + 推荐产物形态 + 降级触发条件）。

## 结论

见 `REPORT.md`（跑完后回填）。
