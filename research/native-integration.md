# 原生集成研究报告（重建版）

> **重建版（原分支 80ddc70 已丢失；内容按 map #1 决策记录 + #8 新证据重建，原 12 条未知项原文不可考，macOS 两条按 #8 闭环）**
> 重建日期：2026-10。钉死 ref：Squirrel `1.1.2` / master `0cd71a6130a5866b0ae6ba0494929ebdc8211194`；librime `33e7814`（1.17.0）/ `a251145`（1.16.0）。证据细节与逐条引文见 `research/parts/05-macos-reserved-refresh.md`。

---

## 1. 能力 × 平台 × 三分类主表

三项前端能力：**(a)** 真实编辑器上文；**(b)** 无按键异步刷新候选窗；**(c)** 菜单唤起设置页。
总纲（map #1 决策记录）：三项能力全在前端进程内，librime 层无入口（全仓 surround 检索命中 0；`message_sink_` 消息仅 deploy/option/property/schema）。librime @ 33e7814 · src/rime/engine.cc:144-152 · https://raw.githubusercontent.com/rime/librime/33e78140250125871856cdc5b42ddc6a5fcd3cd4/src/rime/engine.cc —— `OnPropertyUpdate` 把 property 转成 `property=value` 载荷发给前端，是唯一可能承载前端协作的引擎侧出口。

| 形态 \ 平台 | Windows（Weasel / TSF） | Linux（fcitx5 / ibus） | macOS（Squirrel / IMK） |
|---|---|---|---|
| 普通未修改前端 | (a)✗ (b)✗ (c)✗ | (a)✗ (b)✗ (c)✗ | **1.1.2（最新正式发行）**：(a)✗ (b)✗ (c)✗；**master/Nightly**：(a)✗ (b)受限✓（`_refresh_ui`，见 §4）(c)✗ |
| 附加扩展（引擎侧纯 Lua 组件 + 进程外伴随进程） | 引擎侧层成立：无 (a)(b)(c)，异步预测只能滞后到下一次按键 | 同左（fcitx5-rime / ibus-rime 引擎侧 Lua） | 同左；前端为 master/Nightly 时可经 librime-lua `set_property("_refresh_ui")` 叠加受限 (b) |
| 定制构建 | **定制 Weasel：全✓——唯一实证完整链路**（TSF 私有窗口收 WM_COPYDATA + 2 条新 IPC 命令 + 翻转 option；librime 本身不需改） | **第三形态**：不改前端二进制，新写独立输入法引擎组件（fcitx5 addon / ibus component） | **分叉 Squirrel.app（GPL-3）：全✓**（(b) 可直接复用 master `_refresh_ui`；(a) 在控制器侧读 IMKTextInput 再加桥；(c) 新增菜单+通知） |

许可证边界（map #1）：librime + librime-lua = BSD-3；Weasel GPLv3；Squirrel GPL-3；fcitx5-rime GPL-2.0+；ibus-rime GPL-3。**只分发引擎侧组件与用户目录内容不触发 copyleft；分叉分发前端则整包 GPL。**

## 2. Windows（Weasel / TSF）

- 普通未修改 Weasel：三项能力全不可得（(a)(b)(c) 均在前端进程内，librime 层无入口）。
- 附加扩展：仅在引擎侧（librime-lua 纯 Lua 组件）与进程外伴随进程层成立；无 (a)(b)(c)，异步预测只能滞后到下一次按键。
- 定制构建：定制 Weasel 是全平台唯一实证完整链路——TSF 私有窗口接收 WM_COPYDATA，新增 2 条 IPC 命令，配合翻转 option 通知引擎；librime 本身不需修改（BSD-3，无 copyleft 传染）。
- 注：本节结论为 map #1 决策记录的重建转述，原始取证随 80ddc70 丢失，未在本票重新核证。

## 3. Linux（fcitx5 / ibus）

- 普通未修改前端：三项能力全不可得。
- 附加扩展：同 Windows 的引擎侧层限定。
- 定制构建采取**第三形态**：不改前端二进制，新写独立输入法引擎组件（fcitx5 addon / ibus component），绕开前端代码的 copyleft（fcitx5-rime GPL-2.0+ / ibus-rime GPL-3 只在被分发时触发）。
- 注：本节结论为 map #1 决策记录的重建转述，原始取证随 80ddc70 丢失，未在本票重新核证。

## 4. macOS（Squirrel / IMK）——按 #8 新证据更新

