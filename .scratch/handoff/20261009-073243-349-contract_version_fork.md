# 交接：#20 contract_version 实现中断（改动已落盘未验证）＋ #19 fork 证据已核

## 一句话状态

正在实现 #20（S7 冻结 contract_version）：TS 契约与 FileIpc 的改动**已写入工作树但未跑任何验证**，oracle 生成器与测试**尚未修改**；#19（S1）已核实 CometDash77/weasel fork 真实存在（非本会话创建），但无 predict-0.17.4 分支、无 0.17.4 tag，交付远未完成。工作树不干净，直接接手前先读完本文件。

## 已冻结的契约决定（不要重开）

- 新常量 `CONTRACT_VERSION = 1`（src/contracts/envelope.ts:19），与旧 `PROTOCOL_VERSION = 1` 语义分离：旧 version = 消息结构版本，contract_version = Lua 与 sidecar 共同接受的文件契约版本。
- 字段位置：请求与响应正文 JSON 中 `contract_version` 紧随 `version`（键序 version, contract_version, engine_id, ...）；**ready 标记不加字段**，响应正文加字段后 ready 的 `bytes`/`sha256` 自然变化。
- 兼容规则：请求侧未知/缺失/类型错误一律 `err("unsupported request envelope")`（复用既有错误码，未新增）；响应侧一律 `null`（槽位作废 → Lua 看到留空）。不建运行时协商、不自动降级。
- 过期响应：本次顺手补齐 `RESPONSE_MAX_AGE_SECONDS = 60` 门控（`created_at > now+1` 或 `now-created_at > 60` → null）。这与 Lua 基线 60s 规则对齐；注意**旧 Python sidecar 读侧没有过期检查**，这是对旧行为的有意增强，须在 ADR 里写明，勿声称与旧实现逐字节一致。
- `responseWire` 签名已改为**不接受** contractVersion 输入，直接输出常量；调用方（file-ipc.ts:303、tests 两处）无需传参。

## 工作树现状（git status 仅这两个文件有改动）

1. `src/contracts/envelope.ts`（+19/-1）：CONTRACT_VERSION/RESPONSE_MAX_AGE_SECONDS 常量；RequestEnvelope/ResponseRecord 加 contractVersion 字段；parseRequest 在 version 检查后加 contract_version 严格相等检查（:88-90）；parseResponseRecord 加 contract_version 检查（:207）+ 新第 4 参 `now`（默认 Date.now()/1000）+ created_at 过期门控（:216-218）；requestWire/responseWire 输出 contract_version。
2. `src/ipc/file-ipc.ts`（+8/-3）：import CONTRACT_VERSION；publishRequest 的 envelope 加 contractVersion（:227）；readSlot 加 now 参数并透传（:114,126）；#readLatest 调用 `readSlot(..., this.#now())`（:400）。
3. `reference/runtime-baseline/sidecar/model_predict/ipc.py` 曾被改过又**已完整恢复原样**（grep CONTRACT_VERSION|contract_version 为空）。该目录在 .gitignore（`reference/`），是只读旧基线，**此后一律不许再改**；新契约基线通过 oracle 生成器适配层实现。

## 立即要做的编辑（按序，全部未做）

### 1. tools/oracle/dump_fixtures.py（未动，行号基于当前文件）

目标：不碰旧 Python 基线，生成器输出统一加 contract_version 适配层。具体：

