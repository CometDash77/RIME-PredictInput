# 评测资产（issue #12 交付）

留出集与三次一致复跑 rig。对应地图 #1 子票 #12「评测资产建设」；消费方为 #13（模型与策略候选实验）与 #6（交付门槛冻结）。

## 组成

- `holdout/samples.jsonl` — 冻结留出集，102 样本/行（canonical compact JSON，逐行 sha256 记入 manifest）。
- `holdout/manifest.json` — 冻结口径：schema 词库身份（repo/commit/逐文件 sha256）、配额计数、样本哈希清单、语料决定。
- `holdout/threshold.json` — **已冻结门槛**（`frozen: true`，#6 冻结，2026-10-08）：数值见下「门槛冻结口径」。
- `fixtures/` — rig 自证用的确定性假传输臂（正臂全命中 → 判「达标」；负臂全垃圾 → 判「不达标」）。
- `../src/eval/` — 切分器、词库解析、候选集合计算、构建器与 rig 的 TypeScript 源码（随 `pnpm verify` 全量测试）。
- `.cache/`（gitignored）— 词库原文件、构建报告、rig 运行报告。

## 覆盖维度（102 例）

| 维度 | 数量 | 说明 |
|---|---|---|
| 候选外（outside-complete） | 36 | 目标不在任一 schema 的完整候选集合内（两库分别标注，均 ≥30） |
| 翻页（beyond-page） | 24 | 目标在完整集合内但位次在第 5 页之后（两库均验证） |
| 同音歧义 | 12 | 6 对同 pinyin 不同目标，语境消歧 |
| 长拼音 | 8 | 4-6 音节目标（成语为主） |
| 可确认空上文 | 8 | preceding_text 为空 |
| 长短句与短文 | 8 | 上文 40-300 字符 |
| 支持边界 | 6 | 协议层必须拒绝（缩写/残缺/混合输入），不发请求、安全留空 |

另有逐条断言：目标不出现在上文（防泄漏）；目标读音存在且音节数与输入匹配（白名单校验的构建期对应物）。

## 冻结口径（写死在 manifest）

1. **完整候选集合** = 该 schema 全部词库文件中、concatenated 码 == pinyin 的去重词条，weight 降序、同权重文本码点升序；候选页大小 5。该口径对齐 `research/generation-quality-baseline.md` 的实测基线（纯词条查询，不含运行时组词与用户词库学习）。
2. **样本哈希** = canonical compact JSON 行的 sha256；`pnpm eval:check` 逐行复核 + 词库缓存身份复核，任何漂移即拒绝运行。
3. **音节表**为冻结快照（`src/eval/syllables.ts`）；修订它等于修订评测口径，必须重建留出集。

## 语料来源与再分发边界（#12 HITL 决定）

- **纯合成**（YG 拍板，2026-10-08）：全部句子为该票新撰文本，逐条标注合成来源；仓库内自由分发，零第三方语料许可证负担、零个人数据。
- 与旧 120 条开发集（作者仓库文档语料）**无来源交集**，「同文档不跨集」由构造满足。
- 词库文件**不随仓库分发**：构建期从上游拉取到 gitignored 的 `.cache/dicts/`，仓库只保留来源、commit 与逐文件 sha256：
  - `iDvel/rime-ice` @ `da1fbe602e38…`（上游 GPL-3.0；仅本地评测用，不再分发）
  - `gaboolic/rime-frost` @ `8484901a0dc0…`（第三方词库；同上）
  - 重建评测环境时按 provenance.json 重新拉取即可。

## 命令

```bash
pnpm eval:build   # 用 .cache/dicts 词库构建并冻结留出集（先备好词库缓存）
pnpm eval:check   # 冻结校验：样本哈希 + 词库缓存身份
pnpm eval:run -- --arm eval/fixtures/arm-positive.json --runs 3   # 三次一致复跑
```

