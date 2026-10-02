/**
 * M0-3：外层取消信号 + 超时 deadline 的联动工具。
 *
 * 语义：
 *  · 外层信号 abort（用户取消）→ 内层信号 abort，timedOut = false
 *  · 超时到期（无外层取消）    → 内层信号 abort，timedOut = true
 *  · 两种情况共用同一套「中止在跑工作」机制（LLM HTTP 断开 / 子进程树强杀），
 *    由 timedOut 区分最终定性：超时 = 失败（可重试），外层取消 = cancelled
 *  · cleanup() 清理定时器与监听器，防泄漏
 */
export interface LinkedAbort {
  /** 传给下游（LLM 调用 / Skill 执行）的内层信号 */
  signal: AbortSignal;
  /** true 表示内层信号是由超时触发（而非外层取消） */
  readonly timedOut: boolean;
  /** 用完必须调用：清 timer、摘除外层监听 */
  cleanup(): void;
}

export function linkAbortWithTimeout(
  outerSignal: AbortSignal | undefined,
  timeoutMs: number
): LinkedAbort {
  const controller = new AbortController();
  let timedOut = false;

  const onOuterAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    cleanup() {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', onOuterAbort);
    },
  };
}
