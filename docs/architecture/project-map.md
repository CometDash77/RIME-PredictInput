# 项目地图（TypeScript 重构后）

## 入口

| 入口 | 位置 | 说明 |
| --- | --- | --- |
| 伴随进程 | `dist/cli/main.js`（默认 `--source lua`） | 正常路径：请求泵 + 空闲退出 + 可选设置页 |
| 设置入口 | `dist/cli/main.js settings` | 拉起/复用设置服务并把浏览器指向 `/#<token>`，返回码 0/2/3/4/5 |
| 自检 | `dist/cli/main.js selftest` | 7 项离线边界检查，临时目录里跑，不碰真实用户目录 |
| 随包产物 | `build/exe/rime-predict-sidecar.exe`（`pnpm build:exe`） | 单文件形态（@yao-pkg/pkg）：预测泵 + selftest；无 settings 入口（CJS `import.meta.url` 限制，ADR 0003） |
| 设置页资产 | `assets/settings.html` | `__NONCE__` 在响应时替换 |

## 分层与数据流

```
Weasel/RIME ──文件 IPC──▶ src/ipc/file-ipc.ts ──▶ src/runtime/runtime.ts（请求泵、状态、空闲）
                                                        │ dispatch
                                                        ▼
                                             src/inference/service.ts（身份、缓存、状态、动作）
                                                        │ LocalBackendPort
                                                        ▼
                                  src/providers/ollama.ts ──本地 HTTP──▶ Ollama
                                                        │
        ◀──response-a|b.json + ready 标记── src/ipc/file-ipc.ts
设置页 ──回环 HTTP──▶ src/web/settings-host.ts ──▶ 上面的 service / runtime（只读视图 + 写设置）
```

依赖方向单一：`cli → web/runtime/inference/providers/settings/ipc/contracts/domain/json`，
下层永不 import 上层；`inference` 只通过 `ports.ts` 认识提供方，`runtime` 只通过
`dispatch.ts` 认识决策层。

## 模块清单

- `src/json/`：`canonical.ts`（Python 对齐的 JSON 编码 + `pythonNumber`）、`digest.ts`（sha256/摘要/正则）、
  `strict.ts`（重复键敏感解析）、`guards.ts`（`JsonObject`/`isJsonObject`）。
- `src/domain/`：`result.ts`、`ids.ts`（品牌 ID）、`error-codes.ts`（全部错误码联合 + 安全码正则）、
  `settings.ts`（设置模型 + 线格式 + `settingsEqual`）、`decision.ts`（决策输入 + 两个摘要）、
  `candidate.ts`、`context.ts`（上文快照）、`model.ts`、`secret-keys.ts`、`status.ts`、`cache-limits.ts`。
- `src/contracts/`：`policy.ts`（固定策略身份与聊天请求体）、`envelope.ts`（请求信封/响应槽位/就绪标记）、
  `ollama-wire.ts`（外部 JSON 的 zod 边界）。
- `src/ipc/`：`file-ipc.ts`、`app-paths.ts`；`src/settings/`：`store.ts`、`private-directory.ts`。
- `src/providers/`：`http.ts`、`ollama.ts`、`wire.ts`。
- `src/inference/`：`service.ts`、`outcome.ts`、`cache.ts`、`queue.ts`、`model-status.ts`、`health.ts`、
  `actions.ts`、`ports.ts`。
- `src/runtime/`：`runtime.ts`、`dispatch.ts`、`privacy-log.ts`、`completion-notify.ts`、`lifecycle.ts`、
  `child-process.ts`、`clock.ts`。
- `src/web/`：`settings-host.ts`、`safe-metadata.ts`、`launcher.ts`、`native-alert.ts`。
- `src/cli/`：`main.ts`、`selftest.ts`。

## 核心类型（改这些要先看消费者）

