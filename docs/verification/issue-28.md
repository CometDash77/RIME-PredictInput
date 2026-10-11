# #28 S9 验证记录（2026-10-11）

真实状态：代码与禁用安装的工程候选已交付；正式 fork release 输入缺失，#28 保持 open。custom 保持原样，提供手动接入与恢复指引。独立代码审查 CLEAR/APPROVE 不等于正式发布或真机通过。

## 已执行

- `pnpm verify`：TypeScript app/tests 检查通过；33 个测试文件，600 passed + 1 skipped（601）。覆盖离线载荷、哈希/版本/PE/启动器导出拒绝、公开 release provenance 伪造、重复安装、中断恢复、旧/部分 TSF 注册、失败日志、保留用户数据及真实 junction 拒绝。
- `pnpm release:check -- --tag v0.1.0`：13/13 PASS。这是 S10 gate，不能代替安装器正式输入或 S11。
- `pnpm build:exe`：CUI、GUI 的 selftest 与 Node 基线逐项一致，均为 7 项。修复首次用户目录不存在时加锁提前退出的缺陷；真实 CLI 入口回归验证创建私有目录、持锁、ready、空闲退出与 stopped。
- fork 以源码 commit `f9115f2e1b54279dc61e0137a8a7b8ae077aa037` 实际构建：x64 WeaselServer/WeaselTSF/WeaselDeployer、Win32 WeaselSetup/WeaselTSF，MSVC v142 成功。没有宣称 fork 整体测试全绿。
- 最新 `build:installer --candidate` 成功；打包 host 的 `--help` smoke 通过。安装入口拒绝安装，没有执行 TSF 修改或服务启停。
- 非 candidate 构建拒绝本地未发布 receipt；正式 pin 查询 `predict-0.17.4.2` 实际收到 GitHub 404，未生成正式 receipt。

## 工程候选摘要

`build/installer/build-report.json` 的源码版本为 `1fb2c736371ffd6e37a8d1565fff7fe1b2dca641`，报告同时记录 `workingTreeDirty: true`；本地既有研究改动和未纳入的审查记录保持原样，逐文件摘要标识实际载荷。工具版本和摘要见 `tools/installer/toolchain.json`。

| 对象 | SHA-256 |
|---|---|
| 原始本地 fork candidate archive（4,768,872 bytes） | `060d302619b89ba756ef88e1cc0d9b8bf770735a7a52058baa100ffe2229d01a` |
| 内嵌 manifest | `a009c2d9b743da33742a577084daa0ae9b66a771332eb2ef86fcfa2ea1ea0b0c` |
| candidate setup（90,726,418 bytes） | `4fa6493705d340d2249925e263d93f389221c53abccfa7d74d5c8a4aadfb79c5` |
| installer host（57,604,821 bytes） | `f6683d88cbef6cb33e2965661060009ec9c66a1c8f7e5b70c153bde5e3411149` |

报告状态固定为 `candidate-blocked`、`releaseReady: false`。archive 是本地快照，清单内的目标 release URL 只是待发布 pin，不代表该 release 存在。NSIS 原始许可证逐字节归档，保留上游 CRLF/空格；代码 whitespace 检查排除此许可证正文。

## 未通过或未执行

- 独立 `node tools/installer/smoke-settings.mjs`：冷启动缺陷修复前实际失败；修后被固定端口 48371 的外部 Python GUI 进程占用阻塞。最新报告在 `build/smoke-settings-20261011004834017-c47cd9/report.json`，status blocked、requests 空；未启动/终止外部进程。不能写成 GUI 设置入口实跑通过。端口空闲后重跑，不预建插件用户目录。
- 没有真实 UAC、ProgramData ACL、桌面闪窗、托盘或 Weasel 窗口互操作验收；按票要求留给 #29 S11。没有实际安装、卸载、公开 release 或自动修改 custom。

下一步：整合 fork 源码与默认 `predict` 路径修复，发布可追溯 stable tag 和匹配 runtime archive；运行正式 pin 与非 candidate 构建，空闲端口复跑 GUI smoke，再推进 S11。#28 的指定 release 输入与正式内嵌来源验收未完成，因此不能关闭或追加地图“已完成”结论。
