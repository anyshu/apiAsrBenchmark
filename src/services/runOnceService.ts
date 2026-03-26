import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BenchAttemptRecord, BenchRunSummary } from '../domain/types.js';
import { loadProvidersConfig, resolveProviderSecrets } from '../config/loadProviders.js';
import { DefaultProviderSwitcher } from '../providers/switcher.js';
import { collectAudioAssets } from '../utils/audio.js';
import { createAttemptRecord, finalizeRunArtifacts, writeRawAttemptArtifact } from './benchmarkArtifacts.js';
import { applyDatasetManifest } from './datasetManifest.js';
import { executeWithRetry, ExecutionCancelledError } from './providerExecution.js';
import { attachReferenceTexts, evaluateTranscript } from './references.js';

export interface RunOnceOptions {
  configPath: string;
  providerIds: string[];
  providerApiKeys?: Record<string, string>;
  inputPath: string;
  rounds?: number;
  outputRoot?: string;
  dbPath?: string;
  manifestPath?: string;
  referenceSidecar?: boolean;
  referenceDir?: string;
  shouldStop?: () => boolean;
  onAttemptComplete?: (context: {
    attempt: BenchAttemptRecord;
    completedAttempts: number;
    totalAttempts: number;
    retryHistory: Array<{
      attempt: number;
      statusCode?: number;
      error?: BenchAttemptRecord['error'];
      startedAt: string;
      finishedAt: string;
    }>;
  }) => void;
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

  const providers = selectedProviders.map((provider) =>
    resolveProviderSecrets(provider, options.providerApiKeys?.[provider.provider_id]),
  );
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

  const attempts: BenchAttemptRecord[] = [];
  const totalAttempts = providers.length * rounds * audioAssets.length;

  for (const provider of providers) {
    const adapter = switcher.resolve(provider);
    await adapter.validateConfig(provider);

    for (let roundIndex = 1; roundIndex <= rounds; roundIndex += 1) {
      for (const audio of audioAssets) {
        if (options.shouldStop?.()) {
          return finalizeRunArtifacts({
            runId,
            mode: 'once',
            createdAt,
            providerIds: providers.map((item) => item.provider_id),
            inputPath: path.resolve(options.inputPath),
            rounds,
            attempts,
            runDir,
            dbPath: options.dbPath,
          });
        }

        let execution;
        try {
          execution = await executeWithRetry(adapter, { provider, audio }, { shouldStop: options.shouldStop });
        } catch (error) {
          if (error instanceof ExecutionCancelledError) {
            return finalizeRunArtifacts({
              runId,
              mode: 'once',
              createdAt,
              providerIds: providers.map((item) => item.provider_id),
              inputPath: path.resolve(options.inputPath),
              rounds,
              attempts,
              runDir,
              dbPath: options.dbPath,
            });
          }
          throw error;
        }
        const executionResult = execution.result;
        const latencyMs =
          new Date(executionResult.finishedAt).getTime() - new Date(executionResult.startedAt).getTime();
        const attemptId = `${runId}__${provider.provider_id}__${audio.audio_id}__r${roundIndex}`;

        await writeRawAttemptArtifact(rawDir, attemptId, {
          provider_id: provider.provider_id,
          audio_id: audio.audio_id,
          round_index: roundIndex,
          execution_result: executionResult,
          retry_history: execution.retryHistory,
        });

        let normalizedResult: BenchAttemptRecord['normalized_result'];
        let evaluation: BenchAttemptRecord['evaluation'];

        if (executionResult.ok) {
          normalizedResult = await adapter.normalize({
            provider,
            executionResult,
          });
          if (audio.reference_text) {
            evaluation = evaluateTranscript(audio.reference_text, normalizedResult.text);
          }
        }

        const attempt: BenchAttemptRecord = createAttemptRecord({
          attemptId,
          runId,
          providerId: provider.provider_id,
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
          totalAttempts,
          retryHistory: execution.retryHistory,
        });
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
    dbPath: options.dbPath,
  });
}
