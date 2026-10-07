# macOS：`_refresh_ui` 保留属性刷新通道 —— issue #8 主报告

- 调查日期：2026-10
- 钉死 ref：
  - Squirrel tag `1.1.2`；master `0cd71a6130a5866b0ae6ba0494929ebdc8211194`（下称 master）
  - librime `33e78140250125871856cdc5b42ddc6a5fcd3cd4`（1.17.0，下称 33e7814）；`a251145`（1.16.0，短 sha）
- 方法：raw.githubusercontent.com 抓源文件逐行核对；GitHub API（gh 认证通道）实查 releases / tags / commits / PR / compare / release assets；Apple 文档经 web_fetch 实测 HTTP 状态。全程静态取证，不安装、不启动、不替换任何输入法，不做运行期实测。
- **偏差说明**：issue 建议核对的本地 librime-1.13.1 源码树（`reference/.scratch/...`）在本机已不存在，librime 侧证据全部改用上述钉死 GitHub ref 实抓核对。Squirrel master 的 librime submodule 恰好指向 33e7814（见 Q4），因此该偏差不影响 Squirrel 官方构建链结论；仅「1.13.1 时代是否已有相关代码」以 1.16.0/1.12.0 标签交叉佐证。
- 引用格式：`上游 @ ref · 路径:行 · URL`，随后给出决定性原文引文。

---

## Q1 `_refresh_ui` 保留属性链路是哪个 commit/PR 引入？正式发行何时会有？

**结论**

1. 该链路由 **PR rime/squirrel#1143**（merge commit `e9723977`，merged 2026-06-22T02:29:25Z，base master，作者 wyjrichhh）引入，新增 `sources/ReservedProperty.swift` 并改写 `SquirrelApplicationDelegate.swift` 与 `SquirrelInputController.swift`。仅存在于 master（0cd71a61 含之）。
2. 截至 2026-10 实查，**最新正式发行仍是 1.1.2（2026-01-14 发布），不含该机制**；唯一的 prerelease 是 Nightly build（2026-08-13 发布，基于 master，含该机制）。1.1.2 之后无任何正式版 tag 或 CHANGELOG 条目，正式发行时间无法从仓库证据推断。
3. 1.1.2 上**没有**任何等价的「不按键刷新」信号：通知处理器只认 deploy/schema/option 三类消息，`rimeUpdate()` 的全部调用点都由用户动作（flagsChanged/keyDown/选候选/翻页/移动光标/chord timer/ASCII 切换）驱动。

**依据**

- PR 元数据：`gh api repos/rime/squirrel/pulls/1143`（实查 2026-10）→ `state=closed, merged_at=2026-06-22T02:29:25Z, merge_commit_sha=e9723977…, base=master, created=2026-06-17T02:32:58Z, user=wyjrichhh`。PR body 决定性原文：

