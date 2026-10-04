/**
 * M0-4：Provider 层错误分类学与重试策略（M1 providers 层的第一块砖）。
 *
 * 分类规则（修复 A5 前半 —「errorResult 恒 retryable:true」）：
 *  · abort     — 用户取消/超时中止，永不重试（定性由上层区分）
 *  · transient — 网络抖动 / 429 限流 / 408 / 5xx 服务端错误 → 可重试
 *  · permanent — 4xx 参数/鉴权/配额类、确定性错误 → 不可重试
 *  · 未知错误保守按 permanent 处理（避免对确定性错误空转）
 */

export type ProviderErrorKind = 'transient' | 'permanent' | 'abort';

export interface RetryPolicy {
  /** 重试次数（不含首次尝试） */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/** 429 从配额判定中分离（A3 的一部分）：限流是瞬时的，配额是持久性的 */
const TRANSIENT_STATUS: ReadonlySet<number> = new Set([408, 429]);

const NETWORK_HINT =
  /connection|timeout|econn|etimedout|enotfound|eai_again|econnreset|econnrefused|ehostunreach|enetunreach|socket hang up|fetch failed|network error/i;

export function classifyProviderError(err: any, signal?: AbortSignal): ProviderErrorKind {
  // 取消最先判定
  if (signal?.aborted || err?.name === 'AbortError' || err?.constructor?.name === 'APIUserAbortError') {
    return 'abort';
  }

  const status = typeof err?.status === 'number' ? err.status : undefined;
  if (status !== undefined) {
    if (TRANSIENT_STATUS.has(status)) return 'transient';
    if (status >= 500) return 'transient';
    if (status >= 400) return 'permanent'; // 401/402/403/404/422 ...
  }

  // openai SDK 的 APIConnectionError / APIConnectionTimeoutError 及 Node 网络错误码
  const nameAndMsg = `${err?.constructor?.name || ''} ${err?.name || ''} ${err?.message || ''}`;
  if (NETWORK_HINT.test(nameAndMsg)) return 'transient';

  return 'permanent';
}

/** 指数退避 + 抖动：第 attemptNo 次重试（0 起）延迟为计算值的 50%~100% */
export function jitterDelayMs(attemptNo: number, policy: RetryPolicy): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * Math.pow(2, attemptNo));
  return Math.round(exp * (0.5 + Math.random() * 0.5));
}

export interface WithRetryOptions {
  /** 默认全部可重试；传入分类器实现「abort/permanent 立即抛出」 */
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  /** 审查 P3：退避可被取消打断（取消后不再干等最长 8s） */
  signal?: AbortSignal;
}

/**
 * 带分类的通用重试执行器：
 *  · 可重试错误 → 退避（含抖动）后重试，最多 policy.maxRetries 次
 *  · 不可重试 / 重试耗尽 → 抛出最后一个错误
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  opts: WithRetryOptions = {}
): Promise<T> {
  const isRetryable = opts.isRetryable ?? (() => true);

  let lastErr: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= policy.maxRetries || !isRetryable(err)) {
        throw lastErr;
      }
      const delay = jitterDelayMs(attempt, policy);
      opts.onRetry?.(attempt + 1, delay, err);
      if (opts.signal?.aborted) throw asAbortIfPossible(lastErr);
      await new Promise(r => {
        const t = setTimeout(r, delay);
        opts.signal?.addEventListener('abort', () => { clearTimeout(t); r(void 0); }, { once: true });
      });
      if (opts.signal?.aborted) throw asAbortIfPossible(lastErr);
    }
  }
}

/** 取消打断重试时抛 AbortError（保持与 fn 内抛出同语义） */
function asAbortIfPossible(err: unknown): never {
  const e = new Error('aborted') as Error & { name: string };
  e.name = 'AbortError';
  throw e;
}

export function describeError(err: unknown): string {
  const e = err as any;
  if (e?.status) return `[HTTP ${e.status}] ${e?.message || ''}`.trim();
  return e?.message || String(err);
}
