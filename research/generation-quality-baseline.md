# 04 生成质量基线与模型对照实验

- 对应 issue：CometDash77/RIME-PredictInput#6（wayfinder 地图 #1 子票「04 生成质量达标路线与交付门槛」）。结论供 #6 的门槛决策、#7（完整架构与不降级验收）以及后续「评测资产建设」「模型与策略候选实验」票消费。
- 证据边界：本文只记录**本机真实模型实测**的原始结果与既有冻结基线，不含推测。实验只覆盖模型层与提示/解码策略层；「生成 → 校验 → 插入 → 提交」的机械通路沿用 issue #26 / wf26 的既有结论，本次未重测。
- 原始证据：本地 gitignored 目录 `reference/.scratch/rime-model-predict/runs/`（`.gitignore:2` 忽略 `reference/`，按地图 Notes 不作为公开发布内容）。本文是可在仓库内复核的摘要；数字标注来源文件。
- 复核：2026-10-07/08 由两个相互独立的调研任务产出（外部模型事实调研、本机模型对照实验），主会话逐条回读原始 json 复核承重数字。

## 1. 问题与决策依赖

#6 要回答的是：在「固定 2B 直接生成已失败」这一前提下，生成质量能否、以及以何种路线纳入完整重构的交付门槛。要成立必须先把三件事变成事实而不是愿望：

1. 既有失败到底发生在哪一层——机械通路，还是模型语义能力；
2. 「换个更大的同类模型」是否是一条真实可走的质量路线；
3. 现有评测资产（11 例 / 120 条）是否有足够判别力支撑任何「达标 / 不达标」的结论。

## 2. 冻结基线（既定事实，非本次实验产物）

### 2.1 wf26 冻结 11 例（`runs/wf26/cases.json`，2861 B）

| id | 上文（preceding_text） | 输入 | 目标 | 备注 |
|---|---|---|---|---|
| homophone-food | 午饭想吃热乎的包子，我要 | baozi | 包子 | 同音歧义对照 |
| homophone-spore | 显微镜下能看到真菌释放的 | baozi | 孢子 | 同音歧义（语境要求"孢子"） |
| polyphone | 这条小河的水慢慢 | zhanggao | 涨高 | **唯一** `target_outside_complete_list=true` |
| split-city | 我要去陕西省的省会 | xian | 西安 | 分词歧义 |
| empty-context | （空） | nihao | 你好 | 可确认空上文 |
| outside-a | 童话里的猫说：今晚的雨不是水，而是 | lansexuehua | 蓝色雪花 | 名字叫 outside，仅指不在 5 项候选页内 |
| outside-b | 请记住这个虚构装置名称： | liangzichabei | 量子茶杯 | 同上 |
| sentence | 日记里写下今天出门时的感觉： | jintiantianqihenhao | 今天天气很好 | 长拼音多字 |
| abbreviation | 我向朋友问好： | nh | — | 协议层 `unsupported_input` |
| unfinished | 我向朋友问好： | nihaom | — | 协议层 `unsupported_input` |
| mixed | 请打开项目： | nihaoPython | — | 协议层 `unsupported_input` |

后三条在发请求之前就被拒（合法音节切分不成立），任何模型都不会为它们发 HTTP。**所有分母都是 8**。

口径修正（本次复核发现）：`outside-a` / `outside-b` 的 `target_outside_complete_list` 在冻结记录中均为 `false`——蓝色雪花与量子茶杯实际分别落在 28 项 / 121 项的**完整**普通候选集合内，`outside` 仅表示「不在 5 项候选页内」。因此这 11 例中真正能证明「生成词典外文字」这一核心收益的，**只有 polyphone（涨高）一例**。

### 2.2 wf26 四臂对照（模型固定为 2B）

`runs/wf26/repair-v2/`（`repair_holdout.json` 于对照前冻结）：

| 臂 | 精确命中 | 候选外命中 |
|---|---|---|
| baseline-v1（旧 system/完整内部 request） | 2/8 | — |
| lean-v2（精简 system + 上文/待转换拼音/合法音节切分投影） | 3/8 | — |
| examples-v2（lean + 四组冻结 few-shot） | 5/8 | polyphone |
| coverage-v2（examples + 汉字范围/合法音节数 format pattern） | 5/8 | polyphone |

三次独立运行结果一致（2/3/5/5），非采样噪声。`selection.json` 落 `selected_policy: null` / `no_qualifying_policy`、退出码 1；门槛（≥6/8 且修好 homophone-spore）无一臂满足。**examples/coverage 各自达成过一次真实候选外目标并按第 5 位准确提交，说明机械通路成立，失败在模型语义层。**