> Introduces a `ReservedProperty` protocol so a librime plugin can coordinate with the Squirrel frontend over the existing `property` message channel, using reserved keys with a leading underscore (e.g. `_refresh_ui`). Unknown reserved keys are silently ignored, so the wire format is backward-compatible. … The motivating use case (per rime/squirrel#1124) is letting a plugin drive semantic comment styling … and trigger a UI refresh without a keystroke. … Changes: - `sources/ReservedProperty.swift` (new)

- 引入的协议定义：Squirrel @ master · sources/ReservedProperty.swift:11-15 · https://raw.githubusercontent.com/rime/squirrel/0cd71a6130a5866b0ae6ba0494929ebdc8211194/sources/ReservedProperty.swift

```swift
enum ReservedPropertyKey: String {
    case commentHighlight = "_comment_highlight"
    case commentWarning = "_comment_warning"
    case refreshUI = "_refresh_ui"
}
```

- master 上的消费链：Squirrel @ master · sources/SquirrelApplicationDelegate.swift:316-327 · https://raw.githubusercontent.com/rime/squirrel/0cd71a6130a5866b0ae6ba0494929ebdc8211194/sources/SquirrelApplicationDelegate.swift

```swift
else if messageType == "property", let messageValue = messageValue,
        let eqIndex = messageValue.firstIndex(of: "="), messageValue.first == "_" {
    let key = String(messageValue[..<eqIndex])
    …
    Task.detached { @MainActor in
        do { try delegate.panel?.inputController?.handleReservedProperty(key: key, value: value, for: sessionId) }
        catch { print("Error processing handleReservedProperty: \(error)") }
    }
    return
}
```

- releases 实查（`gh api repos/rime/squirrel/releases?per_page=100`，2026-10 时点，全部行来自 API 原始输出）：

| tag | published_at | prerelease |
|---|---|---|
| latest（release 名 Nightly build） | 2026-08-13T05:01:45Z | true |
| 1.1.2 | 2026-01-14T00:24:56Z | false（最新正式发行） |
| 1.1.1 | 2026-01-11T11:03:14Z | false |
| 1.1.0 | 2026-01-11T06:32:30Z | false |
| 1.0.3 | 2025-01-23T14:49:25Z | false |
| 1.0.2 / 1.0.1 / 1.0.0 | 2024-06-07 / 2024-05-31 / 2024-05-30 | false |
| 0.18 | 2024-05-04 | false |
| 0.16.2 | 2023-02-05 | false |

  tags 列表（同 API）无 1.2+ 版本。compare `1.1.2...0cd71a61` total_commits=31（区间含 e9723977）。
- 无正式发行计划证据：Squirrel @ master · CHANGELOG.md 顶条 · https://raw.githubusercontent.com/rime/squirrel/0cd71a6130a5866b0ae6ba0494929ebdc8211194/CHANGELOG.md → `## 1.1.2 (2026-01-13)`，全文无 1.2 条目。
- **1.1.2 排除（逐一）**：
  - Squirrel @ 1.1.2 · sources/SquirrelApplicationDelegate.swift:238-281（notificationHandler 全体）：仅 `"deploy"`（243-255）、`"schema"`（261-263）、`"option"`（264-280）三个分支；**无 property 分支**。且 L257 `if !delegate.enableNotifications { return }` 位于 deploy 分支之后，直接挡掉其余全部消息类别。· https://raw.githubusercontent.com/rime/squirrel/1.1.2/sources/SquirrelApplicationDelegate.swift
  - Squirrel @ 1.1.2 · sources/SquirrelInputController.swift：全文无 `handleReservedProperty` / `ReservedPropertyKey` / `specialCommentIndices` / `refreshUI` 标识符；`rimeUpdate()`（L427 起，无参版）调用点 L92,117（flagsChanged/keyDown）、L131（selectCandidate）、L141（page）、L161（moveCaret）、L299 附近（chord timer）——**全部用户动作驱动**。· https://raw.githubusercontent.com/rime/squirrel/1.1.2/sources/SquirrelInputController.swift
  - 1.1.2 与 master 的 Makefile 逐字节相同（5777B），排除构建层引入差异的可能。

## Q2 ClearTransientOptions 行号核实；Squirrel 消费载荷还是回读？set_property/set_option 通知语义

**结论**

1. 行号属实：librime @ 33e7814 · src/rime/context.cc:313-325 为 `Context::ClearTransientOptions()`，对 `options_` 与 `properties_` 各以 `lower_bound("_")` 起点擦除全部 `_` 前缀键；调用点唯一：src/rime/engine.cc:289，位于 `ConcreteEngine::ApplySchema`（284-294）内、紧邻 288 行 `context_->Clear()`。a251145（1.16.0）同行号；1.12.0 的 context.cc 已存在（L308），引入点更早（context.cc 提交历史 15 条中无明确引入 commit，未逐考）。
2. **Squirrel master 消费的是通知载荷**（`property=value` 字符串）：delegate 收到 `property` 消息后直接拆 `key`/`value` 传给 `handleReservedProperty`，全程不调用 `get_property` 回读。因此 **`_` 前缀属性在 Context 中是否存活根本不影响刷新触发**。
3. **librime 的 set_property / set_option 每次调用都发通知**：实现是无条件 `properties_[name] = value; property_update_notifier_(this, name);`（set_option 同构），没有「值不变则不发」的逻辑。因此「每轮重设」必然每轮产生通知。

**依据**

- librime @ 33e7814 · src/rime/context.cc:300-303 · https://raw.githubusercontent.com/rime/librime/33e78140250125871856cdc5b42ddc6a5fcd3cd4/src/rime/context.cc

```cpp
void Context::set_property(const string& name, const string& value) {
  properties_[name] = value;
  property_update_notifier_(this, name);
}
```

- 同文件 286-290（set_option，同构无条件通知）：`void Context::set_option(const string& name, bool value) { options_[name] = value; …; option_update_notifier_(this, name); }`
- 同文件 313-325（ClearTransientOptions）：对 `options_` / `properties_` 分别 `lower_bound("_")` 起擦除（日志行 `cleared option: `），**擦除本身不触发任何 notifier**。
- 调用点唯一性：librime @ 33e7814 · src/rime/engine.cc:284-294 · https://raw.githubusercontent.com/rime/librime/33e78140250125871856cdc5b42ddc6a5fcd3cd4/src/rime/engine.cc

```cpp
void ConcreteEngine::ApplySchema(Schema* schema) {
  …
  schema_.reset(schema);           // 287
  context_->Clear();               // 288
  context_->ClearTransientOptions();  // 289  <- 全文件唯一调用点
  InitializeComponents();          // 290
  …
}
```

- 载荷组装（引擎侧）：librime @ 33e7814 · src/rime/engine.cc:144-152（`OnPropertyUpdate`）：`string value = ctx->get_property(property); string msg(property + "=" + value); message_sink_("property", msg);` —— 先回读值组载荷，但前端消费的是载荷串本身。
- 载荷消费（前端侧）：Squirrel @ master · sources/SquirrelApplicationDelegate.swift:316-327（引文见 Q1）—— `messageValue.firstIndex(of: "=")` 直接拆串，无 `get_property` 调用；`handleReservedProperty`（SquirrelInputController.swift:294-306）同样只用传入的 `rawKey`/`rawValue`。
- 对照组（1.1.2 会丢弃该消息）：Squirrel @ 1.1.2 · sources/SquirrelApplicationDelegate.swift:238-281 无 property 分支（引文见 Q1）。
- 存在性交叉：librime @ a251145 · src/rime/context.cc L286/300/313 与 33e7814 同行号；librime @ 1.12.0 · src/rime/context.cc L281/295/308（ClearTransientOptions 已存在）。

## Q3 librime 插件 dylib 能否同进程拿到 IMK client（attributedSubstringFromRange:）？

**结论**

1. **同进程成立**：官方 Squirrel.app 将 `librime.1.dylib` 装入 `Contents/Frameworks/`，librime 的 plugins 模块启动时在同一进程 `dlopen` 同目录 `rime-plugins/*.dylib`（官方随包带 librime-lua / librime-octagram / librime-predict 三个）。插件代码与 IMKInputController 运行于同一 Squirrel 进程、同一地址空间。
2. **但没有官方桥**：librime 的插件 API（模块注册）与 `rime_api.h` 全部公开面都不暴露宿主对象、ObjC runtime 或 IMK client；Squirrel 前端也只把极少量环境（traits、日志目录）传给 librime。`client: IMKTextInput?` 只存在于 `SquirrelInputController`（IMKInputController 子类）侧，经 `activateServer(_:)` 捕获，插件拿不到它。
3. 因此 `attributedSubstringFromRange:` 路径**必须定制 Squirrel 前端**（在控制器侧读出上文再经既有 property/option 通道或新 IPC 传给引擎），或依赖未验证的 ObjC runtime 遍历 hack（U-macOS-5，本票禁实测）。

**依据**

- 插件运行期装载（同进程 dlopen）：librime @ 33e7814 · plugins/plugins_module.cc:104-125 · https://raw.githubusercontent.com/rime/librime/33e78140250125871856cdc5b42ddc6a5fcd3cd4/plugins/plugins_module.cc

```cpp
// L104-119 current_module_path(): dladdr(&rime_require_module_plugins) 取 plugins 模块代码所在 dylib 路径
// L122-125
void rime_plugins_initialize() {
  rime::PluginManager::instance().LoadPlugins(current_module_path().remove_filename() / RIME_PLUGINS_DIR);
}
RIME_REGISTER_MODULE(plugins);  // L129
```

  L35-69 `LoadPlugins`：遍历目录，`plugin_file.extension() == boost::dll::shared_library::suffix()`（L43）命中 `.dylib` 后 `auto plugin_lib = boost::dll::shared_library(plugin_file);`（L52，即 dlopen），`mm.Find(plugin_name)` → `mm.LoadModule(module)`（L60-61）。`RIME_PLUGINS_DIR` 定义为 `"rime-plugins"`：librime @ 33e7814 · CMakeLists.txt:34 · https://raw.githubusercontent.com/rime/librime/33e78140250125871856cdc5b42ddc6a5fcd3cd4/CMakeLists.txt
- 插件落点在 Frameworks：Squirrel @ master · Squirrel.xcodeproj/project.pbxproj:104-116（Copy Rime plugins phase）· https://raw.githubusercontent.com/rime/squirrel/0cd71a6130a5866b0ae6ba0494929ebdc8211194/Squirrel.xcodeproj/project.pbxproj → `isa = PBXCopyFilesBuildPhase; dstPath = rime-plugins; dstSubfolderSpec = 10`（10 = Frameworks）；files 为 librime-lua.dylib / librime-octagram.dylib / librime-predict.dylib，各 `settings = {ATTRIBUTES = (CodeSignOnCopy, ); }`。
- client 只在控制器侧：Squirrel @ master · sources/SquirrelInputController.swift:167-168（`activateServer`）· https://raw.githubusercontent.com/rime/squirrel/0cd71a6130a5866b0ae6ba0494929ebdc8211194/sources/SquirrelInputController.swift

```swift
override func activateServer(_ sender: IMKInputController?) { … self.client ?= sender as? IMKTextInput … }
```

  （实际行文：`self.client ?= sender as? IMKTextInput`；`showPanel`（L609-619）用 `client.attributes(forCharacterIndex: 0, lineHeightRectangle: &inputPos)` —— client 的全部用途都在控制器内。）
- librime API 无桥：librime @ 33e7814 · src/rime_api.h（595 行）全文检索 `plugin` 仅 1 处注释（L470，capnproto/proto 插件弃用说明），无宿主/ObjC/client 暴露；`src/rime_api.cc`（78 行）仅模块注册与版本查询。Squirrel 侧桥接头只暴露 librime 核心 C API：Squirrel @ master · sources/Squirrel-Bridging-Header.h（全文 7 行）· https://raw.githubusercontent.com/rime/squirrel/0cd71a6130a5866b0ae6ba0494929ebdc8211194/sources/Squirrel-Bridging-Header.h → 仅 `#import <rime_api_stdbool.h>` 与 `#import <rime/key_table.h>`。
- Squirrel 对插件的意识仅止于日志目录：Squirrel @ master · sources/SquirrelApplicationDelegate.swift:143 → `setenv("RIME_LOG_DIR", SquirrelApp.logDir.path(), 1)`，原文注释 `// Expose the log directory to librime plugins.`
- Apple 文档：`IMKInputController.client()` 官方页实测可达（HTTP 200）：https://developer.apple.com/documentation/inputmethodkit/imkinputcontroller/client() （macOS 10.5+，Instance Method，返回 IMKTextInput）。`attributedSubstringFromRange:`（Swift 名 `attributedSubstring(from:)`）属 `IMKTextInput` 协议；其当前文档页 slug 实抓 404（尝试过 `/documentation/inputmethodkit/imktextinput/attributedsubstring(from:)`、`imktextinput/1386724-attributedsubstringfromrange`、`imktextinput.md`），归档版 Reference 页为索引壳无正文 —— 该 API 的官方 URL **未取得 200 实证**（U-macOS-7），「attributedSubstring 属 IMKTextInput、由 IMKInputController.client() 获得」这一 API 归属本身为公开 API 事实，但引用页未验证。

## Q4 官方 .pkg 是否携带 rime-plugins/*.dylib？由哪个 librime 构建？签名/公证与「替换 dylib 后重签」的实际成功条件

**结论**

1. **携带**。构建链三处独立证据：Xcode 工程 `Copy Rime plugins` phase 把三个 dylib 以 CodeSignOnCopy 拷入 `Contents/Frameworks/rime-plugins/`；`Makefile` 的 `copy-rime-binaries` 额外 `cp -pR $(RIME_LIB_DIR)/rime-plugins lib/`；`package/add_data_files` 动态把 `lib/rime-plugins/*` 逐个注册进 pbxproj（含 CodeSignOnCopy）。`package/make_package` 用 `pkgbuild --root …/Release` 把整 app 原样打进 `Squirrel.pkg`。
2. **由 librime 官方 release CI 构建产出（33e7814 = 1.17.0）**：Squirrel 自己的 CI 不构建 librime——`action-install.sh` 下载 librime 1.17.0 官方资产 `rime-33e7814-macOS-universal.tar.bz2` 并 `make copy-rime-binaries` 搬运；该资产由 librime 的 `release-ci.yml` → `macos-build.yml` 流水线产出，插件集由 workflow 输入显式指定为 `hchunhui/librime-lua lotem/librime-octagram rime/librime-predict`（与 pbxproj 静态引用的三个 dylib 一一对应）。本地开发者路径（`make librime` → `librime release` target）同样是独立插件 dylib 布局（`BUILD_MERGED_PLUGINS=OFF` + `ENABLE_EXTERNAL_PLUGINS=ON`）。
3. **签名**：xcodebuild 工程层无 `ENABLE_HARDENED_RUNTIME`；Hardened Runtime 由发行脚本 `package/sign_app` 的 `codesign --deep --force --options runtime --timestamp --sign "Developer ID Application: …" --entitlements resources/Squirrel.entitlements` 显式启用；pkg 随后 `productsign`（Developer ID Installer）→ `notarytool submit --wait` → `stapler staple`。entitlements（1.1.2 与 master 逐字节相同）含 `com.apple.security.cs.disable-library-validation = true`。
4. 「用户替换 dylib 后重签并被系统接受」：**文档证实**的条件是——替换后必须对整个 app 重新执行同等级签名（`codesign --options runtime --entitlements …`，被替换 dylib 也要有效签名）并重新公证，因为 bundle 内文件改动会破坏既有 seal，且 Hardened Runtime 下库校验被 disable-library-validation 放行的前提是替换 dylib 自身签名可接受；**未实测**的是真实系统（AMFI/Gatekeeper/输入法加载路径）对重签后输入法的实际接受行为（U-macOS-4）。注意 disable-library-validation 放行的是「非同 Team 签名库」，无签名库在 Hardened Runtime 下仍会被拒。

**依据**

- Squirrel @ master · Squirrel.xcodeproj/project.pbxproj:104-116（Copy Rime plugins，dstSubfolderSpec=10=Frameworks，三 dylib CodeSignOnCopy；buildPhases 顺序 L531-539 含该 phase）· URL 同 Q3。
- Squirrel @ master · Makefile:44-46,48-54 · https://raw.githubusercontent.com/rime/squirrel/0cd71a6130a5866b0ae6ba0494929ebdc8211194/Makefile

```make
librime:                    # L44-46（本地开发者路径）
	$(MAKE) -C librime release install
	$(MAKE) copy-rime-binaries
copy-rime-binaries:         # L48-54
	cp -L $(RIME_LIB_DIR)/$(RIME_LIBRARY_FILE_NAME) lib/      # L49 librime.1.dylib
	cp -pR $(RIME_LIB_DIR)/rime-plugins lib/                  # L50 插件目录
```

- Squirrel @ master · package/add_data_files:57-63,130-154 · https://raw.githubusercontent.com/rime/squirrel/0cd71a6130a5866b0ae6ba0494929ebdc8211194/package/add_data_files —— lib_entry 含 phase 名 "Copy Rime plugins" 与 `ATTRIBUTES = (CodeSignOnCopy, )`；lib_ref_entry `path = "lib/rime-plugins/$3"`；L130-132 `for file in lib/rime-plugins/*` 逐个动态注册。
- Squirrel @ master · package/make_package · https://raw.githubusercontent.com/rime/squirrel/0cd71a6130a5866b0ae6ba0494929ebdc8211194/package/make_package —— `pkgbuild --root "$DERIVED_DATA_PATH/Build/Products/Release" … --identifier im.rime.inputmethod.Squirrel --install-location "/Library/Input Methods" --scripts scripts` → `productbuild` 出 Squirrel.pkg（整 app 原样进包）。
- **Squirrel CI 不构建 librime**：Squirrel @ master · action-install.sh:5-13,30,35 · https://raw.githubusercontent.com/rime/squirrel/0cd71a6130a5866b0ae6ba0494929ebdc8211194/action-install.sh

```bash
rime_version=1.17.0
rime_git_hash="33e7814"
rime_archive="rime-${rime_git_hash}-macOS-universal.tar.bz2"
rime_download_url="https://github.com/rime/librime/releases/download/${rime_version}/${rime_archive}"
…
cp -R download/dist librime/                       # L30
# skip building librime and opencc-data; use downloaded artifacts
make copy-rime-binaries copy-opencc-data           # L35
```

  注：action-install.sh 原文 L9-10 使用 `${rime_git_hash}`/`${rime_version}` 变量插值，上文已还原为实际值。
- 该资产存在且由 librime release CI 产出：librime 1.17.0 release assets 实查（gh api，2026-10）含 `rime-33e7814-macOS-universal.tar.bz2`；librime @ 33e7814 · .github/workflows/release-ci.yml:15-18 · https://raw.githubusercontent.com/rime/librime/33e78140250125871856cdc5b42ddc6a5fcd3cd4/.github/workflows/release-ci.yml

```yaml
  macos:
    uses: ./.github/workflows/macos-build.yml
    with:
      rime_plugins: hchunhui/librime-lua lotem/librime-octagram rime/librime-predict
```

  librime @ 33e7814 · .github/workflows/macos-build.yml:9-11,28,68-69,74-79 · https://raw.githubusercontent.com/rime/librime/33e78140250125871856cdc5b42ddc6a5fcd3cd4/.github/workflows/macos-build.yml —— L28 `RIME_PLUGINS: ${{ inputs.rime_plugins }}`；L68-69 `./action-install-plugins-macos.sh`（把插件源码经 install-plugins.sh 克隆进 librime/plugins/，CMake `file(GLOB)` 发现后以独立 dylib 输出）；L74-79 `make install` 后 `tar -cjvf rime-$(git_ref_name)-macOS-universal.tar.bz2 dist …`。同一 submodule 指针：Squirrel @ master tree 中 librime submodule = `33e78140250125871856cdc5b42ddc6a5fcd3cd4`。
  残余缺口：librime CI 内部 `make test/install` 所驱动的 CMake 配置标志未逐行核（U-macOS-6）；但产物为「独立 rime-plugins dylib」布局由 Squirrel 端消费链（pbxproj 三 dylib + add_data_files 扫 `lib/rime-plugins/*` + Makefile L50）反证。
- librime @ 33e7814 · Makefile:74-79 · https://raw.githubusercontent.com/rime/librime/33e78140250125871856cdc5b42ddc6a5fcd3cd4/Makefile —— release target 显式 `-DBUILD_MERGED_PLUGINS=OFF -DENABLE_EXTERNAL_PLUGINS=ON`（本地开发者路径产出同样的独立插件布局）。
- 签名与公证：Squirrel @ master · package/sign_app:9-11 · https://raw.githubusercontent.com/rime/squirrel/0cd71a6130a5866b0ae6ba0494929ebdc8211194/package/sign_app

```bash
codesign --deep --force --options runtime --timestamp \
  --sign "Developer ID Application: …" --entitlements resources/Squirrel.entitlements --verbose "$appDir"
spctl -a -vv "$appDir"
```

  Squirrel @ master · Makefile:140-151 —— `bash package/sign_app` → `bash package/make_package` → `productsign --sign "Developer ID Installer: …"` → `xcrun notarytool submit package/Squirrel.pkg --keychain-profile … --wait` → `xcrun stapler staple package/Squirrel.pkg`。
  pbxproj 无 ENABLE_HARDENED_RUNTIME（grep 全文零命中）；L664-665/L719-720 `MACOSX_DEPLOYMENT_TARGET = 13.0`、`OTHER_CODE_SIGN_FLAGS = "--deep"`；L635/L692 `CODE_SIGN_ENTITLEMENTS = resources/Squirrel.entitlements`。
- entitlements 全文（1.1.2 与 master 逐字节相同，366B）：Squirrel @ 1.1.2 · resources/Squirrel.entitlements · https://raw.githubusercontent.com/rime/squirrel/1.1.2/resources/Squirrel.entitlements

```xml
<key>com.apple.security.cs.disable-library-validation</key><true/>
<key>com.apple.security.app-sandbox</key><false/>
<key>com.apple.security.network.client</key><true/>
```

- Apple 官方文档 URL（实测可达性标注）：Hardened Runtime 总览 https://developer.apple.com/documentation/security/hardened-runtime （HTTP 200，SPA 壳）；公证总览 https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution （search 命中）。未定位到「输入法专用签名/公证要求」独立官方页（U-macOS-7）。

---

## 判定① 用户目录 Lua（librime-lua `Context:set_property`）能否独立触发 Squirrel 刷新候选窗

**master：能（链条逐环闭环）。**

1. Lua 绑定：librime-lua @ master · src/types.cc:828 → `{ "set_property", WRAPMEM(T::set_property) }`（methods 表 L802-832 属 `ContextReg`，T=Context 由 L830 `clear_transient_options = WRAPMEM(T::ClearTransientOptions)` 与 context.cc `Context::ClearTransientOptions` 唯一对应锚定）· https://raw.githubusercontent.com/rime/lua/… （实抓 librime-lua master types.cc）。
2. Context 无条件通知：librime @ 33e7814 · src/rime/context.cc:300-303（引文见 Q2）——`set_property` 每调用必发 `property_update_notifier_`。
3. 引擎转消息：librime @ 33e7814 · src/rime/engine.cc:82-85（构造时 `property_update_notifier().connect(…OnPropertyUpdate)`）→ 144-152 `message_sink_("property", msg)`，msg = `"_refresh_ui=" + value`。
4. 前端认领：Squirrel @ master · sources/SquirrelApplicationDelegate.swift:316-327（引文见 Q1）——`messageType == "property"` 且首字符 `_` → `handleReservedProperty(key:value:for:sessionId)`。
5. 键解析：Squirrel @ master · sources/ReservedProperty.swift:14 → `case refreshUI = "_refresh_ui"`。
6. 会话守卫与分发：Squirrel @ master · sources/SquirrelInputController.swift:294-306 —— `guard session == sessionId, session != 0, rimeAPI.find_session(session) else { return }` → `case .refreshUI: rimeUpdate(clearReservedComments: false)`。
7. 刷新生效：同文件 L447 起的 `rimeUpdate(clearReservedComments:)`：L447 注释 "Preserve reserved comment marks when librime requests a UI-only refresh."，随后 rimeConsumeCommittedText → get_status（schema 变更则 loadSettings）→ get_context → show/showPanel，重绘候选窗。
   前提标注：Lua 组件运行于活动会话的 engine，通知携带该 session id，与步骤 6 的 `session == sessionId` 守卫匹配；librime service 层 session↔engine↔message_sink 的绑定路径未逐行核（U-macOS-3）。

**1.1.2：不能。** 通知处理器无 `property` 分支（sources/SquirrelApplicationDelegate.swift:238-281），且 L257 `enableNotifications` gate 会拦截 deploy 之外的全部消息；InputController 无 handleReservedProperty，`rimeUpdate()` 只由用户动作调用（引文见 Q1）。Lua 侧 `set_property("_refresh_ui", …)` 在 1.1.2 上只是一次静默写入。

## 判定② `_` 前缀属性存活边界与「每轮重设」是否足够

- **存活边界**：`_` 前缀键只在一处被擦除——`Context::ClearTransientOptions()`（context.cc:313-325），其唯一调用点是 `ApplySchema`（engine.cc:289），即**仅切换输入方案时**擦除；`Context::Clear()`（engine.cc:288，每次上屏/清空输入）不碰 `properties_`；无其他擦除点。
- **通知语义**：`set_property` 每调用必发通知（context.cc:300-303 无条件），不存在「值相同则不发」。
- **空串例外**：`set_property("_refresh_ui", "")` **不触发**——`ReservedPropertyValue.parse` 对空串 `throw .emptyInput`（Squirrel @ 0cd71a61 · sources/ReservedProperty.swift:25），`handleReservedProperty` :297 `try parse` 随之抛出；refreshUI 分支（:303-304）不消费解析出的 value，故除空串外**任意非空值都触发**。也不能借空串实现「只清保留注释不刷新」。
- **前端只消费载荷**：Squirrel master 用消息串里的 key/value，不回读 Context（引文见 Q1/Q2）。
- **可操作结论**：想要刷新，在任意时刻调用一次 `Context:set_property("_refresh_ui", "1")` 即可——不需要为「保活」而每轮重设（每次调用本身就触发一次刷新）；属性是否存活对触发无影响。真正要留意的是反向依赖：若 Lua 组件把 `_` 前缀属性当跨调用状态存储，切换 schema 会把它擦掉——跨 schema 状态请用非 `_` 前缀属性（不进前端协议、不会被 ClearTransientOptions 擦除）或 Lua 侧自持状态；`_` 前缀命名空间保留给前端协议使用。

---

## macOS 三分类修正

三项能力：(a) 真实编辑器上文；(b) 无按键异步刷新候选窗；(c) 菜单唤起设置页。

| 形态 \ 能力 | (a) 真实编辑器上文 | (b) 无按键异步刷新 | (c) 菜单设置页 |
|---|---|---|---|
| 普通未修改前端 = 官方 1.1.2（最新正式发行） | 不可得：client(IMKTextInput) 只在控制器侧，librime 无桥（Q3） | **不可得**：无 property 分支、无 handleReservedProperty，rimeUpdate 全部用户动作驱动（Q1/判定①） | 不可得：无引擎→菜单通道（map#1） |
| 普通未修改前端 = master/Nightly | 不可得（同上） | **受限可得**：librime 插件或用户目录 Lua（经 librime-lua 组件）可在非按键时机 `set_property("_refresh_ui")` 触发面板重绘（判定①链条）；但预测内容仍须经 librime 上下文，非任意前端注入 | 不可得（同上） |
| 附加扩展（引擎侧纯 Lua + 进程外伴随进程，前端不改） | 不可得（同上） | 官方 1.1.2 前提下不可得——异步预测只能滞后到下一次按键（map#1）；前端为 master/Nightly 时可叠加 `_refresh_ui` 获得受限 (b) | 不可得（同上） |
| 定制构建（分叉 Squirrel.app 源码，GPL-3） | 可得：在控制器侧读 client 的 attributedSubstring 再经新增桥/IPC 传引擎（Q3 指明改动点） | 可得：直接复用 master 的 `_refresh_ui` 通道（Q1） | 可得：新增菜单项 + 通知（map#1） |

与 map#1 决策记录的差异仅一处：macOS「普通未修改前端」行按 master 证据拆分为 1.1.2（全不可得）与 master/Nightly（受限 (b)）。

---

## 增量未知项（自 U-macOS-3 起）

| 编号 | 内容 | 状态/边界 |
|---|---|---|
| U-macOS-3 | librime service 层 session↔engine↔notification 的绑定路径未逐行核（判定①第 6 环 `session == sessionId` 守卫的前提） | 静态可核，未核 |
| U-macOS-4 | 用户向已安装（公证+stapled）的 Squirrel.app `Contents/Frameworks/rime-plugins/` 替换/新增 dylib 的实际系统接受行为（文件权限、code seal 破坏、AMFI/Gatekeeper、输入法加载路径） | 本票禁实测；文档级成功条件见 Q4 结论 4 |
| U-macOS-5 | 「ObjC runtime 遍历定位 IMKInputController 实例并取 client」从 librime 插件侧实施的可能性 | 未验证、脆弱；本票禁实测 |
| U-macOS-6 | librime CI `make test/install` 内部的 CMake 配置标志（`BUILD_MERGED_PLUGINS` 终值）未逐行核 | 由产物布局（独立 rime-plugins dylib）与 Squirrel 消费链反证为 OFF；静态可核，未核 |
| U-macOS-7 | `IMKTextInput.attributedSubstring(from:)` 当前官方文档 URL（多 slug 实抓 404）与「输入法专用签名/公证要求」独立官方页 | 未定位；API 归属为公开事实但引用页未验证 |
| U-macOS-8 | Nightly（2026-08-13 prerelease）对应的确切 master 基线 commit | **已实证（补遗#3）**：release-ci.yml:58-59 nightly 仅在 `refs/heads/master` 触发；compare `e9723977…0cd71a61` ahead_by=11 / behind_by=0 → merge commit 是 master tip 祖先，含 #1143 |
---

## 补遗：重复研究员回报的增量发现（2026-10-06 复核并入）

本票研究期间有两位并行研究员；第二位（重派）的完整版本晚于本报告入库并覆盖了工作树。两版本核心判定一致；其增量发现经主理人逐条第一方实抓复核（下述引文均为复核时实抓，非转述），并入如下。其原版全文存档于 `.scratch/1f34ad3f-worktree-versions/`（gitignored，不入库）。

1. **空串值是唯一「写了也不触发」的形态**（已并入判定②）：Squirrel @ 0cd71a61 · sources/ReservedProperty.swift:24-25 —— `static func parse(_ raw: String) throws(ReservedPropertyError)` 首行 `guard !raw.isEmpty else { throw .emptyInput }`；SquirrelInputController.swift:297 `try ReservedPropertyValue.parse(rawValue)` 使异常传播出 handler → 不刷新。操作约束：`set_property("_refresh_ui", …)` 的 value 必须**非空**。
2. **`Context::Clear` 不动 `properties_` 的原文锚**（补判定②存活边界的证据强度）：上游 @ 33e7814 · src/rime/context.cc:106-111 —— 只清 `input_`/`caret_pos_`/`composition_`（:110 `update_notifier_(this)`，非 property 通知通道）。「`_` 属性全清」语义完全来自 `ClearTransientOptions`（:313-325；:315-319 清 `options_`、:320-324 清 `properties_`，各自自 `lower_bound("_")` 起 erase；日志行 :317 `cleared opption` 拼写为原文实录）。
3. **Nightly 构建自 master 实证**（U-macOS-8 收窄，见未知项表）：Squirrel @ 0cd71a61 · .github/workflows/release-ci.yml:58-59 `if: ${{ github.repository == 'rime/squirrel' && github.ref == 'refs/heads/master' }}`、:65 `title: "Nightly build"`；gh api compare `e9723977efc7456f…0cd71a61` → `{status: "ahead", ahead_by: 11, behind_by: 0}` → #1143 的 merge commit 是 master tip（Nightly 构建源）的祖先。
4. **插件 loader 编入 librime.1.dylib**（补 Q3/Q4 运行期发现机制）：上游 @ 33e7814 · CMakeLists.txt:24 `option(BUILD_SEPARATE_LIBS "Build separate rime-* libraries" OFF)` → `current_module_path()`（plugins/plugins_module.cc:115-119，`dladdr(&rime_require_module_plugins)`）解析到主 dylib 自身路径 → 插件目录 = **librime.1.dylib 所在目录** + `rime-plugins`（CMakeLists.txt:34）→ 官方 app 的 `Contents/Frameworks/rime-plugins/` 无需任何配置即被自动发现。
5. **新增 U-macOS-9**：`set_property` 无同值去重（判定②）+ 前端无幂等短路（handleReservedProperty :294-306 无值比较）→ **每次调用都触发一次完整重绘**（rimeUpdate → panel.update）；Lua 侧高频/循环调用的性能影响未实测。