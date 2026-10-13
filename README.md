# RIME-PredictInput

RIME 模型预测插件的 **TypeScript strict** 实现：替换原来的 Python 伴随进程，
保持 Weasel/RIME 侧的文件 IPC、候选第 5 位插入、设置页与隐私约束不变。

状态：**迁移完成，待真机验收**。核心行为由旧实现生成的行为快照锁定
（`tests/fixtures/oracle.json`），`tsc --noEmit` 与 488 条测试全绿（487 通过 + 1 跳过）。

## 快速开始

```
pnpm install
pnpm verify        # tsc --noEmit（app + tests） + vitest
pnpm build         # 产出 dist/
pnpm selftest      # 离线自检（需要先 build）
```

伴随进程入口：`node dist/cli/main.js`（`--source lua|settings`、`--idle-seconds`、
`--token`、`--migrate-settings`），设置入口：`node dist/cli/main.js settings`。

## 发布合规

自有代码按 **MIT** 授权（[LICENSE](./LICENSE)）；随产物分发的第三方组件在构建期从安装树读出，
逐条声明在 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。发布前：

```
pnpm build
pnpm release:notices -- --write        # 依赖或运行时换版本后刷新声明
pnpm release:stage                     # 把 LICENSE 与声明放进 dist/release/
pnpm release:check -- --tag v0.1.0     # 必须 PASS，否则不许发布
```

`release:check` 会核对许可证正文、第三方声明与安装树一致、凭据/个人数据扫描、发布物清单，
以及两份 Release notes 模板（[主仓库](./docs/release-notes-template.md) /
[fork](./docs/fork/release-template.md)）的必备内容；结论归档在
`dist/release-archive/release-report.json` 与 `licenses.json`。判据与理由见
[docs/adr/0009-release-compliance-gate.md](./docs/adr/0009-release-compliance-gate.md)。

## 文档

- 领域词汇与规则：[CONTEXT.md](./CONTEXT.md)
- 新架构、模块关系与测试地图：[docs/architecture/project-map.md](./docs/architecture/project-map.md)
- 重构过程与剩余技术债：[docs/refactor-record.md](./docs/refactor-record.md)
- 架构决定：[docs/adr/](./docs/adr/)
- 发布合规（许可证、凭据扫描、Release notes 模板）：[docs/adr/0009-release-compliance-gate.md](./docs/adr/0009-release-compliance-gate.md)
- 安装器构建与当前限制：[docs/installer-build.md](./docs/installer-build.md)；正式 fork release 输入与 S11 真机验收尚待完成，工程候选禁用安装。
- 工作区约定、Issue tracker、域文档：[AGENTS.md](./AGENTS.md) 与 `docs/agents/`
- 产品目标与必须保持的行为：GitHub Issue tracker 中的 map issue
- 旧实现与运行证据：`reference/`（本地材料，不随仓库发布）
