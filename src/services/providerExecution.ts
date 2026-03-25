import type {
  AsrProviderAdapter,
  ProviderConfig,
  ProviderExecutionEnvelope,
  ProviderRequestInput,
} from '../domain/types.js';

export async function executeWithRetry(
  adapter: AsrProviderAdapter,
  input: ProviderRequestInput,
): Promise<ProviderExecutionEnvelope> {
  const maxAttempts = Math.max(1, input.provider.retry_policy?.maxAttempts ?? 1);
  const backoffMs = Math.max(0, input.provider.retry_policy?.backoffMs ?? 0);
  const retryHistory: ProviderExecutionEnvelope['retryHistory'] = [];
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;
    const result = await adapter.execute(input);

    if (result.ok || !result.error?.retriable || attempt >= maxAttempts) {
      return {
        result,
        requestAttempts: attempt,
        retryCount: attempt - 1,
        retryHistory,
      };
    }

    retryHistory.push({
      attempt,
      statusCode: result.statusCode,
      error: result.error,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
    });

    await sleep(computeBackoff(backoffMs, attempt));
  }

  throw new Error('executeWithRetry reached an unreachable state');
}

export function resolveProviderConcurrency(provider: ProviderConfig, globalConcurrency?: number): number {
  return Math.max(1, provider.runner_options?.concurrency ?? globalConcurrency ?? 1);
}

export function resolveProviderIntervalMs(provider: ProviderConfig, globalIntervalMs?: number): number {
  return Math.max(0, provider.runner_options?.interval_ms ?? globalIntervalMs ?? 0);
}

function computeBackoff(baseBackoffMs: number, attempt: number): number {
  if (baseBackoffMs <= 0) {
    return 0;
  }
  return baseBackoffMs * 2 ** Math.max(0, attempt - 1);
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}