- 文件顶部 import 后加常量与两个 helper：
```python
CONTRACT_VERSION = 1

def with_contract(envelope):
    """Legacy envelope gains the frozen contract field right after version."""
    if isinstance(envelope, dict) and "version" in envelope and "contract_version" not in envelope:
        rebuilt = {}
        for key, value in envelope.items():
            rebuilt[key] = value
            if key == "version":
                rebuilt["contract_version"] = CONTRACT_VERSION
        return rebuilt
    return envelope
```
- `request_case`（:55-58）改为：raw 用 `with_contract(envelope)` 序列化；成功时 `result["value"] = with_contract(result["value"])`（否则 TS requestWire 输出与 oracle value 键数不等，测试炸）。
- `make_request`（:121-129）的 envelope 在 "version" 行后加 `"contract_version": ipc.PROTOCOL_VERSION,`。
- main 里 `base_request`（:706-714）在 "version": 1 后加 `"contract_version": 1,`；request_cases 新增 4 条**专用拒答用例**（旧 Request.parse 不认 contract_version，capture 结果会与 TS 行为冲突，所以 result 必须手写，不走 capture）：
```python
def contract_reject_case(name, envelope):
    raw = json.dumps(envelope, ensure_ascii=False, separators=(",", ":")).encode()
    return {"name": name, "raw": raw.decode(),
            "result": {"ok": False, "code": "unsupported request envelope"}}

contract_reject_cases = [
    contract_reject_case("contract_version_unknown", {**base_request, "contract_version": 2}),
    contract_reject_case("contract_version_missing", {k: v for k, v in base_request.items() if k != "contract_version"}),
    contract_reject_case("contract_version_string", {**base_request, "contract_version": "1"}),
    contract_reject_case("contract_version_bool", {**base_request, "contract_version": True}),
]
```
  document 的 `"requests"`（:864）改为 `[request_case(name, envelope) for name, envelope in request_cases] + contract_reject_cases`。
- responses 段（:747-808）旧 FileIpc 产出的字符串需后处理：`request_files`/`request_bytes_fractional` 的 JSON 注入字段；`response_files`/`response_bytes_fractional` 的 response JSON 注入字段后**重算对应 .ready 的 bytes/sha256**（body 文本 encode("utf-8") 后 len/sha256，注意 Python hexdigest 与 TS sha256Hex 一致）；`read_latest`/`read_latest_fractional` 是 dict，直接 with_contract。写一个 `contract_json(text)` helper（json.loads → with_contract → 紧凑 dumps），ready 重算用 `hashlib`。
- 跑 `python tools/oracle/dump_fixtures.py`（或 `cmd /c "pnpm fixtures 2>&1"`），然后 `git diff tests/fixtures/oracle.json` 确认**只有** requests/responses 段的 contract_version 注入 + 4 条新用例 + ready bytes/sha256 变化；inference/runtime/policy/decision 段必须零漂移。

### 2. 测试修复（不改则全红）

- `tests/inference.test.ts:152-160` 与 `tests/cloud-channels.test.ts:382-390` 的手写 makeRequest JSON：version 行后加 `contract_version: 1,`（parseRequest 现在会拒没有该字段的请求）。
- `tests/oracle-ipc.test.ts`：responseWire 两处调用（:150-157、:270-278）签名已兼容不用改；建议 import CONTRACT_VERSION 并在 :86 后加 `expect(published.contractVersion).toBe(CONTRACT_VERSION);`。新增行为测试（放同一文件末尾）：
  - 未知/缺失/字符串 contract_version 的响应文件 → `readLatestResponse` 返回 null。做法：publishResponse 正常写完后，用 writeFileSync 重写 response-a.json（键序 version, contract_version, engine_id, ...），重算并重写 response-a.ready（bytes/sha256 用 re-export 的 sha256Hex 或 node:crypto）。
  - 过期响应：把 created_at 改成 now-120 → null；created_at 改成 now+30（超 +1s 容差）→ null。FileIpc 构造支持 `now` 注入（:196），新 Ipc 实例传固定时钟可确定性断言。
- `src/cli/selftest.ts:79-82`：在现有 `{"version":9}` 检查后补一行 `parseRequest(new TextEncoder().encode('{"version":1}'))` 也必须 err "unsupported request envelope"（缺 contract_version）。

### 3. 文档

- 新建 `docs/adr/0005-ipc-contract-version.md`：记录上面"已冻结的契约决定"全部四条 + 版本升级流程（只能新票 + oracle 基线更新）+ 过期门控是有意增强的说明。#20 验收第一条明确要求字面值/位置/编码/兼容规则进协议说明。
- `docs/architecture/project-map.md` 测试地图数量与 README 的旧 210 表述：verify 全绿后按实际数字改。

## 验证（全部未跑，不得声称通过）

