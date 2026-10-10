# ADR 0004：双通道推理端口——本地与云端共用同一决策契约

- 状态：已采纳（2026-10-07，spec #10；三项分叉由 YG 拍板：①A 适配器契约即验收、
  ②A settings.json 内嵌凭据槽、③A 按端点自动切换）
- 背景：重构后的伴随进程只有本地 Ollama 单一后端；没有本地模型的用户无法使用。
  spec #10 要求双通道接入——本地 = OpenAI 兼容 baseURL 自由配置 + Ollama 11434
  预置检测（发现即填、不强制、可改写），云端 = OpenAI Responses / OpenAI Chat
  Completions / Anthropic Messages / 自定义通道，且所有适配器实现同一推理端口。

## 决定

1. **本地 Ollama 原生路径零改动**：`local_base_url` 等于缺省值时，推理走冻结字节的
   `/api/chat`（`think:false`/`format`/`num_ctx 2048`/`seed 19`），身份仍是
   `ollama:sha256(digest:POLICY_DIGEST)` 的冻结组合校验。OpenAI 兼容 wire 上没有
   num_ctx/think 的等价物，换 wire 即换策略即换身份——已验收证据链会断，因此
   缺省路径的 wire 是不可协商的。
2. **按端点自动切换（③A）**：`local_base_url` 被改写为任何其他值 → 本地兼容传输
   （POST `<base>/chat/completions`，无 response_format、无 Ollama 归属核对）。
   传输选择是实现细节，不进设置线格式。
3. **适配器契约即验收（①A）**：兼容端点与云端适配器在响应侧强制与本地完全相同的
   答案契约（strict JSON 拒绝重复键、恰好一个 `choice` 整数键、1..N 越界即拒、
   完成原因逐一核对），其身份视为已验收。身份 =
   `<前缀>:sha256(前缀·端点·模型·POLICY_DIGEST)`，前缀 ∈ local-compat /
   openai-responses / openai-chat / anthropic / custom；凭据不参与身份（换 key 不
   作废缓存）。`isEligibleIdentity` 是资格判定唯一入口：ollama 前缀走冻结组合，
   其余前缀属于契约验收集。
4. **云端端点策略**：openai-responses / openai-chat / anthropic 固定官方缺省端点
   （凭据只发往固定源，base_url 不可覆盖）；custom = OpenAI Chat 兼容 wire + 自由
   端点（spec 把自定义形态细则归架构票，契约层只需保证存在可用自定义通道）。
   官方 OpenAI 端点带 json_schema strict 请求约束，custom 与本地兼容端点为最大
   兼容省略之——响应侧契约兜底，失败一律安全留空。
5. **凭据槽豁免（②A）**：`cloud.api_key` 是设置文件中唯一豁免 `findSecretKey`
   递归扫描的字段。豁免条件：顶层 `cloud` 键集恰好为 kind/model/api_key/base_url
   四键且 api_key 是字符串；扫描先于结构校验，任何变形（多余键、数组、嵌套）都
   使豁免失效、凭据键名照旧被拒。SECRET_KEYS 名单、文件 IPC 与设置网页的裸凭据
   拒绝行为零改动。
6. **设置线格式 omit-if-default**：新键 `local_base_url`/`cloud_enabled`/`cloud`
   只在非缺省时写出——旧设置文件读入再写回字节不变（oracle-settings 全绿不动
   fixture）。`backend`/`provider` 冻结为 `"local"`/`null`，通道选择由新键表达。

## 后果

- 云端 opt-in 默认关闭：缺字段 = 本地通道、云端关，行为与通道化之前逐字节一致。
- 跨通道缓存隔离由缓存键 `state·candidates·backend:provider·modelIdentity` 天然
  保证；`settingsEqual` 覆盖通道字段（含凭据轮换 → 延迟响应作废）。
- 诊断日志/状态文件的 metadata 白名单不变：云端结果只多出 provider/model 字符串，
  正文、拼音、答案、凭据仍不可表达。
- health/test_connection 按当前通道探测云端（GET `/models`，不消耗推理费用）；
  模型清单/下载/卸载等管理面仍只对 Ollama 有意义，本期设置页 UI 不动。
- 真实云端 API 的线上行为（headers 兼容性、Responses API 细节）未实测；假 transport
  契约已锁，真机联调归发布验收。
