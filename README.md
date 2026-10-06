# RIME-PredictInput

RIME 模型预测插件的 TypeScript 重构工作区。

当前状态：**架构与实现迁移进行中**。本仓库从 `reference/`（本地历史材料，不纳入版本控制）中的
既有 Python sidecar + Lua 滤镜实现出发，用 TypeScript strict 重新建立模块边界与契约，同时保持
已实现的外部行为不降级。

- 工作区约定、Issue tracker、域文档：见 [AGENTS.md](./AGENTS.md) 与 `docs/agents/`。
- 产品目标与必须保持的行为：见 GitHub Issue tracker 中的 map issue。
- 旧实现与运行证据：`reference/`（本地材料，不随仓库发布）。
