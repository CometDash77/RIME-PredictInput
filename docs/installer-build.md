# S9 安装器构建

正式输入是 `CometDash77/weasel` 的 stable `0.17.4-predict.N` release。当前尚无发布输入；本地工程候选不能作为正式安装器。安装器面向已装官方 Weasel 0.17.4 的 Windows x64 账户，保留官方共享 data；同账户管理员提升。custom 不改动，接入与恢复说明在 `assets/installer/`。

工具：Node >=22.6、pnpm 锁定依赖、GitHub CLI（构建 provenance 查询）、NSIS 3.10 portable、7-Zip 24.05、MSVC v142 14.29.30133 / Windows SDK 10.0.19041.0。摘要和来源在 `tools/installer/toolchain.json`；传入本机工具路径，不依赖作者目录。NSIS 使用 zlib；完整许可证随包。

```powershell
pnpm install --frozen-lockfile
pnpm verify
pnpm build:exe
pnpm release:stage
pnpm release:check -- --tag v0.1.0

# release archive 单独获得；pin 不下载二进制、不发布 release。
pnpm installer:pin-fork -- --tag predict-0.17.4.2 --archive C:/inputs/weasel-runtime.zip --sevenzip C:/tools/7z.exe --output build/fork.lock.json
pnpm build:installer -- --fork-lock build/fork.lock.json --fork-archive C:/inputs/weasel-runtime.zip --makensis C:/tools/nsis/makensis.exe --sevenzip C:/tools/7z.exe --vcvarsall C:/tools/VS/VC/Auxiliary/Build/vcvarsall.bat
```

tag/asset 名必须与实际 release 一致；以上路径仅示例。receipt 固定完整 commit、资产 id/URL、原始 archive 哈希及逐文件哈希；正式构建会再次查询 GitHub，伪造本地 receipt 无效。pin 白名单要求根目录含 weasel.dll、weaselx64.dll、WeaselSetup.exe、WeaselServer.exe、rime.dll、WeaselDeployer.exe、WinSparkle.dll、LICENSE.txt、README.txt、start_service.bat、stop_service.bat。这些编译输出及依赖必须来自 fork 声明的构建；不要把整个 fork 安装包或源码树直接塞入。

无正式 release 时可使用相同结构的本地 lock（`releaseVerified: false`），加 `--candidate` 验证打包。candidate 会在安装入口停止；不要用它测试真实安装。产物与 `manifest.json`、`build-report.json` 位于 `build/installer/`。工具摘要、载荷摘要或版本不匹配都停止；输出是唯一的新 stage，重跑不递归删除输入目录。这里的可复现指声明工具和固定输入可重复构建，不承诺 NSIS/Node 封装逐位相同。

安装/升级读取发起用户的 RIME 路径与官方 InstallDir，ProgramData 私有缓存保留离线载荷和失败重试入口。产品写入只执行 S8 操作，日志位于 ProgramData 的 `RimePredictInstaller/journal/operation.json`。成功卸载删除精确缓存文件，日志作为审计记录保留。旧版本缓存不自动递归清理，避免扩大删除范围。

自动验证涵盖完整离线载荷、版本/哈希/PE/导出错误、来源伪造、重复安装、中断补写、部分注册/旧注册、失败日志、custom/settings/模型保留及真实目录链接拒绝。设置页工程 smoke 使用隔离用户目录与临时进程。尚未执行真实 TSF 替换、UAC、ProgramData ACL、桌面闪窗或 Weasel 窗口互操作；这些归 #29 S11。公开发布必须同时满足 S10 合规 gate 和相应真机发布条件。
