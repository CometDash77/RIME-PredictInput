# Release notes 模板（本仓库产物发布）

本模板用于 **CometDash77/RIME-PredictInput** 的 GitHub Release 正文（主仓库产物：sidecar 双变体 + 归档产物）。
fork 仓库 **CometDash77/weasel** 的 Release 正文用 `docs/fork/release-template.md`，两份一起阅读才是用户实际看到的全部信息。

发布时把 `{{ }}` 占位符填成实际值，删掉不适用的说明行。**每一节都不许删**：`pnpm release:check` 会按 `src/release/release-notes.ts` 的判据逐条核对（合并两份模板后），
少一节就挡下发布。判据为什么这么严：安装器与 sidecar 是同一个用户旅程的两半，一边写了源码义务、一边没写，用户看到的就是一份不完整声明。

---

## 本仓库产物发布 notes 骨架

### 产物与校验

| 产物 | 说明 | sha256 |
|---|---|---|
| `rime-predict-sidecar.exe` | sidecar 双变体之一：CUI 控制台子系统，便于排障与脚本调用 | `{{SIDECAR_CUI_SHA256}}` |
| `rime-predict-sidecar-gui.exe` | sidecar 双变体之二：GUI 子系统（无控制台窗口），安装器默认装入的这一份 | `{{SIDECAR_GUI_SHA256}}` |
| `LICENSE` | 本仓库自有代码许可证（MIT） | `{{LICENSE_SHA256}}` |
| `THIRD-PARTY-NOTICES.md` | 第三方许可证与版权声明（构建期生成） | `{{NOTICES_SHA256}}` |

- 变体差异只有一个 PE 子系统字节：同一份 CJS bundle、同一份 `@yao-pkg/pkg` 运行时；两者 `selftest` 报告与 `node dist/cli/main.js selftest` 逐字节一致（构建脚本内置冒烟）。
- 校验：`sha256sum` / `Get-FileHash -Algorithm SHA256` 对上面每一行；与 `dist/release/release-report.json` 的 `shipSet.digest` 交叉核对。

### 安装指引

- 前置：Windows 11 x64（首发支持矩阵见下），已按需安装官方小狼毫（Weasel）0.17.4。
- 步骤：运行 `weasel-0.17.4-predict.{{N}}-installer.exe` → 出现 UAC 提示并授权 → 安装完成后核对程序文件落位与用户接入点（Lua 滤镜、custom 补丁条目）就位 → 打开任意编辑器输入拼音，候选窗第 5 位在预测到达后出现。
- 安装器与 fork 安装包的对应关系见 `docs/fork/build-and-release.md`；安装路径表见 `docs/adr/0008-install-path-table.md`。

### 卸载指引

- 步骤：从「应用和功能」或安装器自带卸载项启动卸载 → 反注册 TSF 组件 → 校验并终止 sidecar（先按 pid 与进程映像比对，不匹配就提示手动退出）→ 删除程序文件与用户接入项 → 清空瞬态文件与 `diagnostics.log` → 卸载完成。
- 卸载后普通输入必须仍可用（回到官方 Weasel 形态），且不留自有残留进程。
- `settings.json` 与已下载的共享模型**保留**，重装无需重新配置、模型零重下。

### 手动全清指引（卸载后仍想彻底清干净）

卸载器只清自有文件与接入项；下列内容按需手动删除（**删之前确认你知道代价**：删掉就要重新配置、重新拉模型）：

1. `%USERPROFILE%\.rime-model-predict\`（设置、状态、瞬态请求/响应、`diagnostics.log`）——即「手动全清」的全部自有用户数据；
2. 程序目录下的 `predict\` 子目录（若卸载未残留）；
3. RIME 用户目录里的接入项：`lua\model_predict_*.lua` 与 custom 文件中的预测补丁条目。

**不动的**：方案、词库、`userdb`、已下载的共享模型文件——这些不属于本产物，删了会影响其它输入法功能。

### 还原指引

- 想回到安装前的状态：卸载本产物（见上）后，用官方 Weasel 0.17.4 安装包重新安装/修复一次，即回到官方 Weasel。
- 想保留设置回到官方：卸载后 `settings.json` 仍在，重新安装本产物即自动恢复；不想保留就按「手动全清」第 1 条删除。
- 还原后普通输入行为与官方 Weasel 一致；本产物不修改方案、词库与用户数据，因此不需要额外还原动作。

### 隐私声明

- 本产物**不持久化**正文、拼音或模型回答；预测通道按需启动 sidecar，空闲 60 秒自动退出。
- 诊断日志默认只写**元数据码**（事件、状态、耗时），永不写用户正文、候选或模型回答；日志可关闭（`log_mode: "off"`）。
- 云端通道显式 opt-in、**默认关闭**：关闭态零出站。开启时设置页明示披露「正文、拼音、候选会发往所配服务商」。
- 云端凭据只存于约定设置槽位 `cloud.api_key`，不进入日志、不进 IPC 完成通知、不进发布产物（发布前由 `pnpm release:check` 的凭据扫描复核）。
- 更新检查只在设置页会话内发起匿名 GET（固定 URL、静态 UA、无 body），失败静默，绝不自动下载。

### 支持矩阵

- 首发支持：**Windows 10 x64**、**Windows 11 x64**；x64-only；全拼。
- 不声明更老系统、ARM64 或非 x64 环境的支持；ARM64X 组件随上游链构建，但不计入首发支持范围。

### 源码

- 本仓库组件（Lua 滤镜、sidecar、安装计划、协议契约）：`https://github.com/CometDash77/RIME-PredictInput` tag `{{MAIN_REPO_TAG}}`（源码包 `{{MAIN_REPO_SOURCE_ARCHIVE}}`）。
- 本仓库自有代码按 **MIT** 授权（`LICENSE`）；随产物分发的第三方组件见 `THIRD-PARTY-NOTICES.md`。
- 内嵌的小狼毫（Weasel）衍生作品按 **GPL-3.0-only** 处理，对应源码与义务清单见 fork Release notes（`docs/fork/release-template.md` 的「GPL-3 源码义务」段）。

### 发布前校验

1. `pnpm verify` 全绿（测试条数以当次输出为准）。
2. `pnpm release:notices -- --write` 刷新 `THIRD-PARTY-NOTICES.md`；`pnpm release:stage` 把 `LICENSE` 与声明放进 `dist/release/`。
3. `pnpm release:check -- --tag {{MAIN_REPO_TAG}}` 必须 `PASS`（任何一条失败即不许发布），报告归档在 `dist/release/release-report.json`。
