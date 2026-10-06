/** 缓存与队列的容量上限：三个模块共用同一份事实。 */
export const DEFAULT_CACHE_ENTRIES = 256;

/** `inference.submit` 的排队上限，超出后新引擎直接收到 prediction_busy。 */
export const MAX_QUEUED_PREDICTIONS = 16;