run 的退出码：`0` 达标 / `1` 不达标 / `2` 三次结论不一致（无结论）/ `3` 基建错误。`threshold.json` 的 `frozen=false` 时结论一律标注 draft。

## rig 判分语义（#6 冻结口径，2026-10-08）

- `hit` 生成词与目标精确相等（先过词库成员校验）；`wrong` 过全部校验但不等；`blank` 模型未给出可用词库词：空输出，或合法读音但词库无此词（**造词 → 安全留空**）；`mechanical` 机制错误（复读上文 / 非 CJK / 拼音残留 / 超长 / 读音不符）；`unsup` 协议层拒绝（不可整切/非纯小写字母）或词库不支持该输入（主 schema 完整候选集合为空，正确行为 = 静默），不发请求；`error` 传输或响应形状失败。
- **词库成员校验**：按主 schema（manifest schemas 首个 = rime-ice）的冻结词库执行，口径同 manifest 完整候选集合定义（concatenated code == pinyin 的词条）。
- 门槛按 schema 分别计算，**两个 schema 全部满足才判达标**（见下节数值）。
- 三次复跑：结论（二值判定）三次一致才成立；同时记录逐例稳定率作诊断。

## 门槛冻结口径（#6，YG 2026-10-08 点头）

- **词库内深位命中率 ≥60%**：目标在完整候选集合内、但位次在第 1 页之后（beyond_page）的子集上精确命中率；按 schema 分别计。口径依据：**模型只在词库内选择，绝不造词**（#6 Q11 定夺；原「候选外 ≥60%」子集据此改为词库内深位子集）。
- **留空率 ≤25%**：blank / total，unsup 不计入（结构性拒绝不是模型质量额度）。
- **机制错误硬 0**（`max_mechanical_rate: 0`）：出现任何 1 例即判不达标，算实现 bug 不算质量额度。
- **错误率 ≤15%**；**全局命中率不设门槛**（min_hit_rate = 0，候选内子集只作回归断言）。
- **延迟门槛（产品侧，不进 rig）**：按键阻断 0；热态「停手 → 第 5 位可选」median ≤400 ms / p90 ≤900 ms / max ≤1500 ms（≥30 样本）；冷态首次 ≤10 s 且期间留空不阻塞；硬截止 2 s 放弃留空；空闲 60 s 释放并实测复原。rig 报告的 cold/p50/p90 为推理请求口径延迟，供真机报告人工对账。
- **判定纪律（放宽版，Q10 定夺）**：结论来自冻结留出集上真实模型原始输出的 rig 复跑（默认 3 次一致）；调参不设流程门槛——改动模型/策略/判分后在同一冻结留出集上重跑即可，留出集字节不得改动（`eval:check` 把关）。

## 对后续票的接口

- #13 的真实模型实验：写一个 `transport: {kind:"http", endpoint}` 的 arm 配置（本地兼容 /api/chat），直接复用本 rig；模型 × 提示/解码策略 = 一份 arm 配置。
- #6 门槛已冻结（`frozen: true`）：rig 结论不再是 draft；数值与依据见「门槛冻结口径」。
- 变更留出集内容（增删样本、改目标）必须走 `eval:build` 重建并重新冻结哈希；直接手改 samples.jsonl 会被 `eval:check` 拒绝。

## 真实模型臂（issue #13）

`arms/` 下每份 JSON = 一个「模型 × 提示/解码策略」候选，`transport` 为 `{kind:"http", endpoint}`，指向私有 Ollama（127.0.0.1:21434，wf27 已验证的隔离模式：用户 11434 全程不触碰）。

**臂文案口径**：wf26 四臂的原文不在本工作区（`reference/` 为空），故按 `research/generation-quality-baseline.md` §2.2 的结构定义**在本票重新冻结**：`lean-v2`（精简 system + 上文/待转换拼音/合法音节切分投影）、`examples-v2`（lean + 4 组冻结 few-shot）、`coverage-v2`（examples + 汉字范围/合法音节数 format pattern）。与历史文案不保证逐字同源；few-shot 示例目标（汽水/遗迹/持之以恒/猫语屋）均不在留出集 target 集内，上文亦无交集，防泄漏由构造满足。臂配置加 `.gitattributes -text` 保字节稳定。

