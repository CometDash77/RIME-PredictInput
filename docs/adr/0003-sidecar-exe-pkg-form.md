# ADR 0003：sidecar 随包产物采用 @yao-pkg/pkg 单文件形态

- 状态：已采纳（2026-10-07）
- 背景：issue #9（`prototype/sidecar-artifact/REPORT.md`，map Decisions 07）在零预装
  承诺下实测四个单文件 exe 候选（node SEA / bun --compile / deno compile /
  @yao-pkg/pkg，CUI+GUI 双变体）× 七项 scope，全部 Pass。候选差异集中在：SEA 的
  require 无法解析外部原生模块（koffi 硬伤，仅 IPC 去 FFI 化可回退）；bun 私有内存
  ~86MB（BEE allocator reserve）且 WM_COPYDATA 需 koffi→bun:ffi 适配；deno 体积最大
  （103.6MB）且不推进。

## 决定

- **@yao-pkg/pkg 是 sidecar 随包产物的官方构建目标**：`pnpm build:exe` 一条命令产出
  `build/exe/rime-predict-sidecar.exe`（CUI）与 `-gui` 变体（PE 子系统字节翻转）。
- 管线固定为：`tsc` → `strip-guard`（移除 dist/cli/main.js 的直跑 guard，消除 TLA 与
  `import.meta`）→ esbuild CJS bundle → `pkg -t node22-win-x64` → PE GUI 变体 →
  selftest 等价 smoke（issue #9 P8 方法内建：exe 的 selftest 报告与 node 直跑逐字
  全等才准通过）。
- 工具落位 `tools/sidecar-exe/`；esbuild 与 @yao-pkg/pkg 进 devDependencies 锁版本。

## 后果

- **exe 形态不提供 settings 入口**：dist/web/launcher.js:30、settings-host.js:68 的
  `import.meta.url` 在 CJS bundle 里是空字符串（#9 全局降级触发条件②），`settings`
  与 `--source settings` 路径在 exe 内会崩。设置页继续走 node 安装形态；将来若
  去掉这两处 `import.meta` 依赖可重新开放。预测泵 / selftest / 空闲退出不受影响。
- **koffi（WM_COPYDATA 发送端，ADR 0001 端口）接入时**：pkg 会跟随 require 打包
  原生 .node；接入后必须重跑 P7（真实发送）与 P8（等价 smoke），并把 koffi 版本
  锁进 dependencies。
- **node 版本跟随 @yao-pkg/pkg**：升级 node 大版本依赖上游跟进；内置 node 与
  repo engines（>=22.6）patch 级差异可接受（#9 实测 v22.23.2）。
- SEA 保留为「sidecar IPC 完全去 FFI 化之后」的回退项；deno 不推进（数据留在
  #9 REPORT 与 results.json）。
