# ADR 0007：生成模式——同一端口上的第二个问题，默认关闭

- 状态：已采纳（2026-10-10，issue #25 / spec #18 §3；默认开关口径来自 #6 Q6A）
- 背景：S1–S5 的推理端口只回答一个问题——「在一页候选里挑第几个」。spec #18 §3 要求同一端口
  再回答第二个问题：「按上文与拼音，在用户词库里给出一个词条」，而 #13 的冻结实验已给出质量
  结论：六个候选臂全部未达发布门槛（beyond-page 深位命中 0–4% vs 门槛 ≥60%，机制错误
  55–62/102 vs 硬 0），地图决议「全部不可接入」；#6 Q6A 规定生成作为默认关闭的实验性能力随包
  发布，达标与否只影响默认值，不影响能否发布。

## 决定

1. **判别联合就挂在决策输入上（`mode`）**：`DecisionInput` =
   `SelectionDecision{mode:'selection'}` ｜ `GenerationDecision{mode:'generation'}`；载荷缺
   `mode` 或写 `null` 按 `'selection'` 解释（旧 Lua 载荷逐字节不变），其他值一律
   `invalid_mode`。模式分派藏在 inference/providers 内部，Dispatch 与运行时调用者签名不变；
   `mode` 进缓存键——同一个 state 下这是两个问题。
2. **生成走独立冻结的策略摘要**：`GENERATION_POLICY_DIGEST` 冻结系统提示词、`{temperature:0,
   seed:19,num_predict:256,num_ctx:2048}`、严格 JSON（恰一键 `text`、`[string,null]`、1..32 字）
   与 CJK 范围；`generationIdentityFor(digest)` 与选择模式的 `identityFor(digest)` 不同源，
   云端身份同理换 `generationCloudIdentityFor`。**换模式必然换身份 ⇒ 上一模式的缓存与答案
   一概作废。**
3. **生成资格闸门是「已验收组合」，缺省为空**：`VALIDATED_GENERATION_POLICY_DIGEST` 与
   `VALIDATED_GENERATION_IDENTITY` 均为 `null`——#13 没有一条臂达标、地图决议「全部不可
   接入」，因此 Ollama 生成身份**永远**不合格，结果 `identity_not_validated` 安全留空；
   兼容端点与云端前缀仍按契约验收集判定（它们两侧强制同一答案契约）。**开关只决定「发不发
   请求」，不决定「降不降标准」**：按开关放行低质结果与地图决议冲突，不采用。
4. **默认关闭（Q6A）**：`generation_enabled`（线格式 snake_case、omit-if-default）默认
   `false`；关着时运行时在端口之前就闸掉（本地与云端零调用），Lua 侧根本不写
   `mode:generation`。设置权威在服务端：即便 Lua 文件写成开启，sidecar 仍按自己的设置判定。
5. **词条必须在词库里（#6 Q11）**：生成结果要同时通过成员（候选列表里确有该文本）、读音
   （候选 preedit 归一化后与本次拼音一致）、音节对齐（按撇号分段全切分，`xi'an ≠ xian`）与
   长度（1..32 字、CJK）四道校验，任一失败即留空；不造词、不改词库、不代用户提交。运行时读音
   与音节的证据就是候选 preedit——RIME 候选的 preedit 本来就是该词条的码。
6. **生成请求故意不带候选列表**：把候选送进去会把生成退化成选择、并让质量口径失真；但词库成员
   校验需要词库，所以 Lua 在生成模式下把候选窗口摊到 `min(#candidates, 255)`（选择模式仍只送
   一页，因为选择模式的编号必须是显示编号），`mode` 也进候选指纹。

## 后果

- `pnpm verify` 从 378 条涨到 415 条：`tests/generation-domain.test.ts`（20 条，域层判别与
  词库内校验）、`tests/generation-mode.test.ts`（14 条，通道/服务层：请求体、身份、闸门、
  缓存隔离）、`tests/lua-filter.test.ts` 13 → 16 条（真 Lua 载荷被运行时接受、一页之外的编号
  不被认、开关切换作废旧答案）。
- 与冻结原型（`reference/.scratch/rime-model-predict/runs/wf26/generation_contract.py`）的有意
  偏离：不发送 `request_id`/`context_revision`/`range`（身份由运行时信封与
  `settings_revision`/`candidate_fingerprint` 承担）；user 内容用项目既有的
  `defaultSeparators` 编码而非原型的手写 JSON；参考读音切分由运行时按拼音现算后作为
  `reference_pinyin` 送出，只作参考、不规定唯一解释。
- 生成能否默认打开不再由代码开关决定，而由「补一条已验收组合 + 改默认值」的评测结论决定：
  在 #13 的口径下需要三次一致复跑的留出集证据与新冻结资产，本票只接收结论、不重写评测资产。