### 2.3 旧选择器基线（`runs/wf21/trial-20261004/evaluation/`，120 条）

hit_rate 0.875、第 1 格基线 0.85、增益 +2.5pp、duplicate_rate 0.975、warm p50 129.8 ms / p90 152.86 ms、cold 2192.46 ms、`release_accepted=false`、`real_adoption_samples=0`。**关键限制：`ceiling=1.0` 且 `excluded_correct_absent=0`——120 条中无一例目标落在普通候选之外**，物理上测不到生成能力的核心收益，只能作候选内对照。

## 3. 本次对照实验设计（wf27）

- 目的：只回答一个问题——把模型换成本机已有的更大同类权重，能否越过 wf26 的质量线。
- 变量：模型（唯一变量）× 提示/解码臂。请求体与 wf26 历史 `chat_body` **72/72 逐字段一致，唯一差异是 `model` 字段**（`prompt-fidelity.md`）；`temperature=0`、`seed=19`、每格单次采样；判分器 `wf27_validate.py` 是 wf26 `generation_contract.py` 的逐字镜像。
- 规模：3 模型 × 3 臂 × 8 可请求例 = 72 次带 HTTP 调用。
- 隔离：另起私有 `ollama serve` 监听 127.0.0.1:21434（`OLLAMA_MODELS` 指向用户模型库、`KEEP_ALIVE=60s`），**未 pull / 未删除 / 未新建任何模型**，用户 11434 服务全程存活未被触碰；未改 RIME / Weasel / schema / 词库 / userdb；结束终止私有进程，`listeners_after=[]`、端口拒绝连接、`residual_private_pids=[]`。
- 环境：Windows x64；RTX 5060（8151 MiB 显存）；31.2 GB 内存；16 逻辑核；Ollama 0.40.0。

对照模型（本机已装，digest 即身份）：

| 角色 | 模型 | digest | 体积 |
|---|---|---|---|
| 对照（现固定） | hf.co/HauhauCS/Qwen3.5-2B-Uncensored-HauhauCS-Aggressive:Q4_K_M | cd456f1426678928580e118d505d2aafc5baaabbc50126312c92e8479b2c571a | 1.94 GB |
| 候选（更大同类） | hf.co/HauhauCS/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive:Q4_K_M | 4310275f6cc70ead50de05572c74f4fd0abff2037fa9aeabce0358f38853a659 | 3.38 GB |
| 容量下限 | hf.co/mradermacher/Huihui-Qwen3.5-0.8B-abliterated-GGUF:Q4_K_M | 6811ecb827b0d4c19d65e7461a292b69aa40b2333a2b46b75206bd335c9d34b1 | 643 MB |

## 4. 结果

### 4.1 精确命中与失败分布（`_runs/<model>/arm-summary.json`）

| 模型 | 臂 | 精确命中 | wrong_ready | no_result | invalid_response | 候选外命中 | core_success |
|---|---|---|---|---|---|---|---|
| 2B | baseline-v1 | 2/8 | 1 | 0 | 8 | — | false |
| 2B | examples-v2 | 5/8 | 1 | 0 | 5 | polyphone | true |
| 2B | coverage-v2 | 5/8 | 1 | 0 | 5 | polyphone | true |
| 4B | baseline-v1 | 4/8 | 2 | 0 | 5 | — | false |
| 4B | examples-v2 | 5/8 | 1 | 0 | 5 | polyphone | true |
| 4B | coverage-v2 | 5/8 | 1 | 0 | 5 | polyphone | true |
| 0.8B | baseline-v1 | 0/8 | 0 | 0 | 11 | — | false |
| 0.8B | examples-v2 | 2/8 | 0 | 0 | 9 | — | false |
| 0.8B | coverage-v2 | 2/8 | 0 | 0 | 9 | — | false |

`invalid_response` 含 3 条协议层不请求的用例；`no_result` 全表为 0。

### 4.2 速度（`speed.md`；热口径与 wf26 可比——排除首次调用后的 7 条中位）

| 模型 | 臂 | 首次调用（含加载） | 热请求中位 | 生成 tok/s |
|---|---|---|---|---|
| 2B | baseline-v1 / examples-v2 / coverage-v2 | 2225 / 189 / 121 ms | 106.2 / 99.6 / 119.9 ms | 198.1 / 224.6 / 193.4 |
| 4B | 同上 | 4285 / 306 / 175 ms | 168.9 / 170.3 / 162.9 ms | 113.5 / 113.0 / 115.0 |
| 0.8B | 同上 | 1985 / 167 / 104 ms | 106.4 / 94.7 / 105.8 ms | 306.6 / 294.4 / 249.1 |

### 4.3 逐例观察

