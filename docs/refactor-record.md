# 重构记录（Python sidecar → strict TypeScript）

这份记录只讲三件事：**已经迁移了什么**、**过程中发现了哪些设计问题**、**还剩什么**。
它按实际执行顺序写，供后续 Agent 定位「哪一块已经稳定、哪一块刚动过」。

## 阶段与产物

**阶段 0 · 行为基线（先冻结旧行为，再动代码）**
旧实现是 `reference/runtime-baseline/` 下的 Python 伴随进程（`sidecar/model_predict/*.py`）
加四个 Lua 文件。做法不是逐行翻译，而是先把旧实现的行为**变成可重放的快照**：
`tools/oracle/dump_fixtures.py` 直接 `import` 旧模块，驱动真实 `Request.parse`、
`Settings.from_mapping`、`FileIpc`、`InferenceService`、`SidecarRuntime`，
把返回值、错误码、**文件字节**写进 `tests/fixtures/oracle.json`（Python 3.14.5 跑一次，
最后 97329 字节）。新实现每条分支都要和它逐条对齐——这是「核心行为一致」这句验收的凭据。

**阶段 1 · TypeScript 工程**
`package.json`（ESM、`bin`、`files: dist+assets`、scripts：`build`/`typecheck`/`test`/`fixtures`/`selftest`/`verify`）、
`tsconfig.json`（`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` +
`noImplicitOverride`/`noImplicitReturns`/`noFallthroughCasesInSwitch`/`noUnusedLocals`/`noUnusedParameters`/
`noPropertyAccessFromIndexSignature`/`useUnknownInCatchVariables`/`isolatedModules`/`verbatimModuleSyntax`/`erasableSyntaxOnly`）、
`tsconfig.test.json`（`noEmit`，含 `tests/`）、`vitest.config.ts`（`pool: forks, maxWorkers: 1`）。
实测 TypeScript 7.0.2 接受上述全部选项。唯一依赖是 `zod`；测试用 `vitest`。

**阶段 2 · 底层与契约层**（`src/json`、`src/domain`、`src/contracts`、`src/ipc`、`src/settings`）
Python 对齐的 JSON 编码器（`compact`/`sortedCompact`/`defaultSeparators`/`indented`、`pythonNumber`）、
`sha256Hex`/`jsonDigest`/`policyDigest`、严格的重复键检测解析器（`src/json/strict.ts`）、
品牌化 ID（`EngineId`/`RequestId`/`Sequence` + 智能构造器）、判别联合设置模型、
决策输入校验（错误码与文案逐条复刻）、请求信封解析、`FileIpc`（`.part` → `rename`、
`fsync`、响应槽位 + `ready` 标记 + sha256/bytes 校验）、设置存储（原子写 + 不覆盖迁移）。

**阶段 3 · 模型提供方**（`src/providers/`）
`http.ts`：`redirect: manual`、`AbortSignal.timeout`、1 MiB 上限、`safeHttpError` 映射表。
`ollama.ts`：探活/鉴权、`cli` 位置探测、`/api/tags` 解析、manifests 兜底清单、
`/api/ps` 模型归属记账、`keep_alive` 取舍、`format` + `choice` 严格校验、
拉取状态机、`close()` 卸模。`ollama-wire.ts` 用 zod 把外部 JSON 收窄成 DTO。

**阶段 4 · 决策层**（`src/inference/`）
`outcome.ts`（判别联合 + 线上键序）、`cache.ts`（LRU + 身份键）、`queue.ts`（单线程串行 +
代数取消）、`model-status.ts`（纯函数：清单 → 验收状态/来源/质量文案）、`health.ts`、
`ports.ts`（`Pick<LocalBackend, …>` 端口）、`actions.ts`、`service.ts`（`submit`/`dispatch`/
`settingsAction`/`statusSince`）。

**阶段 5 · 宿主层**（`src/runtime/`）
`dispatch.ts`（dispatch 契约从 inference 挪到宿主）、`privacy-log.ts`（轮转 + 7 天 + 5 MiB 上限，
Python ISO 时间戳与 banker's rounding）、`completion-notify.ts`（门控纯函数 + 发送端口）、
`runtime.ts`（请求泵、状态文件、延迟响应二次写回、空闲退出）、`lifecycle.ts`（单实例 + 空闲计时 +
自有子进程）、`child-process.ts`、`clock.ts`。

