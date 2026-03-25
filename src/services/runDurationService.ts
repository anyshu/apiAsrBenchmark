import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BenchAttemptRecord, BenchRunSummary, ProviderConfig } from '../domain/types.js';
import { loadProvidersConfig, resolveProviderSecrets } from '../config/loadProviders.js';
import { DefaultProviderSwitcher } from '../providers/switcher.js';
import { collectAudioAssets } from '../utils/audio.js';
import { createAttemptRecord, finalizeRunArtifacts, writeRawAttemptArtifact } from './benchmarkArtifacts.js';

export interface RunDurationOptions {
  configPath: string;
  providerIds: string[];
  inputPath: string;
  durationMs: number;
  concurrency?: number;
  intervalMs?: number;
  outputRoot?: string;
}

interface TaskItem {
  provider: ProviderConfig;
  audio: Awaited<ReturnType<typeof collectAudioAssets>>[number];
  roundIndex: number;
}

export async function runDuration(options: RunDurationOptions): Promise<BenchRunSummary> {
  if (options.durationMs < 1) {
    throw new Error('durationMs must be >= 1');
  }

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

  const concurrency = options.concurrency ?? 1;
  const intervalMs = options.intervalMs ?? 0;
  const providers = selectedProviders.map((provider) => resolveProviderSecrets(provider));
  const audioAssets = await collectAudioAssets(options.inputPath);
  const switcher = new DefaultProviderSwitcher();
  const createdAt = new Date().toISOString();
  const runId = `run_${createdAt.replace(/[:.]/g, '-')}__${crypto.randomUUID().slice(0, 8)}`;
  const runDir = path.resolve(options.outputRoot ?? 'artifacts/runs', runId);
  const rawDir = path.join(runDir, 'raw');
  await fs.mkdir(rawDir, { recursive: true });

  for (const provider of providers) {
    await switcher.resolve(provider).validateConfig(provider);
  }

  const attempts: BenchAttemptRecord[] = [];
  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + options.durationMs;
  let nextIndex = 0;

  const providerAudioPairs = providers.flatMap((provider) =>
    audioAssets.map((audio) => ({ provider, audio })),
  );
  const roundCounts = new Map<string, number>();

  async function getNextTask(): Promise<TaskItem | undefined> {
    const now = Date.now();
    if (now >= deadlineMs || providerAudioPairs.length === 0) {
      return undefined;
    }

    const pair = providerAudioPairs[nextIndex % providerAudioPairs.length];
    nextIndex += 1;
    const key = `${pair.provider.provider_id}__${pair.audio.audio_id}`;
    const roundIndex = (roundCounts.get(key) ?? 0) + 1;
    roundCounts.set(key, roundIndex);

    if (intervalMs > 0) {
      await sleep(intervalMs);
      if (Date.now() >= deadlineMs) {
        return undefined;
      }
    }

    return {
      provider: pair.provider,
      audio: pair.audio,
      roundIndex,
    };
  }

  async function worker(): Promise<void> {
    while (true) {
      const task = await getNextTask();
      if (!task) {
        return;
      }

      const adapter = switcher.resolve(task.provider);
      const executionResult = await adapter.execute({
        provider: task.provider,
        audio: task.audio,
      });
      const latencyMs =
        new Date(executionResult.finishedAt).getTime() - new Date(executionResult.startedAt).getTime();
      const attemptId = `${task.provider.provider_id}__${task.audio.audio_id}__r${task.roundIndex}`;

      await writeRawAttemptArtifact(rawDir, attemptId, {
        provider_id: task.provider.provider_id,
        audio_id: task.audio.audio_id,
        round_index: task.roundIndex,
        execution_result: executionResult,
      });

      const attempt = createAttemptRecord({
        attemptId,
        runId,
        providerId: task.provider.provider_id,
        audioId: task.audio.audio_id,
        audioPath: task.audio.path,
        audioDurationMs: task.audio.duration_ms,
        roundIndex: task.roundIndex,
        startedAt: executionResult.startedAt,
        finishedAt: executionResult.finishedAt,
        latencyMs,
        success: executionResult.ok,
        httpStatus: executionResult.statusCode,
        error: executionResult.error,
      });

      if (executionResult.ok) {
        attempt.normalized_result = await adapter.normalize({
          provider: task.provider,
          executionResult,
        });
      }

      attempts.push(attempt);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

  const maxRound = attempts.reduce((max, attempt) => Math.max(max, attempt.round_index), 0);
  return finalizeRunArtifacts({
    runId,
    mode: 'duration',
    createdAt,
    providerIds: providers.map((provider) => provider.provider_id),
    inputPath: path.resolve(options.inputPath),
    rounds: maxRound,
    durationMs: options.durationMs,
    concurrency,
    intervalMs,
    attempts,
    runDir,
  });
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}
