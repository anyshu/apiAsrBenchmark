import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BenchAttemptRecord, BenchRunSummary } from '../domain/types.js';
import { loadProvidersConfig, resolveProviderSecrets } from '../config/loadProviders.js';
import { DefaultProviderSwitcher } from '../providers/switcher.js';
import { collectAudioAssets } from '../utils/audio.js';
import { createAttemptRecord, finalizeRunArtifacts, writeRawAttemptArtifact } from './benchmarkArtifacts.js';

export interface RunOnceOptions {
  configPath: string;
  providerIds: string[];
  inputPath: string;
  rounds?: number;
  outputRoot?: string;
}

export async function runOnce(options: RunOnceOptions): Promise<BenchRunSummary> {
  const providersFile = await loadProvidersConfig(options.configPath);
  const selectedProviders = providersFile.providers.filter((provider) =>
    options.providerIds.includes(provider.provider_id),
  );

  if (selectedProviders.length !== options.providerIds.length) {
    const missing = options.providerIds.filter(
      (providerId) => !selectedProviders.some((provider) => provider.provider_id === providerId),
    );
    throw new Error(`Providers not found: ${missing.join(', ')}`);
  }

  const rounds = options.rounds ?? 1;
  if (rounds < 1) {
    throw new Error('rounds must be >= 1');
  }

  const providers = selectedProviders.map((provider) => resolveProviderSecrets(provider));
  const audioAssets = await collectAudioAssets(options.inputPath);
  const switcher = new DefaultProviderSwitcher();
  const createdAt = new Date().toISOString();
  const runId = `run_${createdAt.replace(/[:.]/g, '-')}__${crypto.randomUUID().slice(0, 8)}`;
  const runDir = path.resolve(options.outputRoot ?? 'artifacts/runs', runId);
  const rawDir = path.join(runDir, 'raw');
  await fs.mkdir(rawDir, { recursive: true });

  const attempts: BenchAttemptRecord[] = [];

  for (const provider of providers) {
    const adapter = switcher.resolve(provider);
    await adapter.validateConfig(provider);

    for (let roundIndex = 1; roundIndex <= rounds; roundIndex += 1) {
      for (const audio of audioAssets) {
        const executionResult = await adapter.execute({ provider, audio });
        const latencyMs =
          new Date(executionResult.finishedAt).getTime() - new Date(executionResult.startedAt).getTime();
        const attemptId = `${provider.provider_id}__${audio.audio_id}__r${roundIndex}`;
        await writeRawAttemptArtifact(rawDir, attemptId, {
          provider_id: provider.provider_id,
          audio_id: audio.audio_id,
          round_index: roundIndex,
          execution_result: executionResult,
        });

        const attempt: BenchAttemptRecord = createAttemptRecord({
          attemptId,
          runId,
          providerId: provider.provider_id,
          audioId: audio.audio_id,
          audioPath: audio.path,
          audioDurationMs: audio.duration_ms,
          roundIndex,
          startedAt: executionResult.startedAt,
          finishedAt: executionResult.finishedAt,
          latencyMs,
          success: executionResult.ok,
          httpStatus: executionResult.statusCode,
          error: executionResult.error,
        });

        if (executionResult.ok) {
          attempt.normalized_result = await adapter.normalize({
            provider,
            executionResult,
          });
        }

        attempts.push(attempt);
      }
    }
  }

  return finalizeRunArtifacts({
    runId,
    mode: 'once',
    createdAt,
    providerIds: providers.map((provider) => provider.provider_id),
    inputPath: path.resolve(options.inputPath),
    rounds,
    attempts,
    runDir,
  });
}
