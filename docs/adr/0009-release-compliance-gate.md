# ADR 0009：发布合规 gate —— 判据进仓库、结论进归档

- 状态：已接受（S10/#27，2026-10-10）
- 相关：`docs/release-notes-template.md`、`docs/fork/release-template.md`、`docs/license/README.md`、`THIRD-PARTY-NOTICES.md`

## 背景

票 #27 要求「发布检查结果可作为机器可读清单归档，并在发布前阻止缺少许可证、版权、隐私扫描或源码链接的 release」。
这件事有两种做法：

1. 写一份人工 checklist（Markdown），发布前有人照着看一遍；
2. 把判据写成代码，发布前跑一遍，**跑不过就发不出去**，结果落成归档 JSON。

第一种做法的失效模式很具体：checklist 不会自己发现「今天新增的源文件里多了一个 `api_key`」，
也不会发现「第三方声明与安装树已经漂移了三周」。第二种必须付的代价是判据要跟着代码演进。

## 决定

**判据进仓库，结论进归档。** 具体四条：

### R1：判据是数据 + 纯函数，跑在注入文件系统之上

`src/release/credential-policy.ts` 里全是数据（词表、每条基线及其理由），
`credential-scan.ts` / `shipset.ts` / `release-notes.ts` 是纯函数，全部经由 `ReleaseFs` 注入面读文件。
因此每条判据都能在内存机器上离线重放——包括「故意放一份带作者路径的产物进去，gate 必须挡下」这种反例。

只证明「干净样本通过」不足以说明扫描器在工作；`credentials.harness` 检查因此强制要求
**同一套判据在假泄漏样本上必须报违规**。

### R2：凭据基线上界只许收紧，且上界必须等于实际计数

生产代码里出现凭据字样不是一律禁止：`settings.ts` 必须写出 `cloud.api_key` 才能拒绝它，
`cloud-wire.ts` 必须构造 `Authorization: Bearer` 请求头。所以判据是「**声明过的位置、声明的次数**」：
每条规则给出上界与理由，实际计数 `>` 上界（新增凭据字样）与 `<` 上界（悄悄删掉）**都算漂移**。
后者看着多余，其实是为了让基线不能烂在那儿——数字过期就等于没有基线。

规则没覆盖过的新文件默认上界为 0：`src/` 下任何 `.ts` 出现凭据字样都会挡下发布。
`secret` 这类英文常用词额外要求**赋值语境**（`secret:` / `"secret":` / `secret =`），
否则「拒绝凭据」的代码会把自己举报掉。

### R3：完成通知与诊断日志是硬边界，不是基线

票面点名「`cloud.api_key` 不能进日志、IPC 完成通知或发布物」。这两条出口的代码面很小
（`completion-notify.ts`、`weasel-messenger-koffi.ts`、`privacy-log.ts`），所以对它们不用基线而是**零容忍**：
一个凭据字样都不许出现。产物目录里的文本条目同样零容忍。

### R4：Release notes 的必备内容是判据，两份模板合并后校验

用户实际读到的是两份正文：fork 仓库的 Release（上游基底、GPL-3 源码义务）与主仓库的 Release
（sidecar 双变体、安装器、隐私声明、安装/卸载/手动全清/还原）。因此判据跑在**合并文本**上，
十一组内容缺一即挡下发布，并要求「源码义务清单」里的每条链接可点（fork tag、librime、本仓库 tag）。

## 后果

- 报告落在 `dist/release-archive/release-report.json`（逐条检查 + 证据 + 许可证清单 + 发布物摘要 + notes 判据），
  许可证详单另存 `dist/release-archive/licenses.json`。两者都在 `dist/` 下，不进 git，但**必须随发布归档**。
- `dist/release/` 是**发布物目录**（`LICENSE`、`THIRD-PARTY-NOTICES.md`，后续 S9 再加 exe/安装器）；
  发布工具自己的编译产物也在 `dist/release/*.js`，因此枚举产物目录时略过 `.js`/`.map`。
- 缺件（S9 打包后才会出现的条目）会让 gate 报告 `blocked`；这是**故意的**：S10 落地时这两项必须由
  `pnpm release:stage`（或 S9 的打包步骤）补齐，报告里逐条列出缺什么。
- 判据改动 = 代码改动，走普通 PR；`tests/release-*.test.ts` 覆盖每条判据的正反面。
- 不采用「警告放行」档位：既然发布是不可逆动作，gate 只有 `pass` / `blocked` 两种输出。
