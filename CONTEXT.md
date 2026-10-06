# RIME 模型预测插件 —— 领域文档（single-context）

本文是这个仓库**唯一**的领域词汇表：探索代码前先读它，命名领域概念时用这里的词。
架构决定见 `docs/adr/`（目前两份）；重构过程与新架构地图见
`docs/refactor-record.md` 与 `docs/architecture/project-map.md`。若代码与本文冲突，
以代码为准并回来修正本文。

## 这个产品是什么

Windows 上 Weasel/RIME 用户的**按需模型预测插件**：用户输入拼音时，伴随进程用本地
Ollama 模型在**已有候选页**里挑一个更符合上文的候选，Lua 滤镜把它插到默认第 5 个显示位。
产品不生成新文字，不改用户词库，不下载模型，不记录用户正文。

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
- **决策结果（`DecisionResult`）**：`choice`（选原候选）｜`generated_text`（生成新文字，
  仅存在于隔离原型）｜`skip`/`reject`/`stale`（不发、拒绝、过期）。
- **请求身份（request identity）**：`engine_id`（本仓库用 40 位十六进制）、`seq`
  （单调递增，响应槽位按 `seq % 2` 轮换）、`request_id`（32 位十六进制）、设置修订、
  模型身份、候选指纹。**上一身份的旧结果不得显示或提交**。
- **模型身份（model identity）**：`ollama:<sha256(digest + ":" + POLICY_DIGEST)>`。
  `POLICY_DIGEST` 冻结了系统提示词与采样参数（`temperature 0`、`seed 19`、
  `num_predict 32`、`num_ctx 2048`，`think: false`）。
- **已验证身份（validated identity）**：`POLICY_DIGEST === VALIDATED_POLICY_DIGEST` 且
  `identity === VALIDATED_IDENTITY`。只有已验证身份的结果才可能被标为可用。
- **可用（eligible）**：结果可以交给 Lua 插入第 5 位的前提 = 发布成功 + `status === "ok"` +
  `eligible === true`。完成通知也以它为前提。
- **槽位（slot）**：插入位置，默认 5。
- **停手延迟（`local_wait_ms`）**：用户停手多久后才真的预测，默认 150，上限 200 ms。
- **伴随进程（sidecar）**：按需启动、默认 60 秒空闲自动退出的常驻进程；由锁文件保证单实例。
- **文件 IPC**：`requests/` 放 `req-<engine>-<seq 20 位>-<request_id>.json`；
  `responses/<engine_id>/` 放 `response-a|b.json` + 同名 `.ready` 标记
  （标记含 `bytes` 与 `sha256`，槽位按 `seq` 奇偶轮换）。**IPC 是权威通道**。
- **完成通知（completion notice）**：告诉 Weasel 候选窗可以立即刷新，不必等下一次按键；
  载荷是 `"<engine_id>\n<request_id>\n<seq>"`，**不含任何正文或候选文本**。
- **设置（settings）**：`%USERPROFILE%\.rime-model-predict\settings.json`。文件里是
  snake_case 线格式（`local_model`、`local_wait_ms`、`log_mode`…），域模型里是
  camelCase；`provider` 恒为 `null`，旧 Cloud 偏好会被忽略并退回默认设置。
- **设置页会话（session）**：`http://127.0.0.1:48371/#<token>`，令牌 900 秒 TTL、
  最多 16 个会话、只绑回环、Host/Origin 都必须等于回环地址。
- **诊断日志（`diagnostics.log`）**：`metadata` 模式只记事件名、状态、耗时、错误码，
  **绝不记正文、拼音、候选或模型回答**。

## 领域规则（改代码前先确认）

1. 普通输入必须立即可用：插件禁用、缺模型、未验证身份、读不到上文时，只允许「留空」。
2. 只有用户自己在候选窗选中模型候选，才算被采纳（`selection` 事件）；插件不代用户提交。
3. 输入、文档、光标、会话、设置变化后，旧结果一律作废。
4. 本地推理、隐私优先：不持久化正文/拼音/答案，不手改 `userdb`，不自动换模型或下载。
5. 安装不依赖作者路径、个人配置或指定词库；卸载后普通输入仍可用且无自有残留进程。
