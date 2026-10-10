# ADR 0008：安装路径表——R1–R4 的冻结值与唯一的拼装点

- 状态：已采纳（2026-10-10，issue #26 / spec #18 §5）
- 背景：安装、升级、卸载与还原要能写成纯决策（#26 验收②⑦：同一快照重放、不依赖真实 IO），
  前提是「东西放哪」不再是运行时探测，而是注入进决策的常量。上游 Weasel 的安装器把程序文件
  放进 `$INSTDIR\weasel-<版本>`（fork `output/install.nsi:21`：
  `!define WEASEL_ROOT $INSTDIR\weasel-${WEASEL_VERSION}`；:130-141 把 `$INSTDIR` 设为
  `$PROGRAMFILES64\Rime` 或 `$PROGRAMFILES\Rime`；:212 安装前 `StrCpy $INSTDIR "${WEASEL_ROOT}"`），
  而 librime-lua 只从用户目录的 `lua\` 里 `require` 模块（证据汇总见 `src/install/paths.ts`
  头部注释；librime-lua `src/modules.cc:56-63`）。上级目录与用户侧接入点的写法一旦选错，
  卸载就会留下残骸，或者删掉不该删的东西。

## 决定

1. **R1：程序根 = `%ProgramFiles%\Rime\weasel-<官方版本>`，前端 DLL 留在程序根。**
   `programRoot = join(programFiles, installParent ?? "Rime", "weasel-" + OFFICIAL_WEASEL.version)`，
   冻结版本 `0.17.4`；`frontend = programRoot\WeaselTSF.dll`。TSF 的注册指向该 DLL，位置不能挪；
   程序目录（`programFiles` 与 `installParent`）可注入，缺省即官方布局。
2. **R2：自有新增产物集中到 `<程序根>\predict`。** 两个伴随进程与设置页都在
   `FEATURE_DIRECTORY = "predict"` 之下，程序根只多这一个目录。理由：卸载的可枚举性依赖
   「自有 = 一个目录 + 几件明确接入项」；散落进 `data\` 或程序根就没法证明「全清」。
3. **R3：用户侧只有两处接入点，外加一个用户目录。** ① `<RIME 用户目录>\lua\`
   （`%APPDATA%\Rime\lua\`）放四个 Lua 模块与 `rime_model_predict_launcher.dll`，
   启动器与模块**必须同目录**——`assets/lua/model_predict_host.lua:104-115,131` 正是用模块自己的
   目录加 `package.loadlib` 解析启动器的；② 每个要启用预测的方案各有一条 `<schemaId>.custom.yaml`
   补丁条目（`engine/filters/@next: lua_filter@*model_predict_filter`）；③ `%USERPROFILE%\.rime-model-predict`
   放设置文件与瞬态运行时文件。RIME 用户目录与用户目录都可注入，便于测试与将来改布局。
4. **滤镜引用选 `lua_filter@*model_predict_filter`，不占用用户的 `rime.lua`。** `@` 后面的 `*名字`
   是 librime-lua 的「按模块 `require`」写法，模块放在用户 `lua\` 目录里就能被找到，因此不需要写
   用户全局的 `rime.lua`，也不与用户自己的 Lua 滤镜抢名字。反过来，这也把「四个模块与启动器必须
   落在 `<RIME 用户目录>\lua\`」变成硬约束，而不只是习惯。
5. **旧版位置迁移的「成功」判据就是 `migrateLegacySettings` 返回 true。**
   `src/settings/store.ts:145-158`：目标设置文件已存在 → false（不动）；
   `%LOCALAPPDATA%\rime-model-predict\settings.json` 不存在或读不出来 → false（不动）；只有保存成功才 true。
   安装计划只消费这个布尔量：`migrated` 才产出 `delete-tree` 清理旧位置，`blocked` 时旧路径进保留清单、
   一个字节都不动。
6. **只交付 `patchFilePath(paths, schemaId)`，枚举哪些方案归安装器。** 方案自己的 `engine/filters`
   不继承 `default.yaml`，所以「给哪些方案写补丁」是安装器的枚举问题，域层猜不出来；域层只保证
   文件名合法（`/^[A-Za-z0-9_.-]+$/`，非法抛 `schema id must be a plain file name`）。选哪些方案、
   写几条、要不要问用户——属安装器形态，见 S9（`#27`）。
7. **路径在构建期固定，运行时不做探测。** 只有目录名与官方版本是编译期常量；`programFiles`、
   `userProfile`、`appData` 由构建/打包入口灌入。域层与安装计划永不读 `process.env`、永不在运行时
   猜「自己在哪」——否则验收⑦的纯快照重放不成立。

## 后果

- 新增构成：`src/domain/install-plan.ts`（纯决策：操作清单与保留清单）、`src/install/paths.ts`
  （唯一拼装点 + 角色名到路径的映射）、`src/install/executor.ts`（薄壳：只执行 `InstallOp`，
  IO 端口注入，自身碰不到 fs 与进程表）。
- `pnpm verify` 从 415 条涨到 445 条：`tests/install-paths.test.ts`（14 条，锁 R1–R4 与非法输入）、
  `tests/install-executor.test.ts`（10 条，锁排序、失败即停、终止守卫）、
  `tests/install-replay.test.ts`（6 条，真实路径表 + 真实计划跑在内存机上）。
- 终止伴随进程是唯一带外部危险的动作，因此做得最窄：先按 `status.json` 里的 pid 查进程映像，
  归一化（去引号、斜杠统一、大小写不敏感）后必须落在自有伴随进程清单里，否则拒绝终止并提示
  「手动退出后重试」（`retryable: false`）。不盲杀 pid。
- 本 ADR 不裁定安装器形态（NSIS/Inno/MSI）、UAC 界面与 `ProgramData` 的真实 ACL —— 那是 S9（`#27`）。
- 已知未收口：S4（`#23`）遗留的路径分隔符口径（`include/WeaselPredictSettings.h:77-88` 只在末字符
  非分隔符时补反斜杠，而该票测试期望纯反斜杠）不在本票范围，路径表不依赖它。
