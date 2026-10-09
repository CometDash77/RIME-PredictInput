# ADR 0005：文件 IPC 契约版本 contract_version——信封演进的第二维度

- 状态：已采纳（2026-10-09，issue #20；冻结决定：CONTRACT_VERSION 与 PROTOCOL_VERSION 语义分离、contract_version 键序紧随 version、ready 标记不加字段、60 秒过期门控为有意增强）
- 背景：文件 IPC 信封此前只有 `version` 一个版本维度，而信封的线上字节形态被 oracle fixture 逐字节冻结——Lua 侧、旧 sidecar、新实现三方读写同一批字节。文件契约本身要演进时（本票给信封加契约门控），没有第二维度就无法表达「协议版本未变、文件契约已变」。旧 sidecar 的 Request.parse 逐字段取值、忽略未知顶层键，无法被教会拒绝缺 contract_version 的信封——门控只能由新实现执行，fixture 手写用例锁定。

## 决定

1. **双常量分离**：`CONTRACT_VERSION = 1` 与 `PROTOCOL_VERSION = 1` 各自独立。RequestEnvelope 与 ResponseRecord 增加 `contractVersion` 字段；`requestWire`/`responseWire` 输出常量 `contract_version` 紧随 `version`——键序即冻结验收面。
2. **请求侧硬门控**：`parseRequest` 在 version 校验之后检查 `contract_version === CONTRACT_VERSION`，未知/缺失/类型错一律 `err("unsupported request envelope")`——与 version 不符共用同一错误码，调用方只看一个失败原因。
3. **响应侧软门控**：`parseResponseRecord` 对正文做同一检查，不符返回 `null`（调用方跳过该槽位，与旧实现吞异常的行为同形）。
4. **就绪标记不加字段**：`readyMarkerWire` 保持 `version,seq,ts,bytes,sha256` 五键；正文变化由 bytes/sha256 自然体现，标记结构不随契约演进。
5. **60 秒过期门控（有意增强）**：`parseResponseRecord` 拒绝 `created_at > now+1` 或 `now-created_at > RESPONSE_MAX_AGE_SECONDS(60)` 的响应，返回 `null`。旧实现无此检查——这是新实现的有意收紧；测试注入固定时钟锁定边界（`created_at = now+1` 恰在容差内被接受）。
6. **fixture 再生策略**：oracle 生成器用 `with_contract` 给旧 sidecar 录制的信封注入 `contract_version`（插在 `version` 后），成功用例的 `result.value` 同步注入；4 条 contract 拒答用例手写 `result`（旧实现不拒、无法录制）；response 正文注入后重算对应 `.ready` 的 bytes/sha256。runtime 段的 pid/request_id 是引擎每次运行新生成的非确定值，再生必变，不算语义漂移。

## 后果

- 单向不兼容：旧 sidecar 写出的请求（无 contract_version）被新实现拒收；新实现写出的信封带 `contract_version=1`，旧实现读它时忽略未知键、行为不变。文件契约从此可独立于协议版本演进，演进方负责 bump `CONTRACT_VERSION`。
- oracle fixture 的 requests/responses 段按新契约再生；inference/policy/decision/settings 段零漂移；runtime 段仅 pid/request_id 非确定值漂移。
- oracle-ipc 的 consume/stale/fractional 用例注入固定时钟（1001.25/1003/1001.25），过期门控下旧快照时间戳才可见；新增 2 条行为用例分别锁定 contract_version 门控与 60 秒过期。
