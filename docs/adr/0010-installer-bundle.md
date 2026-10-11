# ADR 0010：NSIS 安装器与可追溯载荷

- 状态：实现已落地，正式 fork release 输入及 S11 真机验收待完成（#28，2026-10-11）。
- 决策：NSIS 3.10 Unicode，zlib 压缩；编译器、7-Zip、许可证摘要和 MSVC/SDK 版本见 `tools/installer/toolchain.json`。NSIS 能薄封装 UAC、内嵌文件与卸载入口，避免引入 MSI 的第二套安装状态；计划和用户数据策略继续由 S8 管理。构建入口见 `docs/installer-build.md`。

NSIS 先记录发起者的目录，再通过 `runas` 请求管理员提升；拒绝改用另一账户的管理员凭证。bootstrap 只管理 ProgramData 下的私有缓存、日志和卸载注册项。安装和卸载都在运行缓存程序前拒绝缓存及其祖先、后代的链接。真实 UAC、ACL 和窗口行为仍需 S11，编译成功不能证明这些事实。

`src/installer/runner.ts` 把完整校验后的清单映射到路径表，观察目标文件和两个 COM 注册视图，再调用 S8 的计划与执行器。日志先持久化计划和 keeps，执行后保存失败步骤；重试重新取快照。注册通过官方 `WeaselSetup.exe /s`，反注册通过 `/u`，沿用原 TSF CLSID；验证两个注册视图的实际文件摘要，不能用原生程序的零返回码代替结果。升级历史摘要留在私有日志中，便于卸载中断的旧版注册。

构建时用 GitHub 的已发布 stable release、tag commit、asset id、size 和 digest 复核本地 receipt；不能只信 `releaseVerified`。安装时完全离线，复核内嵌原始 archive 与每个落位文件的 SHA-256、版本、PE 类型/子系统、启动器导出。源码树、模型、用户配置禁止进入载荷。`--candidate` 仅供无正式 release 的工程验证，产物在入口拒绝安装，报告标为 `releaseReady: false`。

本包替换已安装的官方 Weasel 0.17.4，不分发词库；安装前检查程序根的 `data/default.yaml`，缺失即在改动前停止。共享 data 和用户 RIME 数据从不枚举或删除。手动退出 Weasel 和使用前端的应用后安装，完成后用户启动服务。卸载后用户重装官方版；没有声称提供无中断或自动回滚。

按用户在 #28 会话的明确选择，所有 custom 保持原样，仅安装四个 Lua 模块和启动器并提供手动接入/移除指引。这取代 ADR 0008 中由安装器枚举、追加 custom 补丁的描述。S8 前端路径修正为真实 `weaselx64.dll`，绝对 InstallDir 作为上级目录直接使用；fork 设置入口的默认子目录对齐 `predict`。

NSIS stub/plugins 的许可证随包放入 `NSIS-LICENSE.txt`。选 zlib 压缩而非 LZMA，完整工具许可证正文归档于 `docs/license/NSIS-3.10-LICENSE.txt`；Weasel GPL 组件及对应源码仍单独由 fork release 追溯，不纳入本仓库 MIT 许可。