- 2B 三臂结果（2 / 5 / 5）与 wf26 历史 `arms.json` 完全一致，且**三臂各 11/11 逐例文本与 wf26 原始记录逐字一致（diffs=none）**，速度落在历史 ±10% 内——对照复现成立，且比历史更严。
- 4B 相对 2B 的增益**只出现在 baseline-v1（2/8 → 4/8，多命中 empty-context、outside-a）**；在两条被刻意调优过的臂（examples-v2 / coverage-v2）上**完全同分 5/8**。
- homophone-spore（包子/孢子）在 3 模型 × 3 臂共 9 组里**全数失败**（均输出"包子"，忽略"真菌…细胞"语境）；唯一候选外例 polyphone（涨高）只在 2B/4B 的 examples/coverage 命中。
- 0.8B 的失败模式与 2B/4B 不同：baseline-v1 下 11/11 全部 invalid（模型容量/格式遵循不足），而非语境错——**容量下限是被证否的一端**。
- done_reason 全为 `stop`，无拒答、无空回复。

## 5. 结论

1. **「换更大的同类模型」在本机可选范围内被证否。** 4B（+74% 体积）在两条调优臂上质量零收益（同 5/8），代价是热延迟 1.6–1.8×（109 → 175 ms 量级）、生成吞吐 ≈0.5×（198 → 113 tok/s）、首次加载 2225 → 4285 ms。
2. **机械通路不是瓶颈，语义质量是。** 通路已两次被独立证明可正确完成「候选外生成 → 校验 → 按位插入 → 提交」（wf26 polyphone、wf27 polyphone），失败集中在同音/语境消歧。
3. **11 例资产没有判别力。** 分母 8、每例 12.5pp、每格单次采样；真正候选外样本只有 1 例。任何关于「哪个模型/哪种提示能达标」的结论都必须等独立留出集建好（≥100 例、其中候选外 ≥30 例）才能作出。
4. **本机没有官方非 abliterated 权重**（`/api/tags` 四模型：HauhauCS 2B/4B、Huihui 0.8B、bge-m3），因此「质量差是否由权重复改(abliteration)导致」这一问在本次无法回答；公开文献只支持消融会引起可测量漂移，且**没有任何中文词级/同音消歧研究**可用。wf26 的 2/8–5/8 **不可归因**给 abliteration。

## 6. 未覆盖与不确定性

- `lean-v2` 臂未跑（历史 3/8）；历史无 4B 基线，只能与 2B 对照比。
- 每格单次采样，无方差估计；分母 8 ⇒ 2/8 → 4/8 接近噪声量级。
- 只测模型层；「按键阻断 / 停手到可选」的端到端延迟未在本轮重测（沿用 wf26：合法热结果 263–325 ms、冷 5037 ms、空闲释放 60.10 s）。
- 未测 9B 档驻留可行性（8 GB 显存边缘）。
- 外部模型事实部分经镜像站点检索（huggingface.co / github.com 直连被阻断），**否定性结论的置信度低于肯定性结论**。

## 7. 对地图与后续票的约束

- #6 的门槛不能由模型可达性倒推：候选外命中若定在绝对门槛，**当前任何可用模型都不达标**，须按既定规则走"生成功能默认关闭/实验性随包发布"。
- 评测资产建设是**前置**而不是并行项：留出集必须先于任何模型/策略候选实验冻结。
- 若要区分"权重复改的锅"与"2B 容量本身的锅"，唯一干净对照是官方同基座权重 `qwen3.5:2b`（2.7 GB，需维护者手工 pull；插件永不自动下载）。

## 8. 复现材料（本地 gitignored）

`reference/.scratch/rime-model-predict/runs/wf27-model-compare/`：

- `summary.md`（102 行中文汇总，含 coverage-v2 与 baseline-v1 逐例对照与复现性交叉校验）、`speed.md`（速度口径与 wf26 的定义对齐说明）、`prompt-fidelity.md`（72/72 请求体逐字段一致性证明）、`resource-recycle.json` / `resource-recycle.md`（隔离与回收证明）。
- `wf27_run.py`（驱动）、`wf27_validate.py`（判分，wf26 `generation_contract.py` 逐字镜像）、`wf27_fidelity.py`、`wf27_speed.py`、`wf27_recycle_proof.py`、`start-private-ollama.ps1` / `stop-private-ollama.ps1`。
- `_runs/model-2b|model-4b|model-08b/<arm>.responses.jsonl`（原始请求体 + 原始响应 + 判分）与 `<arm>.records.json`、`arm-summary.json`。

上游基线：`runs/wf26/cases.json`、`runs/wf26/repair-v2/`（四臂）、`runs/wf21/trial-20261004/evaluation/`（旧选择器 120 条）。
