# RIME-PredictInput

RIME 模型预测插件的 **TypeScript strict** 实现：替换原来的 Python 伴随进程，
保持 Weasel/RIME 侧的文件 IPC、候选第 5 位插入、设置页与隐私约束不变。

状态：**迁移完成，待真机验收**。核心行为由旧实现生成的行为快照锁定
（`tests/fixtures/oracle.json`），`tsc --noEmit` 与 354 条测试全绿。

## 快速开始

```
pnpm install
pnpm verify        # tsc --noEmit（app + tests） + vitest
pnpm build         # 产出 dist/
pnpm selftest      # 离线自检（需要先 build）
```

伴随进程入口：`node dist/cli/main.js`（`--source lua|settings`、`--idle-seconds`、
`--token`、`--migrate-settings`），设置入口：`node dist/cli/main.js settings`。

## 文档

- 领域词汇与规则：[CONTEXT.md](./CONTEXT.md)
- 新架构、模块关系与测试地图：[docs/architecture/project-map.md](./docs/architecture/project-map.md)
- 重构过程与剩余技术债：[docs/refactor-record.md](./docs/refactor-record.md)
- 架构决定：[docs/adr/](./docs/adr/)
- 工作区约定、Issue tracker、域文档：[AGENTS.md](./AGENTS.md) 与 `docs/agents/`
- 产品目标与必须保持的行为：GitHub Issue tracker 中的 map issue
- 旧实现与运行证据：`reference/`（本地材料，不随仓库发布）
