/**
 * 单线程串行队列，替代旧实现的 `ThreadPoolExecutor(max_workers=1)`。
 *
 * 任务必须按提交顺序执行：上一次预测还在跑时不能开始下一次，否则两个进程内的模型
 * 调用会互相插队。取消只对还没开始的任务生效，与 `Future.cancel()` 一致。
 */
export interface QueuedTask<T> {
  readonly started: boolean;
  readonly settled: boolean;
  cancel(): void;
  readonly result: Promise<T>;
}

export class SerialQueue {
  #tail: Promise<void> = Promise.resolve();
  #generation = 0;

  run<T>(job: () => Promise<T>): QueuedTask<T> {
    const generation = this.#generation;
    const state = { started: false, settled: false, cancelled: false };
    const result = this.#tail
      .then(async (): Promise<T> => {
        if (state.cancelled || generation !== this.#generation) {
          throw new CancelledTask();
        }
        state.started = true;
        return job();
      })
      .finally(() => {
        state.settled = true;
      });
    // 队列尾部要吞掉异常，否则一个失败的任务会拦住后面所有任务。
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return {
      get started() {
        return state.started;
      },
      get settled() {
        return state.settled;
      },
      cancel() {
        state.cancelled = true;
      },
      result,
    };
  }

  /** 等价于 `shutdown(cancel_futures=True)` 里丢掉尚未开始的部分。 */
  cancelPending(): void {
    this.#generation += 1;
  }

  async drain(): Promise<void> {
    await this.#tail;
  }
}

/** 被取消的任务以这个异常结束；调用方按「没有结果」处理。 */
export class CancelledTask extends Error {
  constructor() {
    super("task cancelled");
    this.name = "CancelledTask";
  }
}