```
cmd /c "pnpm fixtures 2>&1"      # 生成器改完先跑，确认 oracle diff 最小
cmd /c "pnpm verify 2>&1"        # tsc ×2 + vitest
cmd /c "pnpm build 2>&1" && cmd /c "pnpm selftest 2>&1"
```
PowerShell 直接跑 pnpm 会被执行策略拦，用 cmd /c 或 pnpm.cmd。

## #19 S1 的外部证据（已核实，写票用）

- `gh repo view CometDash77/weasel --json ...` → `{"isFork":true,"parent":{"login":"rime","name":"weasel"},"defaultBranchRef":"master","visibility":"PUBLIC"}`；master HEAD `d73f6295e8252ed2f7b9c12bae32e9001b1afdaa`。
- `gh repo fork rime/weasel --clone=false` 返回 `CometDash77/weasel already exists`——fork **不是本会话创建的**（会话开始时 view 还 404，中途出现；勿声称由本会话建立）。
- fork 现有分支：legacy（ce48ad18）、master（d73f6295）、revert-1499-fix_status（935dc990）；**没有** 0.17.4 tag、**没有** predict-0.17.4 分支。
- #19 剩余交付：从上游 0.17.4（tag object `f53a92543f2ef890503d0391e595af8fa9abdb02`）建 predict-0.17.4 分支、上游构建/打包链干净环境复现、sha256 manifest、Release 模板（binary/source tag/upstream base/四项改动预留/GPL 源码义务）、librime 零改动边界验证、Win10/11 x64 前置条件记录。
- gh api 偶发 `TLS handshake timeout`（两次），重试即可；`--org CometDash77` 会 422（用户账号非组织）。

## 票务状态

- #19/#20 open，均已 `deck_issue_report` 上报"开始实现"（链上各 1 条）。#19 blocking #21/#22/#23/#26/#29；#20 blocking #29。父票 #18 open；地图 #1 open。
- 收口顺序：#20 在 verify+build+selftest 全绿后 → 更新 #20 进度段（含真跑数字）+ 决议评论 → `deck_issue_patch {key:"20", close:true}` → 再次 report。Lua 侧"未知版本留空"的可运行实现不在本仓库（reference 是忽略的旧基线），票内注明该语义已由 TS 响应槽位作废（null→留空）锁死，Lua 接入实现归 S5（#24），不要为凑验收伪造 Lua 代码。
- #20 关闭后读回 #18 正文再整体更新其进度段（deck_issue_patch 的 body 是整体替换）；#19 保持 open，进度段写 fork 证据 + 缺口。
- 活动 goal：`goal-0c577b7e-4f07-44f2-8759-757c15ee9d2e`（objective = 完成 #20 并推进 #19；新会话如需续用先 get_goal 再 resume）。

## 工具坑（本会话实踩）

- tools.edit 批量序列调用：**一条失败后面的不执行，但前面已执行的不会回滚**——每批后必须读回确认；old_string 必须全文唯一。
- edit 前先 read（fs 观察策略强制）；改 issue 正文前先 deck_issue_get 读回（body 整体替换）。
- `gh repo fork <repo> --clone=false --remote=false` 参数互斥报错；正确形态只有 `--clone=false`。

## 红线与纪律

- `reference/` 与 `.scratch/`（handoff 豁免）不提交；`reference/runtime-baseline` 本会话已误改又已还原，提交前 `git status` 确认它不在变更列表。
- `eval/holdout`、`threshold.json` 冻结；不碰用户 RIME 数据/Ollama；不自动下载模型。
- 一切"验证通过"必须来自本轮实跑输出；issue 进度只写有证据的行。
- 提交惯例：分支 research/native-integration（HEAD 71c45ae），handoff 文件随 docs 提交，提交后推送。

## 建议技能（新会话按需 Skill 调用）

- `executing-plans`（按本文件顺序收尾）、`verification-before-completion`（声称完成前必载）、`ponytail`（full，抑制过度设计）、`system-engineering-practice`（跨 TS/Python-oracle/Lua-fork 边界时）、`codebase-design`（若需调整接缝措辞）。
- to-spec/to-tickets 已完成（#18/#19–#30），本轮不需要。
