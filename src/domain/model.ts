/**
 * 模型身份的事实来源。
 *
 * 默认模型与它的 digest 同时被策略层（提示词/采样）与设置层（用户可选模型名）引用，
 * 之前散落在两个模块里各写一份字面量，改一处就会让身份计算失效。
 */
export const DEFAULT_MODEL = "hf.co/HauhauCS/Qwen3.5-2B-Uncensored-HauhauCS-Aggressive:Q4_K_M";

/** 已实测模型的完整摘要；标签可变，摘要不可变。 */
export const MODEL_DIGEST = "cd456f1426678928580e118d505d2aafc5baaabbc50126312c92e8479b2c571a";