- **`_refresh_ui` 保留属性刷新通道由 PR rime/squirrel#1143 引入**（merge commit `e9723977`，2026-06-22T02:29:25Z，base master）：Squirrel @ master · sources/SquirrelApplicationDelegate.swift:316-327 · https://raw.githubusercontent.com/rime/squirrel/0cd71a6130a5866b0ae6ba0494929ebdc8211194/sources/SquirrelApplicationDelegate.swift —— `property` 消息且首字符 `_` → `handleReservedProperty(key:value:for:sessionId)`；sources/ReservedProperty.swift:14 → `case refreshUI = "_refresh_ui"`；sources/SquirrelInputController.swift:303-304 → `case .refreshUI: rimeUpdate(clearReservedComments: false)`。
- **最新正式发行 1.1.2（2026-01-14）不含该机制**（releases 实查 2026-10；notificationHandler 仅 deploy/schema/option 三分支，L238-281，L257 `enableNotifications` gate 挡其余全部消息）；唯一含该机制的发行物是 Nightly（prerelease，2026-08-13）。CHANGELOG 无 1.2 条目。
- **1.1.2 上无任何等价「不按键刷新」信号**：InputController `rimeUpdate()` 全部调用点由用户动作驱动（keyDown/flagsChanged/选候选/翻页/移动光标/chord timer/ASCII 切换）。
- **判定①**：master 上，用户目录 Lua（librime-lua `Context:set_property("_refresh_ui", …)`）**可独立触发**刷新候选窗——链条：librime-lua @ master · src/types.cc:828（set_property 绑定 T=Context）→ librime @ 33e7814 · src/rime/context.cc:300-303（每调用必发通知）→ src/rime/engine.cc:82-85,144-152（`property=value` 载荷）→ Squirrel master delegate:316-327 → ReservedProperty.swift:14 → SquirrelInputController.swift:294-306 → rimeUpdate（L447+，重绘候选窗）。**1.1.2 不能**（无 property 分支，消息静默丢弃）。
- **判定②**：`_` 前缀属性仅被 `Context::ClearTransientOptions()`（librime @ 33e7814 · src/rime/context.cc:313-325）擦除，其唯一调用点是 `ApplySchema`（src/rime/engine.cc:289）——即仅切 schema 时擦；`set_property` 每调用必发通知（无值比较）；Squirrel 只消费载荷不回读属性。**可操作结论：想刷新时任一时刻调一次 `set_property("_refresh_ui", "1")` 即触发；无需为保活每轮重设；跨 schema 状态别存在 `_` 前缀属性里。**
- **同进程但无桥**：官方 app 经 `Copy Rime plugins` phase（pbxproj:104-116，dstSubfolderSpec=10=Frameworks）携带 `rime-plugins/{librime-lua,librime-octagram,librime-predict}.dylib`，librime plugins 模块同进程 dlopen（librime @ 33e7814 · plugins/plugins_module.cc:104-125）；但 librime 插件 API 不暴露宿主/ObjC/IMK client，`client: IMKTextInput?` 只在 SquirrelInputController 侧（activateServer:167-168）——(a) 必须定制前端或依赖未验证的 ObjC runtime hack。
- **官方 pkg 产物链**：Squirrel CI 不构建 librime——action-install.sh:5-13,30,35 下载 librime 1.17.0 官方资产 `rime-33e7814-macOS-universal.tar.bz2`（由 librime release-ci.yml:15-18 指定插件集 `hchunhui/librime-lua lotem/librime-octagram rime/librime-predict` 产出）并 `make copy-rime-binaries` 搬运。
- **签名/公证**：xcodebuild 层无 ENABLE_HARDENED_RUNTIME；发行由 package/sign_app:9 `codesign --deep --force --options runtime --timestamp --sign "Developer ID Application: …" --entitlements resources/Squirrel.entitlements` 启用 Hardened Runtime，Makefile:140-151 经 productsign + notarytool + stapler 公证；entitlements 含 `com.apple.security.cs.disable-library-validation=true`。替换 dylib 后须整 app 重签+重新公证（文档级）；实际系统接受行为未实测。

## 5. 定制构建与许可证小结

- 要完整 (a)(b)(c)：Windows 走定制 Weasel（实证链路，librime 零改动）；macOS 走分叉 Squirrel（GPL-3，整包 copyleft）；Linux 走第三形态独立引擎组件（避开前端 copyleft）。
- 只做引擎侧 + 用户目录（BSD-3 librime/lua 组件 + 用户数据）：不触发任何 copyleft，但 (a)(b)(c) 均不可得（macOS master/Nightly 上另有受限 (b)，见 §4）。

## 6. 未知项表

| 编号 | 内容 | 状态 |
|---|---|---|
| U-macOS-1 | （原题面不可考）macOS 免改前端刷新通道的存在性与引入版本 | **已闭环（#8）**：`_refresh_ui` 保留属性通道由 PR #1143（`e9723977`，2026-06-22）引入，仅 master/Nightly 含；最新正式发行 1.1.2（2026-01-14）无此机制，且无任何等价信号（见 §4） |
| U-macOS-2 | （原题面不可考）macOS 刷新通道的触发方式与 `_` 前缀属性边界 | **已闭环（#8）**：触发 = librime-lua `Context:set_property("_refresh_ui", "1")`（master 链条逐环闭环，1.1.2 静默）；属性仅被 ApplySchema 时的 ClearTransientOptions 擦除（engine.cc:289 唯一调用点），set_property 每调用必发通知，前端只消费载荷——单次调用即触发，无需每轮重设（见 §4） |
| U-win-*（原多条） | Windows 侧未知项 | **原文不可考**（随 80ddc70 丢失，占位待重考） |
| U-linux-*（原多条） | Linux 侧未知项 | **原文不可考**（随 80ddc70 丢失，占位待重考） |
| U-macOS-3 | librime service 层 session↔engine↔notification 绑定路径未逐行核（判定①第 6 环 session 守卫的前提） | 未核（静态可核） |
| U-macOS-4 | 用户向已安装（公证+stapled）Squirrel.app 的 `Contents/Frameworks/rime-plugins/` 替换/新增 dylib 的实际系统接受行为 | 未实测（本票禁实测；文档级条件见 §4） |
| U-macOS-5 | ObjC runtime 遍历定位 IMKInputController 实例并取 client 的可行性 | 未验证、脆弱 |
| U-macOS-6 | librime CI `make test/install` 内部 CMake 标志终值（产物布局反证 BUILD_MERGED_PLUGINS=OFF） | 未逐行核 |
| U-macOS-7 | `IMKTextInput.attributedSubstring(from:)` 当前官方文档 URL 与输入法专用签名/公证要求独立官方页 | 未定位（多 slug 实抓 404） |
| U-macOS-8 | Nightly（2026-08-13）对应的确切 master 基线 commit | 未核（按 CI 惯例自 master 构建） |