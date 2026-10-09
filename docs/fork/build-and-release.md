# fork 构建链复现记录（weasel 0.17.4-predict.N）

本文记录 fork 安装器从源码到 `output\archives\weasel-0.17.4-predict.N-installer.exe` 的完整复现链。目标：任何人在 Win10/11 x64 前置条件齐备时，按本文步骤得到与发布产物逐字节等价的构建结果，并可核对 sha256 清单。上游基底 rime/weasel 0.17.4（release commit `9cc96e20dc71b80876b12f689bb5863c76c2a7ed`）。

## 1. 上游官方构建链（对照基准）

上游 release-ci.yml（0.17.4 tag 触发，windows-2019 runner）步骤顺序：

1. checkout（submodules: true, depth 0）
2. `cp env.vs2019.bat env.bat`
3. `install_boost.bat`（boost 1.84.0，`BOOST_ROOT=%WORKSPACE%\deps\boost_1_84_0` 覆盖 env.vs2019.bat 默认 1.78.0；内含 `call build.bat boost` 无参 = x86+x64）
4. `build.bat boost arm64`（补 ARM32+ARM64 boost）
5. setup-msbuild
6. `get-rime.ps1 -use dev`（latest librime；0.17.4 发布时为 1.13.1）
7. `build.bat data`（plum 拉默认配方 essay 等到 output\data）
8. `RELEASE_BUILD=1 build.bat arm64 installer`（tag 触发）
9. `output\7z.exe a debug_symbols.7z` 打包符号
10. `gh release create --draft`（files: output/archives/weasel*.exe + debug_symbols.7z）

## 2. 前置条件（首发矩阵：Win10 x64 + Win11 x64）

- Windows 10 x64 或 Windows 11 x64 构建机（本记录在 Windows 11 专业版 build 26200 上验证）
- Visual Studio 2019 BuildTools 16.11.37507.1，MSVC 14.29.30133（v142），Windows SDK 10.0.19041.0
- VS 组件：VC.Tools.x86.x64、VC.ATL（x86/x64）、VC.MFC（x86/x64，`.rc` 编译需 `afxres.h`）、VC.Tools.ARM/ARM64 + VC.ATL.ARM/ARM64 + VC.MFC.ARM/ARM64（ARM64X wrapper 与 ARM 产物用）
- NSIS 3.10 portable（本记录使用 `D:\VibeCoding\tools\nsis-3.10`）。警告：系统安装的 NSIS 3.08 自带的 winVer.nsh 缺 `WINVER_11`/`AtLeastWin11` define（WINVER 只到 10），编译 install.nsi:128 `${If} ${AtLeastWin11}` 报 `macro "_If" requires 4 parameter(s), passed 2`；换 3.10 后同一脚本直接通过
- Git（含 Git Bash）+ plum 子模块
- 代理访问 GitHub（下载 librime 预编译包与 plum 配方）

## 3. 本地复现步骤

以下步骤均已在本机实际执行并验证。

