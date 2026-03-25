import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AudioAsset, BenchAttemptRecord, BenchRunSummary, ProviderConfig } from '../domain/types.js';
import { loadProvidersConfig, resolveProviderSecrets } from '../config/loadProviders.js';
import { DefaultProviderSwitcher } from '../providers/switcher.js';
import { collectAudioAssets } from '../utils/audio.js';
import { createAttemptRecord, finalizeRunArtifacts, writeRawAttemptArtifact } from './benchmarkArtifacts.js';
import { applyDatasetManifest } from './datasetManifest.js';
import {
  executeWithRetry,
  ExecutionCancelledError,
  resolveProviderConcurrency,
  resolveProviderIntervalMs,
} from './providerExecution.js';
import { attachReferenceTexts, evaluateTranscript } from './references.js';

export interface RunDurationOptions {
  configPath: string;
  providerIds: string[];
  inputPath: string;
  durationMs: number;
  concurrency?: number;
  intervalMs?: number;
  outputRoot?: string;
  dbPath?: string;
  manifestPath?: string;
  referenceSidecar?: boolean;
  referenceDir?: string;
  shouldStop?: () => boolean;
  onAttemptComplete?: (context: {
    attempt: BenchAttemptRecord;
    completedAttempts: number;
    elapsedMs: number;
    durationMs: number;
  }) => void;
}

interface ProviderTaskState {
  provider: ProviderConfig;
  audios: AudioAsset[];
  nextAudioIndex: number;
  roundCounts: Map<string, number>;
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

  const providers = selectedProviders.map((provider) => resolveProviderSecrets(provider));
  const catalogedAudioAssets = await applyDatasetManifest(await collectAudioAssets(options.inputPath), {
    inputPath: options.inputPath,
    manifestPath: options.manifestPath,
  });
  const audioAssets = await attachReferenceTexts(catalogedAudioAssets, {
    inputPath: options.inputPath,
    sidecar: options.referenceSidecar,
    referenceDir: options.referenceDir,
  });
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
  const states = providers.map<ProviderTaskState>((provider) => ({
    provider,
    audios: audioAssets,
    nextAudioIndex: 0,
    roundCounts: new Map<string, number>(),
  }));

  async function runProviderWorker(state: ProviderTaskState): Promise<void> {
    const adapter = switcher.resolve(state.provider);
    const intervalMs = resolveProviderIntervalMs(state.provider, options.intervalMs);

    while (Date.now() < deadlineMs && !options.shouldStop?.()) {
      const audio = nextAudio(state);
      if (!audio) {
        return;
      }

      const roundIndex = nextRoundIndex(state, audio);
      let execution;
      try {
        execution = await executeWithRetry(adapter, { provider: state.provider, audio }, { shouldStop: options.shouldStop });
      } catch (error) {
        if (error instanceof ExecutionCancelledError) {
          return;
        }
        throw error;
      }
      const executionResult = execution.result;
      const latencyMs =
        new Date(executionResult.finishedAt).getTime() - new Date(executionResult.startedAt).getTime();
      const attemptId = `${state.provider.provider_id}__${audio.audio_id}__r${roundIndex}`;

      await writeRawAttemptArtifact(rawDir, attemptId, {
        provider_id: state.provider.provider_id,
        audio_id: audio.audio_id,
        round_index: roundIndex,
        execution_result: executionResult,
        retry_history: execution.retryHistory,
      });

      let normalizedResult: BenchAttemptRecord['normalized_result'];
      let evaluation: BenchAttemptRecord['evaluation'];

      if (executionResult.ok) {
        normalizedResult = await adapter.normalize({
          provider: state.provider,
          executionResult,
        });
        if (audio.reference_text) {
          evaluation = evaluateTranscript(audio.reference_text, normalizedResult.text);
        }
      }

      const attempt = createAttemptRecord({
        attemptId,
        runId,
        providerId: state.provider.provider_id,
        audioId: audio.audio_id,
        audioPath: audio.path,
        audioDurationMs: audio.duration_ms,
        audioLanguage: audio.language,
        audioSpeaker: audio.speaker,
        audioTags: audio.tags,
        audioReferencePath: audio.reference_path,
        roundIndex,
        startedAt: executionResult.startedAt,
        finishedAt: executionResult.finishedAt,
        latencyMs,
        success: executionResult.ok,
        requestAttempts: execution.requestAttempts,
        retryCount: execution.retryCount,
        httpStatus: executionResult.statusCode,
        error: executionResult.error,
        normalizedText: normalizedResult,
        evaluation,
      });
      attempts.push(attempt);
      options.onAttemptComplete?.({
        attempt,
        completedAttempts: attempts.length,
        elapsedMs: Math.max(0, Date.now() - startedAtMs),
        durationMs: options.durationMs,
      });

      if (intervalMs > 0 && Date.now() < deadlineMs && !options.shouldStop?.()) {
        await sleep(intervalMs, options.shouldStop);
      }
    }
  }

  const workers = states.flatMap((state) =>
    Array.from({ length: resolveProviderConcurrency(state.provider, options.concurrency) }, () =>
      runProviderWorker(state),
    ),
  );

  await Promise.all(workers);

  const maxRound = attempts.reduce((max, attempt) => Math.max(max, attempt.round_index), 0);
  return finalizeRunArtifacts({
    runId,
    mode: 'duration',
    createdAt,
    providerIds: providers.map((provider) => provider.provider_id),
    inputPath: path.resolve(options.inputPath),
    rounds: maxRound,
    durationMs: options.durationMs,
    concurrency: options.concurrency,
    intervalMs: options.intervalMs,
    attempts,
    runDir,
    dbPath: options.dbPath,
  });
}

function nextAudio(state: ProviderTaskState): AudioAsset | undefined {
  if (state.audios.length === 0) {
    return undefined;
  }
  const audio = state.audios[state.nextAudioIndex % state.audios.length];
  state.nextAudioIndex += 1;
  return audio;
}

function nextRoundIndex(state: ProviderTaskState, audio: AudioAsset): number {
  const key = `${state.provider.provider_id}__${audio.audio_id}`;
  const roundIndex = (state.roundCounts.get(key) ?? 0) + 1;
  state.roundCounts.set(key, roundIndex);
  return roundIndex;
}

async function sleep(ms: number, shouldStop?: () => boolean): Promise<void> {
  if (ms <= 0) {
    return;
  }
  const sliceMs = Math.min(200, ms);
  let remainingMs = ms;
  while (remainingMs > 0) {
    if (shouldStop?.()) {
      return;
    }
    const waitMs = Math.min(sliceMs, remainingMs);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    remainingMs -= waitMs;
  }
}
