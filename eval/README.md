# 评测资产（issue #12 交付）

留出集与三次一致复跑 rig。对应地图 #1 子票 #12「评测资产建设」；消费方为 #13（模型与策略候选实验）与 #6（交付门槛冻结）。

## 组成

- `holdout/samples.jsonl` — 冻结留出集，102 样本/行（canonical compact JSON，逐行 sha256 记入 manifest）。
- `holdout/manifest.json` — 冻结口径：schema 词库身份（repo/commit/逐文件 sha256）、配额计数、样本哈希清单、语料决定。
- `holdout/threshold.json` — **草案阈值**（`frozen: false`）：仅用于验证 rig 机制；正式数值由 #6 冻结后替换并置 `frozen: true`。
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

## rig 判分语义（与既有基线一致）

- `hit` 生成词与目标精确相等；`wrong` 过校验但不等；`blank` 未过白名单校验（CJK/长度/读音音节）→ 安全留空；`unsup` 协议层拒绝（不可整切/非纯小写字母），不发请求；`error` 传输或响应形状失败。
- 门槛按 schema 分别计算（候选外命中率 / 命中率 / 留空率 / 错误率），**两个 schema 全部满足才判达标**。
- 三次复跑：结论（二值判定）三次一致才成立；同时记录逐例稳定率作诊断。

## 对后续票的接口

- #13 的真实模型实验：写一个 `transport: {kind:"http", endpoint}` 的 arm 配置（本地兼容 /api/chat），直接复用本 rig；模型 × 提示/解码策略 = 一份 arm 配置。
- #6 冻结门槛后替换 `threshold.json` 并置 `frozen: true`；在那之前的所有 rig 结论都是 draft。
- 变更留出集内容（增删样本、改目标）必须走 `eval:build` 重建并重新冻结哈希；直接手改 samples.jsonl 会被 `eval:check` 拒绝。
