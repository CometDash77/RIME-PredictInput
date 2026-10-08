# RIME 模型预测插件 —— 领域文档（single-context）

本文是这个仓库**唯一**的领域词汇表：探索代码前先读它，命名领域概念时用这里的词。
架构决定见 `docs/adr/`（目前两份）；重构过程与新架构地图见
`docs/refactor-record.md` 与 `docs/architecture/project-map.md`。若代码与本文冲突，
以代码为准并回来修正本文。

## 这个产品是什么

Windows 上 Weasel/RIME 用户的**按需模型预测插件**：用户输入拼音时，伴随进程完成一次
决策——在**已有候选页**里挑一个更符合上文的候选（选择），或按光标前上文＋拼音在**用户
词库内**生成一个词条（生成）；Lua 滤镜把它插到默认第 5 个显示位。生成词必须在词库内
（不造词，成员校验失败安全留空）。产品不改用户词库，不下载模型，不记录用户正文。

运行链：编辑器 →(TSF)→ WeaselServer + librime → librime-lua 滤镜 →(文件 IPC)→
伴随进程（本仓库）→(本地 HTTP，按需)→ Ollama →(文件 IPC)→ Lua → 候选窗。
**TS 重构只替换「文件 IPC 之后的伴随进程」这一段**：`lua/*.lua`、schema、
已装载的 Weasel TSF 都不属于本仓库的改动范围。

## 核心词汇

- **决策输入（decision / `DecisionInput`）**：一次预测的全部输入 = `task`（固定
  `中文输入法候选选择`）、`preceding_text`（光标前真实上文，最多 300 个 Unicode
  标量）、`pinyin`（本次全部拼音）、`candidates` + 可选 `candidate_fields`
  （每项的 `preedit`/`start`/`end`）。
- **候选编号（choice）**：**从 1 开始**的显示顺序，不是数组下标。模型只能回答这个编号，
  越界视为无效响应。
- **上文快照（`ContextSnapshot`）**：`ok`（有上文）｜`unavailable`（读不到）｜
  `protected`（受保护，不应读取）。`precedingText === ""` 表示**可确认的空上文**，
  与「读不到」是两件事：可以空上文预测，但读不到就不发请求。
- **决策结果（`DecisionResult`）**：`choice`（选原候选）｜`generated_text`（生成模式产出的
  词库内词条，成员校验失败即留空）｜`skip`/`reject`/`stale`（不发、拒绝、过期）。
- **请求身份（request identity）**：`engine_id`（本仓库用 40 位十六进制）、`seq`
  （单调递增，响应槽位按 `seq % 2` 轮换）、`request_id`（32 位十六进制）、设置修订、
  模型身份、候选指纹。**上一身份的旧结果不得显示或提交**。
- **模型身份（model identity）**：`ollama:<sha256(digest + ":" + POLICY_DIGEST)>`。
  `POLICY_DIGEST` 冻结了系统提示词与采样参数（`temperature 0`、`seed 19`、
  `num_predict 32`、`num_ctx 2048`，`think: false`）。
- **已验证身份（validated identity）**：`POLICY_DIGEST === VALIDATED_POLICY_DIGEST` 且
  `identity === VALIDATED_IDENTITY`。只有已验证身份的结果才可能被标为可用。
- **契约验收集（contract-validated prefixes）**：本地兼容端点与云端四通道的适配器在
  请求/响应两侧强制与本地完全相同的决策契约（strict JSON、choice 1..N、越界即拒），
  其身份（`<前缀>:<sha256>`，前缀 ∈ local-compat / openai-responses / openai-chat /
  anthropic / custom）视为已验收（spec #10 决策 09，YG 拍板 ①A）。
- **可用（eligible）**：结果可以交给 Lua 插入第 5 位的前提 = 发布成功 + `status === "ok"` +
  `eligible === true`；判定跨通道一致——ollama 前缀走冻结组合校验，其余前缀属于
  契约验收集。完成通知也以它为前提。
- **通道（channel）**：决策请求的接入形态。本地 = Ollama 原生端点（缺省
  `http://127.0.0.1:11434`，走冻结的 `/api/chat` 字节与已验收身份）或任意 OpenAI 兼容
  baseURL（走 `/chat/completions`，契约验收身份）；云端 = OpenAI Responses /
  OpenAI Chat Completions / Anthropic Messages / 自定义（OpenAI 兼容 wire + 自由端点）。
  传输按端点自动切换，不进设置线格式；云端显式 opt-in 默认关（YG 拍板 ③A），
  设置页开启处明示披露：开启后正文（上文）、拼音与候选列表发往所配服务商，
  任何通道不持久记录这些内容。
