import type {
  AsrProviderAdapter,
  ProviderConfig,
  ProviderExecutionEnvelope,
  ProviderRequestInput,
} from '../domain/types.js';

export class ExecutionCancelledError extends Error {
  constructor(message = 'execution cancelled') {
    super(message);
    this.name = 'ExecutionCancelledError';
  }
}

export async function executeWithRetry(
  adapter: AsrProviderAdapter,
  input: ProviderRequestInput,
  options: {
    shouldStop?: () => boolean;
  } = {},
): Promise<ProviderExecutionEnvelope> {
  const maxAttempts = Math.max(1, input.provider.retry_policy?.maxAttempts ?? 1);
  const backoffMs = Math.max(0, input.provider.retry_policy?.backoffMs ?? 0);
  const retryHistory: ProviderExecutionEnvelope['retryHistory'] = [];
  let attempt = 0;

  while (attempt < maxAttempts) {
    if (options.shouldStop?.()) {
      throw new ExecutionCancelledError();
    }

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

    await sleep(computeBackoff(backoffMs, attempt), options.shouldStop);
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

async function sleep(ms: number, shouldStop?: () => boolean): Promise<void> {
  if (ms <= 0) {
    return;
  }

  const sliceMs = Math.min(200, ms);
  let remainingMs = ms;
  while (remainingMs > 0) {
    if (shouldStop?.()) {
      throw new ExecutionCancelledError();
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(sliceMs, remainingMs)));
    remainingMs -= sliceMs;
  }
}