- `Result<T, E>`（`domain/result.ts`）：全项目没有例外抛错，只有端口处才允许 reject。
- `EngineId`/`RequestId`/`Sequence`（`domain/ids.ts`）：品牌类型，构造必须走智能构造器。
- `Settings` + `toWire`/`settingsFromMapping`（`domain/settings.ts`）：域模型与线格式的唯一转换点。
- `DecisionInput`（`domain/decision.ts`）：外部载荷 → 决策输入的**唯一**入口，错误码与旧实现逐字一致。
- `RequestEnvelope`/`ResponseRecord`/`ReadyMarker`（`contracts/envelope.ts`）：IPC 契约。
- `PredictionOutcome`（`inference/outcome.ts`）：`ok`/`unavailable`/`pending` 判别联合，
  `predictionWire` 决定 Lua 看到的键序。
- `ModelStatus`（`inference/model-status.ts`）、`SettingsActionReply`（`inference/actions.ts`）、
  `DispatchReply`（`runtime/dispatch.ts`）、`HealthReport`（`inference/health.ts`）。

## 测试地图

| 测试 | 数量 | 锁住什么 |
| --- | --- | --- |
| `tests/oracle-policy.test.ts` | 8 | 策略摘要/身份/验收证据/聊天请求体逐字段一致 |
| `tests/oracle-decision.test.ts` | 22 | 决策输入 21 条载荷 + 两个摘要 |
| `tests/oracle-settings.test.ts` | 26 | 设置 26 条映射与线格式全等 |
| `tests/oracle-requests.test.ts` | 19 | 请求信封 18 条 + 逐字节重编码 |
| `tests/oracle-ipc.test.ts` | 5 | 请求/响应文件字节、槽位语义、消费、小数时间戳 |
| `tests/settings-store.test.ts` | 9 | 设置文件字节、不覆盖写、迁移只搬一次 |
| `tests/providers.test.ts` | 32 | HTTP 映射、探活、清单、`ps` 归属、choice 校验、拉取、卸模 |
| `tests/inference.test.ts` | 48 | 46 条旧行为快照 + 缓存/router/状态/动作 |
| `tests/runtime.test.ts` | 17 | 13 个请求泵场景 + 2 个运行循环 + 构造期回落 |
| `tests/settings-host.test.ts` | 16 | 回环约束、令牌、CSP/nonce、过滤与错误文案 |
| `tests/launcher.test.ts` | 8 | 返回码 0/2/3/4/5 与轮询顺序 + selftest 绿灯 |

快照文件 `tests/fixtures/oracle.json` 由 `pnpm fixtures` 从旧实现重新生成；
`tests/support/oracle.ts` 用 zod 把它解析成类型，`tests/support/json.ts` 负责把
验证过的外部数据变成项目内部 JSON 类型。

## 验证方式

```
pnpm install
pnpm verify          # tsc --noEmit ×2 + vitest（354 条）
pnpm build           # tsc -p tsconfig.json
pnpm selftest        # 需要先 build
pnpm build:exe       # tsc + 单文件 exe（@yao-pkg/pkg，CUI+GUI 变体，selftest 等价 smoke 内建；见 ADR 0003）
pnpm fixtures        # 可选：重放旧实现生成快照（需要 Python）
```

## 改动指引

- 改决策输入校验或摘要 → 跑 `oracle-decision`，并确认 `oracle.json` 未变。
- 改任何线上键名/键序 → 跑 `oracle-requests`/`oracle-ipc`/`inference`（它们做逐字节比对）。
- 改设置字段 → 跑 `oracle-settings` + `settings-store` + `settings-host`。
- 改请求泵/状态文件/日志 → 跑 `runtime`。
- 改提供方 → 跑 `providers`（假 transport，不打真实 Ollama）。

## 已知技术债

见 `docs/refactor-record.md` 的「还剩什么」，以及 `docs/adr/0001`、`docs/adr/0002`
两处因纯 Node 限制而做的替代实现。