1. `git clone -b predict-0.17.4 --single-branch https://github.com/CometDash77/weasel`（上游基底 9cc96e2 + fork 版本注入 commit afef67a）
2. `git submodule update --init --depth 1 plum`（librime 子模块不拉：构建用预编译包，fork 零改动）
3. `copy env.vs2019.bat env.bat`
4. boost 1.84.0.7z 解压到 `deps\boost_1_84_0`；`set BOOST_ROOT=%CD%\deps\boost_1_84_0`；`build.bat boost arm64`（x86/x64/ARM/ARM64；`--with-filesystem,json,locale,regex,serialization,system,thread`，`BOOST_USE_WINAPI_VERSION=0x0603`(x86/x64)/`0x0A00`(arm)，toolset msvc-14.2，static/static，--build-type=complete）
5. `get-rime.ps1 -tag 1.13.1 -use dev`（代理写入 `%UserProfile%\.get-rime.conf.ps1`；下载四包、解压、按 dev 映射复制 rime.lib/rime.dll/opencc 到 lib,lib64,output,output\Win32,output\data\opencc）
6. `build.bat data`（copy LICENSE.txt/README.txt/rime-install.bat + plum 拉默认配方 7 包 29 文件）
7. `set BOOST_ROOT=%CD%\deps\boost_1_84_0` + msbuild 加入 PATH；`build.bat arm64 installer`（或 CI 等价 `RELEASE_BUILD=1`）
8. NSIS 打包（仓库根目录执行，产物落在 `output\archives\`）：`makensis /DWEASEL_VERSION=0.17.4 /DWEASEL_BUILD=1 /DPRODUCT_VERSION=0.17.4-predict.1 output\install.nsi`；`data\*.gram -> no files found` 为 `/nonfatal` 预期警告（语法模型属 octagram 第三方插件，上游官方产物同样不含）
9. `output\7z.exe a -t7z ./output/archives/debug_symbols.7z "output/*.pdb" -r`（仓库根目录执行，与上游 CI 逐字等价；11 个 pdb）

## 4. 版本注入（fork 独有，AC2）

fork commit `afef67a`（build(version): append -predict.N suffix to release PRODUCT_VERSION）在 build.bat 第 20 行后追加：

```bat
if defined RELEASE_BUILD set PRODUCT_VERSION=%WEASEL_VERSION%-predict.%WEASEL_BUILD%
```

- `WEASEL_VERSION` 保持纯数字 `0.17.4`（NSIS `VIProductVersion` 四段纯数字硬约束，install.nsi:30）
- 发版时 `set RELEASE_BUILD=1 && set WEASEL_BUILD=N`，产物文件名 `weasel-0.17.4-predict.N-installer.exe`，exe ProductVersion 字符串 `0.17.4-predict.N`，NSIS DisplayVersion `0.17.4.N`
- 非 RELEASE_BUILD 本地验证构建不受影响（PRODUCT_VERSION 带 short hash）
- 追溯链：上游 tag `0.17.4` → release commit `9cc96e2` → fork `predict-0.17.4` 分支（afef67a + 能力 commit）→ 发布 tag `predict-0.17.4.N`

## 5. librime 零改动边界（AC5 实证）

- fork `predict-0.17.4` 分支的 librime 子模块指针与上游 0.17.4 完全一致：`1c23358157934bd6e6d6981f0c0164f05393b497`（librime 1.13.1）
- 构建使用 librime 1.13.1 官方 Windows msvc 预编译包（rime + rime-deps，x86/x64 四包），不修改、不重编 librime
- 预编译包 sha256 见下方清单

## 6. sha256 清单

### boost 1.84.0（install_boost.bat 下载源 archives.boost.io）

| 文件 | 字节数 | sha256 |
|---|---|---|
| boost_1_84_0.7z | 106270426 | 81a4d10075731966477276c47324ecd9cac02da49899d36c48eba66e40014f25 |

### librime 1.13.1 预编译包（rime-1c23358-Windows-msvc）

| 文件 | 字节数 | sha256 |
|---|---|---|
| rime-1c23358-Windows-msvc-x64.7z | 7220342 | 05fcf8cc2d058a0186dd9f04d6e021ad41687db50dc81e85cf655dfabfdf0009 |
| rime-1c23358-Windows-msvc-x86.7z | 6947305 | 22cb6288a5b30fd47e63ea56a5e0620c7198dbb178570da148cc33e4b589147f |
| rime-deps-1c23358-Windows-msvc-x64.7z | 3574853 | 3ede059e6c1f4cdd5843ced3205f76666b706e5f55ccf8e56e2d04791a376ff6 |
| rime-deps-1c23358-Windows-msvc-x86.7z | 2950758 | 17688b5f75216b2fb11fb352bd9f97007650e1bc36b343def98fa9f0677bc0c9 |

### 发布产物

| 文件 | 字节数 | sha256 |
|---|---|---|
| weasel-0.17.4-predict.1-installer.exe | 12673125 | adbe9afa3a41a53601364ccad89e35c75aeb768428246a6ffeb3fb9d94ed0b05 |
| debug_symbols.7z | 32115432 | 0f295e7a10b0936faa2b29786382194f81db02611e776ec8eb6af38b8c3fa483 |

> predict.1 实测（2026-10-09，本机构建）：安装器 141 个内容条目，双架构组件套件完整（weasel.dll / weasel.ime / WeaselServer.exe / WeaselDeployer.exe / WinSparkle.dll 各有 ARM64+AMD64 两份；rime.dll 时间戳 2025-02-16 = librime 1.13.1 预编译包原封，AC5 零改动佐证）；exe 版本资源 ProductName=小狼毫、FileVersion=0.17.4、FileDescription=小狼毫輸入法。下一发版（predict.2 起）重跑 §3 步骤 8-9 后回填新行即可。

## 7. 支持矩阵声明

首发：Windows 10 x64、Windows 11 x64；x64-only；全拼。不声明更老系统或非 x64 环境支持。ARM64X 组件随上游链构建（非首发支持范围）。