- **槽位（slot）**：插入位置，默认 5。
- **停手延迟（`local_wait_ms`）**：用户停手多久后才真的预测，默认 150，上限 200 ms。
- **伴随进程（sidecar）**：按需启动、默认 60 秒空闲自动退出的常驻进程；由锁文件保证单实例。
- **文件 IPC**：`requests/` 放 `req-<engine>-<seq 20 位>-<request_id>.json`；
  `responses/<engine_id>/` 放 `response-a|b.json` + 同名 `.ready` 标记
  （标记含 `bytes` 与 `sha256`，槽位按 `seq` 奇偶轮换）。**IPC 是权威通道**。
- **瞬态运行时文件（transient runtime files）**：sidecar 在用户目录产生的非配置文件——
  `ipc/requests/`、`ipc/responses/<engine_id>/`、`status.json`、`sidecar.lock`；
  消费即删、启动时清 60 秒前的残骸、卸载终局全清，请求与响应文件含正文/拼音与
  模型回答，属隐私敏感载荷。`settings.json` 与 `diagnostics.log` 不属此类：
  前者卸载保留，后者卸载删除。
- **完成通知（completion notice）**：告诉 Weasel 候选窗可以立即刷新，不必等下一次按键；
  载荷是 `"<engine_id>\n<request_id>\n<seq>"`，**不含任何正文或候选文本**。
- **设置（settings）**：`%USERPROFILE%\.rime-model-predict\settings.json`。文件里是
  snake_case 线格式（`local_model`、`local_wait_ms`、`log_mode`…），域模型里是
  camelCase；`backend`/`provider` 冻结为 `"local"`/`null`（旧 Cloud 偏好仍被忽略并退回
  默认设置），通道选择由 `local_base_url`/`cloud_enabled`/`cloud` 表达，且一律
  **omit-if-default**——旧设置文件读入再写回字节不变。云端凭据只存 `cloud.api_key`
  槽位（设置文件中唯一豁免凭据扫描的字段；其余任何位置的凭据键名照旧拒绝），
  绝不进诊断日志或完成通知载荷，云端请求载荷仅存内存。卸载保留设置文件：
  重装即恢复原配置；手动全清 = 删除整个用户目录。
- **设置页会话（session）**：`http://127.0.0.1:48371/#<token>`，令牌 900 秒 TTL、
  最多 16 个会话、只绑回环、Host/Origin 都必须等于回环地址。
- **更新检查（update check）**：伴随进程对 GitHub releases API 的匿名 GET。出站只有
  固定 URL + 静态产品 UA，无 body、不跟随重定向；比较只认 stable（draft/prerelease/
  非 semver tag 不参与，跳转链接限 github.com）；传输拒绝/非 200/坏 JSON/无 stable
  一律折叠成 `unavailable` 完全静默；会话内节流（默认 1 小时一次）。触发点是
  **设置页会话读取**：只有打开设置页才可能出站，sidecar 冷启动与普通输入零网络；
  开关关闭时连询问都不发生。设置页展示面 = 发现新版本时呈现 tag 与发布页跳转链接，
  其余（最新/失败/关闭）一律静默；绝不自动下载或安装。
  `update_check_enabled` 默认开（omit-if-default 反向：只在关闭时写出）。
- **安装计划（install plan）**：安装/升级/卸载/还原的纯函数决策面——输入环境
  快照（自有文件摘要、TSF 注册状态、共享模型路径）与随包目标清单（路径表
  注入，契约不编造路径），输出操作清单（写/删/注册/还原指引）与保留清单；
  执行器只是薄壳。幂等重装 = 空增量或等价操作；中断自愈 = 缺的补写、遗留
  清掉；共享模型只进保留清单，绝不进操作清单。卸载固定序：反注册 TSF →
  按 `status.json` 的 pid 加进程映像校验终止 sidecar（校验不过提示手动退出重试）→
  删自有程序文件与明确接入项（Lua 滤镜、custom 补丁条目）→ 删瞬态运行时文件与
  诊断日志 → 还原指引；卸载幂等 = 重跑即跳过已消失文件。升级零触碰用户目录，
  瞬态卫生由 sidecar 启动清理兜底；旧版位置迁移成功后清理、失败不动。
- **诊断日志（`diagnostics.log`）**：`metadata` 模式只记事件名、状态、耗时、错误码，
  **绝不记正文、拼音、候选或模型回答**。

## 领域规则（改代码前先确认）

1. 普通输入必须立即可用：插件禁用、缺模型、未验证身份、读不到上文时，只允许「留空」。
2. 只有用户自己在候选窗选中模型候选，才算被采纳（`selection` 事件）；插件不代用户提交。
3. 输入、文档、光标、会话、设置变化后，旧结果一律作废。
4. 本地推理、隐私优先：不持久化正文/拼音/答案，不手改 `userdb`，不自动换模型或下载。
5. 安装不依赖作者路径、个人配置或指定词库；卸载后普通输入仍可用且无自有残留进程。
