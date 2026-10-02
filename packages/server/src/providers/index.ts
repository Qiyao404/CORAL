import type { ChatProvider, ProviderConfig } from './types.js';
import { normalizeProviderId } from './types.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { AnthropicProvider } from './anthropic.js';
import type { RetryPolicy } from './retry.js';

/** M1-1：provider 工厂 — 按 profile.provider 实例化对应实现 */
export function createProvider(config: ProviderConfig, retryPolicy: RetryPolicy): ChatProvider {
  const provider = normalizeProviderId(config.provider);
  if (provider === 'anthropic') {
    return new AnthropicProvider(config, retryPolicy);
  }
  return new OpenAICompatProvider(config, retryPolicy);
}

export * from './types.js';
export { withRetry, classifyProviderError, jitterDelayMs } from './retry.js';
export type { RetryPolicy } from './retry.js';
