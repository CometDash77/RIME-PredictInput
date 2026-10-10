# fork 侧完成通知接收契约（S3，issue #22）

本文是完成通知通道的**接收端**逐字段契约：sidecar 发、WeaselServer（fork）收。
发送端契约见 `docs/adr/0001-completion-notify-port.md` 与
`src/runtime/completion-notify.ts`（含 koffi 发送实现）。本文同时记录 fork 实现
落点、身份门控的属性通道、重组触发机制与测试运行步骤。

## 渠道与方向

```
sidecar（本仓库 TS） ──WM_COPYDATA──▶ WeaselServer 私有 IPC 窗口（fork）
   找窗：EnumWindows + GetClassNameW 枚举式匹配窗口类
```

- 方向：sidecar 进程 → WeaselServer 进程（宿主）。
- 窗口：上游 `include/WeaselIPC.h` 既有 `WEASEL_IPC_WINDOW L"WeaselIPCWindow_1.0"`，
  由 `ServerImpl`（`DECLARE_WND_CLASS(WEASEL_IPC_WINDOW)`）注册；**fork 不改类名**，
  接收端就是这个既有隐藏窗口（"私有窗口"）。
- 找窗：发送端一律 EnumWindows + GetClassNameW 枚举式（FindWindowW 在部分宿主恒 0，
  #9 的教训；TS 侧已在 `src/runtime/weasel-messenger-koffi.ts` 实现）。接收端保证
  窗口是可枚举的真实顶层窗口且类名逐字一致。

## 逐字段契约

| 字段 | 值 | 说明 |
| --- | --- | --- |
| 窗口类名 | `WeaselIPCWindow_1.0` | 上游 `WEASEL_IPC_WINDOW` 原样；fork 零改动 |
| 消息 | `WM_COPYDATA` (0x004A) | `SendMessageTimeoutW(..., SMTO_ABORTIFHUNG(0x0003), 300ms)`，wParam=0 |
| COPYDATA 标识（dwData） | `0x52504D31` | fork 常量 `WEASEL_PREDICT_NOTIFY_COPYDATA_ID`（`include/WeaselPredictNotify.h`） |
| 载荷 | `"<engine_id>\n<request_id>\n<seq>"` | 三段身份，UTF-8 字节，**加一个终止 NUL**；**cbData 计入 NUL**；不含用户正文、拼音、候选或模型回答 |
| engine_id | 40 位**小写**十六进制 | 与发送端 `HEX_40` 逐字一致 |
| request_id | 32 位**小写**十六进制 | 与发送端 `HEX_32` 逐字一致 |
| seq | 十进制 `1..2^53-1` | 无符号、无前导零；与发送端 `Number.MAX_SAFE_INTEGER` 上限一致 |
| x64 COPYDATASTRUCT | 24 字节 | `ULONG_PTR dwData + DWORD cbData + 4 填充 + PVOID lpData`；fork 侧 `static_assert` 锁定 |

## 接收端行为（fork 实现）

- `WeaselIPCServer/WeaselServerImpl.cpp` `ServerImpl::OnCopyData`：
  - `dwData != 0x52504D31` → `bHandled = FALSE` 原样放行（不是我们的消息）。
  - 是我们的标识 → `bHandled = TRUE`，`ParsePredictNotifyPayload` 严格解析
    （`include/WeaselPredictNotify.h`，纯函数）：cbData 必须恰好覆盖「载荷 + 一个
    终止 NUL」，禁止内嵌 NUL 与尾随字节；恰好三段；逐段语法校验。
  - malformed → **静默吞掉**，不进 handler，不崩溃，不回错误。
- `RimeWithWeasel/RimeWithWeasel.cpp` `RimeWithWeaselHandler::PredictCompletion`：
  身份门控 + 重组触发（见下）。

## 身份门控（fork ↔ librime/lua 契约）

接收端**无常驻状态**（#7 决策④）；门控依据是**当前焦点会话**上由 Lua 组件发布的
RIME 属性（`Context::set_property` 写、fork 经 `rime_api->get_property` 读）：

| RIME 属性 | 内容 |
| --- | --- |
| `model_predict_engine_id` | 40 位小写 hex |
| `model_predict_request_id` | 32 位小写 hex |
| `model_predict_request_seq` | 请求序号十进制串 |

- Lua 组装请求时发布三段身份（S5 落地）；任一缺失或非法 → 通知不匹配 → 静默丢弃。
- 匹配规则（纯函数 `PredictIdentityMatches`）：三段逐一相等（seq 按数值比较）。
  - 过期/伪造通知（旧 seq、他人身份）→ 拒绝，静默。
  - **当前**身份的重复投递 → 再次匹配并再翻转一次 option（无状态设计下这是无害的
    一次多余重组；fork 有意不保存去重状态）。