**模型身份**（冻结 digest；每次运行前用 `/api/tags` 核对，漂移即拒绝结论）：

| 模型 | digest | 角色 |
|---|---|---|
| `hf.co/HauhauCS/Qwen3.5-2B-Uncensored-HauhauCS-Aggressive:Q4_K_M` | `cd456f14…` | 现固定模型 |
| `hf.co/mradermacher/Huihui-Qwen3.5-0.8B-abliterated-GGUF:Q4_K_M` | `6811ecb8…` | 容量下限 |
| `qwen3.5:2b`（2.7GB Q8_0） | 官方库 | 同基座对照；**待 #6 Q12 用户点头后由维护者手工 pull**，未 pull 时驱动脚本自动跳过这 3 份臂 |

- 已证否不重跑：4B（wf27：examples/coverage 零收益 + 热延迟 1.6–1.8×）；9B 驻留判定手册见下。
- 采样全部冻结为 `temperature=0, seed=19, num_predict=32, num_ctx=2048`（rig SAMPLING_OPTIONS，臂内显式重申）；`think:false` 由 rig 传输层强制（Qwen3.5 系默认开思考，与产品决策路径及 Q5 白名单一致）。

### 在维护者机器上运行（目标档：RTX 5060 8GB + 已装权重，零下载）

```powershell
pnpm build                                          # 依赖已装时；否则先 pnpm install
powershell -NoProfile -ExecutionPolicy Bypass -File eval\scripts\start-private-ollama.ps1   # 私有 21434；OLLAMA_MODELS 指向用户模型库；KEEP_ALIVE=60s；核对 digest 输出
powershell -NoProfile -ExecutionPolicy Bypass -File eval\scripts\run-matrix.ps1             # 全部在场模型 × 3 臂 × 3 次复跑；缺席模型自动跳过
powershell -NoProfile -ExecutionPolicy Bypass -File eval\scripts\stop-private-ollama.ps1    # 停私有实例并证明无残留、11434 未被触碰
```

> 脚本按 Windows PowerShell 5.1 兼容编写并通过实测（UTF-8 读取、native stderr 容错、按端口回收证明）；pwsh 7 同样可用。管线验证记录：mock /api/tags + /api/chat 下 6 臂 × 3 次复跑全链路通过，缺席模型正确 SKIP，报告 JSON 与矩阵摘要落盘正常。

报告 JSON 落 `eval/.cache/reports/run-*.json`，矩阵摘要落 `matrix-*.txt`；`eval:run` 退出码 0 达标 / 1 不达标 / 2 三次不一致 / 3 基建错误。`threshold.json` 冻结前（`frozen:false`）所有结论一律 draft。

### 延迟口径与 9B 驻留判定

- rig 的 `cold/warm p50/p90` 是**推理请求口径**（HTTP 往返；run 1 首例含模型加载），不是「停手 → 第 5 位可选」端到端口径（后者归 #6 Q9 与实际窗口验收）。CPU 机器上跑出的延迟不得当目标档数据使用（Q3：延迟门槛只对 GPU ≥8GB 档冻结）。
- **9B 驻留判定**（`qwen3.5:9b`，6.6GB Q4_K_M，待维护者 pull）在目标机执行：pull 后以 `num_ctx 2048` 发起一次请求，随后查 `ollama ps` 的 `size_vram`——`size_vram == size` 即全 GPU 驻留（判定通过）；`size_vram < size` 即发生 CPU 回退（判定不驻留），同时记录加载时长与首个请求延迟。算术边界：8151 MiB 总显存 − 桌面占用约 0.6–1.0 GB − CUDA 上下文开销 ≈ 7.0–7.5 GB 可用，对 6.6 GB 权重属**边缘档**，实测即判定。
