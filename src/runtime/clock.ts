/** 单调时钟与休眠，便于在测试里注入确定的时间。 */

export function monotonicSeconds(): number {
  return performance.now() / 1000;
}

export function sleepSeconds(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000));
}
