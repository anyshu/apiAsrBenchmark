import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  BenchAttemptRecord,
  BenchProviderSummary,
  BenchRunSummary,
} from '../domain/types.js';
import { persistRunToSqlite } from './sqliteStore.js';

export interface FinalizeRunArtifactsInput {
  runId: string;
  mode: 'once' | 'duration';
  createdAt: string;
  providerIds: string[];
  inputPath: string;
  rounds: number;
  durationMs?: number;
  concurrency?: number;
  intervalMs?: number;
  attempts: BenchAttemptRecord[];
  runDir: string;
  dbPath?: string;
}

export async function finalizeRunArtifacts(input: FinalizeRunArtifactsInput): Promise<BenchRunSummary> {
  const attemptsPath = path.join(input.runDir, 'attempts.jsonl');
  await fs.writeFile(
    attemptsPath,
    input.attempts.map((item) => JSON.stringify(item)).join('\n') + '\n',
    'utf8',
  );

  const providerSummaries = buildProviderSummaries(input.attempts);
  const csvPath = path.join(input.runDir, 'summary.csv');
  await fs.writeFile(csvPath, toCsv(input.attempts), 'utf8');

  const successCount = input.attempts.filter((item) => item.success).length;
  const latencyValues = input.attempts.map((item) => item.latency_ms);
  const rtfValues = input.attempts
    .map((item) => item.rtf)
    .filter((value): value is number => value !== undefined);
  const retryValues = input.attempts.map((item) => item.retry_count);
  const evaluatedAttempts = input.attempts.filter((item) => item.evaluation);
  const werValues = evaluatedAttempts
    .map((item) => item.evaluation?.word_error_rate)
    .filter((value): value is number => value !== undefined);
  const cerValues = evaluatedAttempts
    .map((item) => item.evaluation?.char_error_rate)
    .filter((value): value is number => value !== undefined);

  const summary: BenchRunSummary = {
    run_id: input.runId,
    mode: input.mode,
    created_at: input.createdAt,
    provider_ids: input.providerIds,
    input_path: input.inputPath,
    rounds: input.rounds,
    duration_ms: input.durationMs,
    concurrency: input.concurrency,
    interval_ms: input.intervalMs,
    attempt_count: input.attempts.length,
    success_count: successCount,
    failure_count: input.attempts.length - successCount,
    attempts_path: attemptsPath,
    summary_path: path.join(input.runDir, 'summary.json'),
    csv_path: csvPath,
    database_path: input.dbPath ? path.resolve(input.dbPath) : undefined,
    average_latency_ms:
      input.attempts.length > 0
        ? Math.round(input.attempts.reduce((sum, item) => sum + item.latency_ms, 0) / input.attempts.length)
        : undefined,
    p50_latency_ms: percentile(latencyValues, 50),
    p90_latency_ms: percentile(latencyValues, 90),
    p95_latency_ms: percentile(latencyValues, 95),
    average_rtf:
      rtfValues.length > 0
        ? roundTo3(rtfValues.reduce((sum, value) => sum + value, 0) / rtfValues.length)
        : undefined,
    total_retry_count: retryValues.reduce((sum, value) => sum + value, 0),
    average_retry_count:
      retryValues.length > 0
        ? roundTo3(retryValues.reduce((sum, value) => sum + value, 0) / retryValues.length)
        : undefined,
    evaluated_attempt_count: evaluatedAttempts.length,
    average_wer:
      werValues.length > 0 ? roundTo3(werValues.reduce((sum, value) => sum + value, 0) / werValues.length) : undefined,
    average_cer:
      cerValues.length > 0 ? roundTo3(cerValues.reduce((sum, value) => sum + value, 0) / cerValues.length) : undefined,
    failure_type_counts: buildFailureTypeCounts(input.attempts),
    provider_summaries: providerSummaries,
  };

  await fs.writeFile(summary.summary_path, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  if (input.dbPath) {
    await persistRunToSqlite({
      dbPath: input.dbPath,
      summary,
      attempts: input.attempts,
    });
  }

  return summary;
}

export async function writeRawAttemptArtifact(
  rawDir: string,
  attemptId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await fs.writeFile(path.join(rawDir, `${attemptId}.json`), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export function buildProviderSummaries(attempts: BenchAttemptRecord[]): BenchProviderSummary[] {
  const groups = new Map<string, BenchAttemptRecord[]>();

  for (const attempt of attempts) {
    const group = groups.get(attempt.provider_id) ?? [];
    group.push(attempt);
    groups.set(attempt.provider_id, group);
  }

  return Array.from(groups.entries())
    .map(([providerId, group]) => {
      const successCount = group.filter((item) => item.success).length;
      const retryValues = group.map((item) => item.retry_count);
      const evaluatedAttempts = group.filter((item) => item.evaluation);
      const werValues = evaluatedAttempts
        .map((item) => item.evaluation?.word_error_rate)
        .filter((value): value is number => value !== undefined);
      const cerValues = evaluatedAttempts
        .map((item) => item.evaluation?.char_error_rate)
        .filter((value): value is number => value !== undefined);

      return {
        provider_id: providerId,
        attempt_count: group.length,
        success_count: successCount,
        failure_count: group.length - successCount,
        average_latency_ms:
          group.length > 0
            ? Math.round(group.reduce((sum, item) => sum + item.latency_ms, 0) / group.length)
            : undefined,
        p50_latency_ms: percentile(group.map((item) => item.latency_ms), 50),
        p90_latency_ms: percentile(group.map((item) => item.latency_ms), 90),
        p95_latency_ms: percentile(group.map((item) => item.latency_ms), 95),
        average_rtf: averageRtf(group),
        total_retry_count: retryValues.reduce((sum, value) => sum + value, 0),
        average_retry_count:
          retryValues.length > 0
            ? roundTo3(retryValues.reduce((sum, value) => sum + value, 0) / retryValues.length)
            : undefined,
        evaluated_attempt_count: evaluatedAttempts.length,
        average_wer:
          werValues.length > 0 ? roundTo3(werValues.reduce((sum, value) => sum + value, 0) / werValues.length) : undefined,
        average_cer:
          cerValues.length > 0 ? roundTo3(cerValues.reduce((sum, value) => sum + value, 0) / cerValues.length) : undefined,
        failure_type_counts: buildFailureTypeCounts(group),
      };
    })
    .sort((a, b) => a.provider_id.localeCompare(b.provider_id));
}

export function toCsv(attempts: BenchAttemptRecord[]): string {
  const header = [
    'attempt_id',
    'run_id',
    'provider_id',
    'audio_id',
    'audio_path',
    'audio_duration_ms',
    'round_index',
    'started_at',
    'finished_at',
    'latency_ms',
    'rtf',
    'success',
    'request_attempts',
    'retry_count',
    'http_status',
    'error_type',
    'wer',
    'cer',
    'reference_text',
    'text',
  ];

  const rows = attempts.map((attempt) => [
    attempt.attempt_id,
    attempt.run_id,
    attempt.provider_id,
    attempt.audio_id,
    attempt.audio_path,
    attempt.audio_duration_ms ? String(attempt.audio_duration_ms) : '',
    String(attempt.round_index),
    attempt.started_at,
    attempt.finished_at,
    String(attempt.latency_ms),
    attempt.rtf !== undefined ? String(attempt.rtf) : '',
    String(attempt.success),
    String(attempt.request_attempts),
    String(attempt.retry_count),
    attempt.http_status ? String(attempt.http_status) : '',
    attempt.error?.type ?? '',
    attempt.evaluation?.word_error_rate !== undefined ? String(attempt.evaluation.word_error_rate) : '',
    attempt.evaluation?.char_error_rate !== undefined ? String(attempt.evaluation.char_error_rate) : '',
    attempt.evaluation?.reference_text ?? '',
    attempt.normalized_result?.text ?? '',
  ]);

  return [header, ...rows].map((row) => row.map((value) => csvEscape(value)).join(',')).join('\n') + '\n';
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

export function buildFailureTypeCounts(attempts: BenchAttemptRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const attempt of attempts) {
    if (!attempt.error?.type) {
      continue;
    }
    counts[attempt.error.type] = (counts[attempt.error.type] ?? 0) + 1;
  }
  return counts;
}

export function averageRtf(attempts: BenchAttemptRecord[]): number | undefined {
  const values = attempts.map((attempt) => attempt.rtf).filter((value): value is number => value !== undefined);
  if (values.length === 0) {
    return undefined;
  }
  return roundTo3(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function roundTo3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function createAttemptRecord(params: {
  attemptId: string;
  runId: string;
  providerId: string;
  audioId: string;
  audioPath: string;
  audioDurationMs?: number;
  roundIndex: number;
  startedAt: string;
  finishedAt: string;
  latencyMs: number;
  success: boolean;
  requestAttempts?: number;
  retryCount?: number;
  httpStatus?: number;
  error?: BenchAttemptRecord['error'];
  normalizedText?: BenchAttemptRecord['normalized_result'];
  evaluation?: BenchAttemptRecord['evaluation'];
}): BenchAttemptRecord {
  return {
    attempt_id: params.attemptId,
    run_id: params.runId,
    provider_id: params.providerId,
    audio_id: params.audioId,
    audio_path: params.audioPath,
    audio_duration_ms: params.audioDurationMs,
    round_index: params.roundIndex,
    started_at: params.startedAt,
    finished_at: params.finishedAt,
    latency_ms: params.latencyMs,
    rtf:
      params.audioDurationMs && params.audioDurationMs > 0
        ? roundTo3(params.latencyMs / params.audioDurationMs)
        : undefined,
    success: params.success,
    request_attempts: params.requestAttempts ?? 1,
    retry_count: params.retryCount ?? 0,
    http_status: params.httpStatus,
    error: params.error,
    normalized_result: params.normalizedText,
    evaluation: params.evaluation,
  };
}
