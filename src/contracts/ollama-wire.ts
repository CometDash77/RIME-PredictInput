/**
 * Ollama 的 HTTP 响应形状。
 *
 * 这些都是外部输入：它们由别的进程决定，类型系统只能描述「我们期望什么」，
 * 所以每个 schema 都是运行时校验的唯一来源，解析结果再进入业务判断。
 * 解析策略刻意保持宽松——旧实现是「这一项不合规就跳过或用 unknown 代替」，
 * 而不是整包拒绝；本文件用 `.catch()` 把这个策略写进 schema 本身。
 */

import { z } from "zod";

import { HEX_64_ANY_CASE } from "../json/digest.js";

/** `GET /api/tags` 的单项：只有 `name` 是硬要求，其余缺失都退化成 "unknown"。 */
export const TagsItemSchema = z.looseObject({
  name: z.string(),
  digest: z.string().regex(HEX_64_ANY_CASE).optional().catch(undefined),
  details: z
    .looseObject({ format: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

export const TagsResponseSchema = z.looseObject({ models: z.array(z.unknown()) });

/** `GET /api/ps` 的单项：旧实现只关心已加载模型的名字与摘要。 */
export const LoadedItemSchema = z.looseObject({
  name: z.string().optional(),
  model: z.string().optional(),
  digest: z.string().optional().catch(undefined),
});

export const PsResponseSchema = z.looseObject({ models: z.array(z.unknown()) });

/** `POST /api/chat` 的回答：身份、完成原因与消息形状都必须明确对上。 */
export const ChatResponseSchema = z.looseObject({
  model: z.string(),
  done: z.literal(true),
  done_reason: z.literal("stop"),
  message: z.looseObject({
    role: z.literal("assistant"),
    content: z.string(),
    /** 思考模式必须关闭：接受思考内容会让固定提示词与策略身份不再成立。 */
    thinking: z.unknown().optional(),
  }),
});

export const VersionResponseSchema = z.looseObject({ version: z.string().optional() });

/** manifests 目录里的一个模型清单文件。 */
export const ManifestSchema = z.looseObject({
  config: z.looseObject({ digest: z.string() }),
  model_info: z
    .looseObject({ "general.architecture": z.string().optional() })
    .optional()
    .catch(undefined),
});

export type TagsItem = z.infer<typeof TagsItemSchema>;
export type LoadedItem = z.infer<typeof LoadedItemSchema>;
export type ChatResponse = z.infer<typeof ChatResponseSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