**阶段 6 · 网页与入口**（`src/web/`、`src/cli/`、`assets/`）
回环 HTTP 主机（令牌会话、Host/Origin 校验、CSP nonce、`_safe_metadata` 过滤、
13 条白名单错误文案）、旧 `settings.html` 逐字节复制为 `assets/settings.html`、
设置入口启动器（返回码 0/2/3/4/5）、原生提示（PowerShell MessageBox 替代 ctypes）、
`cli/main.ts`（`--source`/`--idle-seconds`/`--token`/`--migrate-settings`、`settings` 子命令）
与 `cli/selftest.ts`（7 项离线自检）。

## 发现的设计问题（并已处理）

1. **digest 是隐性契约**。旧实现的摘要依赖 `json.dumps` 的默认分隔符与键序，
   任何一处用 JS 的 `JSON.stringify` 就会悄悄改变 `POLICY_DIGEST`。现在编码器
   只有 `src/json/canonical.ts` 一个来源，契约路径一律走它。
2. **同一事实三处重复**：`DEFAULT_MODEL`/`MODEL_DIGEST` 在设置、策略、提供方各写一遍；
   禁键清单在 IPC、设置文件、设置网页各写一遍。已收敛到 `domain/model.ts` 与
   `domain/secret-keys.ts`。
3. **平台相关的路径比较**。旧代码靠 Python `Path` 在 Windows 上大小写不敏感的行为排序请求文件。
   新实现显式写比较函数，行为不再取决于运行平台。
4. **坏设置文件两种表现**：构造期直接抛异常（伴随进程起不来），预测期却回落默认。
   统一为「读失败 → 默认设置（即关闭预测）」，并在 selftest 与 runtime 构造用例里断言。
5. **`_read_latest_response` 的漏网异常**：`.ready` 不是对象时抛 `AttributeError` 逃出
   except 元组，会直接打断伴随进程。新实现按无效槽位跳过。
6. **死字符串**：`provider is unsupported` 在白名单里但代码从不抛出——保留以满足线上兼容，
   并在此标注。
7. **不可表达的状态**：`predict_local_only`（旧 `{status:"unavailable",error_code:"local_only"}`）
   在新类型里表达不出来，因为 `Backend` 只有 `"local"`，且 `settingsFromMapping` 已提前拒绝。
   对照测试里用排除集显式记录，并另写一条断言。
8. **纯 Node 做不到的两件事**：完成通知（`FindWindowW` + `SendMessageTimeoutW(WM_COPYDATA)`）
   与命名互斥体。前者改成「门控纯逻辑 + `NativeWindowMessenger` 端口」，默认空实现；
   后者用锁文件 + 进程存活检查。见 `docs/adr/0001`、`docs/adr/0002`。
9. **整数时间戳无法逐字节对齐**：Python 把 `1000.0` 写成 `"1000.0"`，JS 写不出同样字面量。
   生产时间戳都不是整数，所以快照里只用小数时间戳做逐字节比对，整数用例比较解析后的字段。
10. **删掉的死代码**：`src/ipc/file-ipc.ts` 末尾未使用的 `responsePayload`、重复的
    `FORBIDDEN_KEYS`/`casefold`/`DEFAULT_MODEL` 本地副本、未使用的导入。

## 还剩什么

- **完成通知的实际发送端**：需要原生助手（编译的小 exe/DLL）或在 Lua 侧加一个轻量计时器。
  在这之前，「预测结果要等下一次按键才出现」——这是唯一没有在运行期复现的旧行为。
- **替换安装链里的 Python 启动器**：旧 `rime_model_predict_launcher.dll` 仍指向 pythonw，
  需要改成拉起 `node dist/cli/main.js`（含打包与卸载脚本）。
- **`generated_text`（直接生成新文字）**：产品目标里仍是隔离原型范围，本仓库当前只实现
  「在原候选里选一个」。
- **真机端到端验收**：真实 Weasel + 本地 Ollama 下的 300 字上文、右键菜单、禁用与恢复、
  60 秒空闲释放，需要在装有 RIME 的机器上按支持矩阵实测。
- **设置页资产**：`assets/settings.html` 目前是旧文件逐字节复制；将来若要改界面，
  应把它纳入构建流程而不是继续手改。
- **分发与支持矩阵**：见 GitHub map `#1` 的 `#3`/`#4`/`#5` 三张决策票（未关闭）。