- 门控选会话：`m_active_session`（最近 FocusIn/按键会话）；无焦点会话 → 静默。

## 重组触发（option 翻转）

匹配成功后**翻转一次**私有 option `model_predict_refresh`：

```
Bool cur = rime_api->get_option(session_id, "model_predict_refresh");
rime_api->set_option(session_id, "model_predict_refresh", current ? False : True);
```

librime 1.13.1 机制（逐行核对）：`Context::set_option` 每次调用必发
`option_update_notifier_`（无值去重）→ `ConcreteEngine::OnOptionUpdate`
（`src/rime/engine.cc:130-137`）在 `IsComposing()` 时调
`Context::RefreshNonConfirmedComposition()`（`context.cc:255-261`）→ 清未确认组字并
触发 `update_notifier_` → 引擎 `Compose` 重组 → Lua 滤镜在重组中重读响应文件、
插入第 5 槽位 → 候选窗立即刷新，**不依赖用户再按键**。该 option 名不在任何
show_notifications 配置内，不产生 UI 消息噪音。

## 与「IPC 扩展两个命令」的对账

spec #18/#22 的「IPC 扩展 2 命令」在实施切分后落位为：

1. `WEASEL_IPC_PREDICT_CONTEXT`（命名管道命令）—— **S2**（#21 定稿：插在
   `CHANGE_PAGE` 与 `LAST_COMMAND` 之间，上文通道）。
2. **完成通知 COPYDATA 命令**（`dwData = 0x52504D31`，私有窗口 WM_COPYDATA 分发族）
   —— **本票（S3）**。

S3 不新增管道枚举命令：刷新路径完全在服务端（COPYDATA → 门控 → 翻转 option），
不需要客户端命令，也不引入无人调用的死命令。

## 测试与验证

- **合成接收窗测试**：fork `test/TestPredictNotify`（vcxproj + sln + xmake 三件套，
  模式照 `TestWeaselIPC`）。真实 `ServerImpl` 窗口 + 录制 handler（完整复刻生产门控），
  覆盖：逐字节载荷投递、malformed 拒绝矩阵（缺 NUL/内嵌 NUL/尾随字节/段数/hex/seq
  语法/尺寸上界）、身份门控（未发布/过期/重复当前/不匹配）、失败静默、外来 dwData
  放行、EnumWindows+GetClassName 可发现性、x64 CDS 24 字节 static_assert。
  真 Weasel 在场（单实例互斥体被占）时窗口级用例自动跳过。
- **发送端↔接收端字节契约交叉验证**（2026-10-09，本会话）：以真实 TS 发送端
  （`completionPayload` + 终止 NUL）逐字节喂入 C++ 解析语法的 JS 镜像——全部一致
  （常量、三段语法、大小写、seq 上界、malformed 矩阵）。
- **编译 + 测试运行（2026-10-10 已在本机 dev 机实测通过）**：dev 机实有 VS2019 BuildTools（`C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\MSBuild\Current\Bin\MSBuild.exe`，vswhere 仅此一处安装）；fork CI 因
  workflow 文件不在默认分支从未注册。另一台机器复跑时按
  `build-and-release.md` §2/§3 前置后执行：

  ```
  git clone -b predict-0.17.4 --single-branch https://github.com/CometDash77/weasel
  cd weasel && copy env.vs2019.bat env.bat && REM BOOST_ROOT 指向 boost 1.84.0
  REM get-rime.ps1 -tag 1.13.1 -use dev 后：
  MSBuild.exe weasel.sln /p:Configuration=Release /p:Platform=x64 /t:TestPredictNotify /m /v:m /nologo   REM exit 0
  x64\Release\TestPredictNotify.exe   REM 实测 exit 0，stdout: TestPredictNotify: all checks passed
  ```

  - 产物目录是 `x64\Release\`（vcxproj 的 OutDir），不是 `msbuild\Release\x64\`。
  - **真 WeaselServer 在场时窗口级用例按设计跳过**：打印 `SKIP: single-instance mutex held (a real WeaselServer is running); window-level cases skipped.` 后仍退 0，只跑纯解析用例。要跑满须先停掉已安装的 `C:\Program Files\Rime\weasel-0.17.4\WeaselServer.exe`（释放单实例互斥体），跑完再启回；2026-10-10 按此法实测窗口级用例全绿。
  - HEAD 需含 `d7f2496`（`SendRaw` 前向声明），否则整个 solution build 在 `test/TestPredictNotify/TestPredictNotify.cpp` 上 C3861 失败。

- **真实 Weasel 互操作**（sidecar→fork 窗口、候选窗免按键刷新）归真机发布验收
  （#16 / release gate），按票面不进自动化。
