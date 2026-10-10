# fork Release 模板（weasel 0.17.4-predict.N）

本模板用于 fork 仓库 CometDash77/weasel 的 GitHub Release 正文。发布时把 `{{ }}` 占位符填成实际值，删除不适用的注释行；`{{PREDICT_CHANGES}}` 段在 S2–S4 落地后由对应能力票提供正文，首发前保留骨架。

版本号格式冻结为 `0.17.4-predict.N`（N 从 1 起单调递增）。安装器文件名携带 predict 后缀；NSIS 元数据 `VIProductVersion` 受四段纯数字约束（install.nsi:30），保持上游 `0.17.4.N` 数字格式，predict 后缀通过 `PRODUCT_VERSION` 注入文件名与 exe 元数据字符串（fork build.bat 在 `RELEASE_BUILD` 下单独追加 `-predict.N`，`WEASEL_VERSION` 本身保持纯数字）。

---

## 小狼毫（Weasel）模型预测版 0.17.4-predict.{{N}}

### 下载

- 安装器：`weasel-0.17.4-predict.{{N}}-installer.exe`（sha256：`{{INSTALLER_SHA256}}`）
- 调试符号：`debug_symbols.7z`（sha256：`{{DEBUG_SYMBOLS_SHA256}}`）

### 版本与上游基底

- 本发布基于 fork 分支 [`predict-0.17.4`](https://github.com/CometDash77/weasel/tree/predict-0.17.4)，发布 tag：`predict-0.17.4.{{N}}`
- 上游基底：[rime/weasel 0.17.4](https://github.com/rime/weasel/releases/tag/0.17.4)（2025-06-04），release commit `9cc96e20dc71b80876b12f689bb5863c76c2a7ed`
- librime：随上游 0.17.4 的子模块指针 `1c23358157934bd6e6d6981f0c0164f05393b497`（即 librime 1.13.1 release），构建时使用 librime 1.13.1 官方预编译包，fork 对 librime 零改动
- 版本追溯：上游 tag `0.17.4` → 上游 release commit `9cc96e2` → fork `predict-0.17.4` 分支 → 发布 tag `predict-0.17.4.{{N}}`；构建时 `RELEASE_BUILD=1` 注入 `PRODUCT_VERSION=0.17.4-predict.{{N}}`

### 相对上游的四项改动

{{PREDICT_CHANGES}}

骨架（S2–S4 各自落地后替换为实际说明，含对应 commit 链接）：

1. TSF 读取编辑器上文（≤300 Unicode 标量，ok / unavailable / protected，可确认的空上文不是 unavailable）——S2
2. IPC 扩展两命令 + 私有窗口 `WeaselIPCWindow_1.0` 完成通知（COPYDATA `0x52504D31`，x64 COPYDATASTRUCT 24 字节）——S3
3. option 翻转迫使 librime 重组（不依赖按键刷新）+ 右键菜单唤起本地网页设置页——S3/S4

### 隐私与数据边界

- 插件不持久化正文、拼音或模型回答；预测通道按需启动 sidecar，空闲自动退出。
- 云端通道显式 opt-in，默认关闭；凭据只存于设置槽位，不进入日志与发布产物。

### 支持矩阵

- 首发：Windows 10 x64、Windows 11 x64，x64-only，全拼。
- 不声明更老系统或非 x64 环境的支持；ARM64X 组件随上游链构建但不在首发支持声明内。

### GPL-3 源码义务

- 本发布包含 GPL-3.0 授权的小狼毫（Weasel）衍生作品，依据 GPL-3 提供完整对应源码：
  - fork 源码 tag：`https://github.com/CometDash77/weasel/archive/refs/tags/predict-0.17.4.{{N}}.tar.gz`（zip 同路径 `.zip`）
  - librime 子模块：`https://github.com/rime/librime`（commit `1c23358157934bd6e6d6981f0c0164f05393b497`，未修改）
  - 本仓库组件（Lua 滤镜、sidecar、安装计划、协议契约）：`https://github.com/CometDash77/RIME-PredictInput` tag `{{MAIN_REPO_TAG}}`
- 构建链与 sha256 清单：见主仓库 `docs/fork/build-and-release.md`。

### 校验

发布前核对：安装器与调试符号 sha256 与 `docs/fork/build-and-release.md` 清单一致；安装器版本属性（ProductVersion 字符串）显示 `0.17.4-predict.{{N}}`；fork tag 与源码包可从 Release 页直接访问。
