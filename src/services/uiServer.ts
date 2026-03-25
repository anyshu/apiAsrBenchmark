import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { URL } from 'node:url';
import type { BenchRunSummary } from '../domain/types.js';
import { loadProvidersConfig } from '../config/loadProviders.js';
import type { ProviderConfig } from '../domain/types.js';
import { runDuration } from './runDurationService.js';
import { runOnce } from './runOnceService.js';
import { exportRun } from './runQueryService.js';
import { getRunDetailFromSqlite, listRunsFromSqlite } from './sqliteStore.js';

export interface UiServerOptions {
  dbPath: string;
  configPath: string;
  host?: string;
  port?: number;
}

export interface RunningUiServer {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

interface RunSubmissionPayload {
  mode: 'once' | 'duration';
  providerIds: string[];
  inputPath: string;
  rounds?: number;
  durationMs?: number;
  concurrency?: number;
  intervalMs?: number;
  manifestPath?: string;
  referenceSidecar?: boolean;
  referenceDir?: string;
}

export interface RunSubmission {
  mode: 'once' | 'duration';
  providerIds: string[];
  inputPath: string;
  rounds: number;
  durationMs: number;
  concurrency?: number;
  intervalMs?: number;
  manifestPath?: string;
  referenceSidecar: boolean;
  referenceDir?: string;
}

interface RunValidationResult {
  ok: boolean;
  fieldErrors: Record<string, string>;
  value?: RunSubmission;
}

export interface UiRunJob {
  job_id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  created_at: string;
  started_at?: string;
  finished_at?: string;
  cancel_requested?: boolean;
  cancelled_at?: string;
  progress?: {
    completed_attempts: number;
    total_attempts?: number;
    progress_ratio?: number;
    elapsed_ms?: number;
    duration_ms?: number;
    current_attempt_id?: string;
    current_provider_id?: string;
    current_audio_id?: string;
    message?: string;
    retry_history?: Array<{
      attempt: number;
      statusCode?: number;
      error?: {
        type?: string;
        message?: string;
      };
      startedAt: string;
      finishedAt: string;
    }>;
  };
  request: RunSubmission;
  summary?: BenchRunSummary;
  error?: {
    message: string;
    field_errors?: Record<string, string>;
  };
}

export async function startUiServer(options: UiServerOptions): Promise<RunningUiServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 3000;
  const runJobs = new Map<string, UiRunJob>();

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', `http://${host}:${port}`);

      if (requestUrl.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(renderIndexHtml());
        return;
      }

      if (requestUrl.pathname === '/api/runs') {
        const limit = Number.parseInt(requestUrl.searchParams.get('limit') ?? '50', 10);
        const runs = await listRunsFromSqlite(options.dbPath, {
          limit: Number.isFinite(limit) ? limit : 50,
          providerId: requestUrl.searchParams.get('provider') ?? undefined,
          mode: (requestUrl.searchParams.get('mode') as 'once' | 'duration' | null) ?? undefined,
          hasFailures:
            requestUrl.searchParams.get('failures') === null
              ? undefined
              : ['yes', 'true', '1'].includes((requestUrl.searchParams.get('failures') ?? '').toLowerCase()),
          createdAfter: requestUrl.searchParams.get('created_after') ?? undefined,
          createdBefore: requestUrl.searchParams.get('created_before') ?? undefined,
          query: requestUrl.searchParams.get('query') ?? undefined,
        });
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ runs }, null, 2));
        return;
      }

      if (requestUrl.pathname === '/api/providers') {
        const providersFile = await loadProvidersConfig(options.configPath);
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ providers: providersFile.providers }, null, 2));
        return;
      }

      if (requestUrl.pathname === '/api/provider-capabilities') {
        const providersFile = await loadProvidersConfig(options.configPath);
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(
          JSON.stringify(
            {
              providers: providersFile.providers.map((provider) => describeProviderCapabilities(provider)),
            },
            null,
            2,
          ),
        );
        return;
      }

      if (requestUrl.pathname === '/api/demo-assets') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(
          JSON.stringify(
            {
              demo_provider_config: path.resolve('examples/demo-provider'),
              demo_manifest_path: path.resolve('examples/demo-dataset/dataset.manifest.json'),
              demo_input_path: path.resolve('examples/demo-dataset'),
            },
            null,
            2,
          ),
        );
        return;
      }

      if (requestUrl.pathname === '/api/jobs') {
        const limit = Number.parseInt(requestUrl.searchParams.get('limit') ?? '10', 10);
        const jobs = listRunJobs(runJobs, Number.isFinite(limit) ? limit : 10);
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ jobs }, null, 2));
        return;
      }

      const jobMatch = requestUrl.pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (jobMatch) {
        const job = runJobs.get(decodeURIComponent(jobMatch[1]));
        if (!job) {
          response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'job_not_found' }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ job }, null, 2));
        return;
      }

      const cancelMatch = requestUrl.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
      if (request.method === 'POST' && cancelMatch) {
        const job = runJobs.get(decodeURIComponent(cancelMatch[1]));
        if (!job) {
          response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'job_not_found' }));
          return;
        }
        if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
          response.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'job_already_finished', job }, null, 2));
          return;
        }
        job.cancel_requested = true;
        job.progress = {
          completed_attempts: job.progress?.completed_attempts ?? 0,
          total_attempts: job.progress?.total_attempts,
          progress_ratio: job.progress?.progress_ratio,
          elapsed_ms: job.progress?.elapsed_ms,
          duration_ms: job.progress?.duration_ms,
          current_attempt_id: job.progress?.current_attempt_id,
          current_provider_id: job.progress?.current_provider_id,
          current_audio_id: job.progress?.current_audio_id,
          message: 'Cancellation requested. Waiting for the current request boundary.',
        };
        runJobs.set(job.job_id, job);
        response.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ job }, null, 2));
        return;
      }

      const match = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (match) {
        const run = await getRunDetailFromSqlite(options.dbPath, decodeURIComponent(match[1]));
        if (!run) {
          response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'run_not_found' }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(run, null, 2));
        return;
      }

      const rawMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/attempts\/([^/]+)\/raw$/);
      if (rawMatch) {
        const run = await getRunDetailFromSqlite(options.dbPath, decodeURIComponent(rawMatch[1]));
        if (!run) {
          response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'run_not_found' }));
          return;
        }

        const rawAttempt = await readRawAttemptArtifact(run.summary.attempts_path, decodeURIComponent(rawMatch[2]));
        if (!rawAttempt) {
          response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'raw_attempt_not_found' }));
          return;
        }

        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(rawAttempt, null, 2));
        return;
      }

      const exportMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/export$/);
      if (exportMatch) {
        const runId = decodeURIComponent(exportMatch[1]);
        const formatParam = requestUrl.searchParams.get('format') ?? 'json';
        const format = ['json', 'jsonl', 'csv'].includes(formatParam) ? (formatParam as 'json' | 'jsonl' | 'csv') : 'json';
        const exported = await exportRun({
          dbPath: options.dbPath,
          runId,
          format,
        });
        const contentType =
          format === 'csv'
            ? 'text/csv; charset=utf-8'
            : format === 'jsonl'
              ? 'application/x-ndjson; charset=utf-8'
              : 'application/json; charset=utf-8';
        response.writeHead(200, {
          'content-type': contentType,
          'content-disposition': `attachment; filename="${runId}.${format}"`,
        });
        response.end(exported.content);
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/run') {
        const payload = (await readJsonBody(request)) as RunSubmissionPayload;
        const providersFile = await loadProvidersConfig(options.configPath);
        const validation = await validateRunSubmission(payload, providersFile.providers.map((provider) => provider.provider_id));
        if (!validation.ok) {
          response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          response.end(
            JSON.stringify(
              {
                error: 'validation_failed',
                message: 'Please fix the highlighted fields and try again.',
                field_errors: validation.fieldErrors,
              },
              null,
              2,
            ),
          );
          return;
        }

        const requestBody = validation.value;
        if (!requestBody) {
          throw new Error('validated run submission missing request body');
        }
        const job: UiRunJob = {
          job_id: `job_${crypto.randomUUID().slice(0, 8)}`,
          status: 'queued',
          created_at: new Date().toISOString(),
          request: requestBody,
        };
        runJobs.set(job.job_id, job);
        void executeRunJob(job, options, runJobs);

        response.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ job }, null, 2));
        return;
      }

      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      response.end(
        JSON.stringify(
          {
            error: 'internal_error',
            message: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address() as AddressInfo;
  const url = `http://${host}:${address.port}`;

  return {
    host,
    port: address.port,
    url,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

export async function validateRunSubmission(
  payload: RunSubmissionPayload,
  knownProviderIds: string[],
): Promise<RunValidationResult> {
  const fieldErrors: Record<string, string> = {};
  const mode = payload.mode === 'duration' ? 'duration' : 'once';
  const providerIds = Array.isArray(payload.providerIds)
    ? payload.providerIds.map((value) => String(value).trim()).filter(Boolean)
    : [];
  const inputPath = typeof payload.inputPath === 'string' ? payload.inputPath.trim() : '';
  const manifestPath = typeof payload.manifestPath === 'string' ? payload.manifestPath.trim() : '';
  const referenceDir = typeof payload.referenceDir === 'string' ? payload.referenceDir.trim() : '';
  const rounds = toPositiveInteger(payload.rounds, mode === 'once' ? 1 : 1);
  const durationMs = toPositiveInteger(payload.durationMs, mode === 'duration' ? 30_000 : 30_000);
  const concurrency = payload.concurrency === undefined ? undefined : toPositiveInteger(payload.concurrency, 1);
  const intervalMs = payload.intervalMs === undefined ? undefined : toNonNegativeInteger(payload.intervalMs, 0);

  if (!inputPath) {
    fieldErrors.inputPath = 'Input path is required.';
  } else if (!(await pathExists(inputPath))) {
    fieldErrors.inputPath = 'Input path does not exist.';
  }

  if (providerIds.length === 0) {
    fieldErrors.providerIds = 'Select at least one provider.';
  } else {
    const unknown = providerIds.filter((providerId) => !knownProviderIds.includes(providerId));
    if (unknown.length > 0) {
      fieldErrors.providerIds = `Unknown providers: ${unknown.join(', ')}`;
    }
  }

  if (manifestPath && !(await pathExists(manifestPath))) {
    fieldErrors.manifestPath = 'Manifest path does not exist.';
  }
  if (referenceDir && !(await pathExists(referenceDir))) {
    fieldErrors.referenceDir = 'Reference directory does not exist.';
  }

  if (mode === 'once' && rounds < 1) {
    fieldErrors.rounds = 'Rounds must be >= 1.';
  }
  if (mode === 'duration' && durationMs < 1) {
    fieldErrors.durationMs = 'Duration must be >= 1 ms.';
  }
  if (concurrency !== undefined && concurrency < 1) {
    fieldErrors.concurrency = 'Concurrency must be >= 1.';
  }
  if (intervalMs !== undefined && intervalMs < 0) {
    fieldErrors.intervalMs = 'Interval must be >= 0.';
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      ok: false,
      fieldErrors,
    };
  }

  return {
    ok: true,
    fieldErrors,
    value: {
      mode,
      providerIds,
      inputPath,
      rounds,
      durationMs,
      concurrency,
      intervalMs,
      manifestPath: manifestPath || undefined,
      referenceSidecar: Boolean(payload.referenceSidecar),
      referenceDir: referenceDir || undefined,
    },
  };
}

export async function executeRunJob(
  job: UiRunJob,
  options: Pick<UiServerOptions, 'configPath' | 'dbPath'>,
  runJobs: Map<string, UiRunJob>,
): Promise<void> {
  job.status = 'running';
  job.started_at = new Date().toISOString();
  job.progress = {
    completed_attempts: 0,
    progress_ratio: 0,
    duration_ms: job.request.mode === 'duration' ? job.request.durationMs : undefined,
    total_attempts:
      job.request.mode === 'once'
        ? undefined
        : undefined,
    message: 'Job started.',
  };
  runJobs.set(job.job_id, job);

  try {
    const summary =
      job.request.mode === 'duration'
        ? await runDuration({
            configPath: options.configPath,
            providerIds: job.request.providerIds,
            inputPath: job.request.inputPath,
            durationMs: job.request.durationMs,
            concurrency: job.request.concurrency,
            intervalMs: job.request.intervalMs,
            dbPath: options.dbPath,
            manifestPath: job.request.manifestPath,
            referenceSidecar: job.request.referenceSidecar,
            referenceDir: job.request.referenceDir,
            shouldStop: () => Boolean(job.cancel_requested),
            onAttemptComplete: ({ attempt, completedAttempts, elapsedMs, durationMs, retryHistory }) => {
              job.progress = {
                completed_attempts: completedAttempts,
                elapsed_ms: elapsedMs,
                duration_ms: durationMs,
                progress_ratio: durationMs > 0 ? Math.min(1, elapsedMs / durationMs) : undefined,
                current_attempt_id: attempt.attempt_id,
                current_provider_id: attempt.provider_id,
                current_audio_id: attempt.audio_id,
                retry_history: retryHistory,
                message: job.cancel_requested ? 'Cancelling after current attempt...' : 'Running duration benchmark.',
              };
              runJobs.set(job.job_id, job);
            },
          })
        : await runOnce({
            configPath: options.configPath,
            providerIds: job.request.providerIds,
            inputPath: job.request.inputPath,
            rounds: job.request.rounds,
            dbPath: options.dbPath,
            manifestPath: job.request.manifestPath,
            referenceSidecar: job.request.referenceSidecar,
            referenceDir: job.request.referenceDir,
            shouldStop: () => Boolean(job.cancel_requested),
            onAttemptComplete: ({ attempt, completedAttempts, totalAttempts, retryHistory }) => {
              job.progress = {
                completed_attempts: completedAttempts,
                total_attempts: totalAttempts,
                progress_ratio: totalAttempts > 0 ? Math.min(1, completedAttempts / totalAttempts) : undefined,
                current_attempt_id: attempt.attempt_id,
                current_provider_id: attempt.provider_id,
                current_audio_id: attempt.audio_id,
                retry_history: retryHistory,
                message: job.cancel_requested ? 'Cancelling after current attempt...' : 'Running once benchmark.',
              };
              runJobs.set(job.job_id, job);
            },
          });

    job.status = job.cancel_requested ? 'cancelled' : 'succeeded';
    job.summary = summary;
    job.finished_at = new Date().toISOString();
    if (job.cancel_requested) {
      job.cancelled_at = job.finished_at;
    }
    job.progress = {
      completed_attempts: summary.attempt_count,
      total_attempts: job.request.mode === 'once' ? job.progress?.total_attempts ?? summary.attempt_count : job.progress?.total_attempts,
      elapsed_ms: job.progress?.elapsed_ms,
      duration_ms: job.progress?.duration_ms,
      current_attempt_id: job.progress?.current_attempt_id,
      current_provider_id: job.progress?.current_provider_id,
      current_audio_id: job.progress?.current_audio_id,
      progress_ratio: 1,
      message: job.cancel_requested ? 'Job cancelled.' : 'Job completed successfully.',
    };
    runJobs.set(job.job_id, job);
  } catch (error) {
    job.status = job.cancel_requested ? 'cancelled' : 'failed';
    job.finished_at = new Date().toISOString();
    if (job.cancel_requested) {
      job.cancelled_at = job.finished_at;
    }
    job.error = {
      message: error instanceof Error ? error.message : String(error),
    };
    job.progress = {
      completed_attempts: job.progress?.completed_attempts ?? 0,
      total_attempts: job.progress?.total_attempts,
      progress_ratio: job.progress?.progress_ratio,
      elapsed_ms: job.progress?.elapsed_ms,
      duration_ms: job.progress?.duration_ms,
      current_attempt_id: job.progress?.current_attempt_id,
      current_provider_id: job.progress?.current_provider_id,
      current_audio_id: job.progress?.current_audio_id,
      message: job.cancel_requested ? 'Job cancelled.' : 'Job failed.',
    };
    runJobs.set(job.job_id, job);
  }
}

function listRunJobs(runJobs: Map<string, UiRunJob>, limit: number): UiRunJob[] {
  return Array.from(runJobs.values())
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, Math.max(1, limit));
}

function describeProviderCapabilities(provider: ProviderConfig): Record<string, unknown> {
  const adapterOptions = (provider.adapter_options ?? {}) as Record<string, unknown>;
  const operation =
    provider.type === 'zenmux'
      ? 'chat_completions_audio'
      : typeof adapterOptions.operation === 'string'
        ? adapterOptions.operation
        : provider.type === 'openai_compatible'
          ? 'audio_transcriptions'
          : 'custom_http';

  return {
    provider_id: provider.provider_id,
    name: provider.name,
    type: provider.type,
    operation,
    base_url: provider.base_url,
    default_model: provider.default_model,
    supports_audio_input: true,
    supports_word_timestamps:
      provider.type === 'openai_compatible' && operation === 'audio_transcriptions',
    supports_segment_timestamps:
      provider.type === 'openai_compatible' && operation === 'audio_transcriptions',
    supports_background_benchmarking: true,
    retry_policy: provider.retry_policy ?? {},
    runner_options: provider.runner_options ?? {},
  };
}

function toPositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(path.resolve(targetPath));
    return true;
  } catch {
    return false;
  }
}

function renderIndexHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ASR Bench</title>
    <style>
      :root {
        --bg: #f3efe6;
        --panel: rgba(255, 252, 247, 0.92);
        --ink: #1d1b17;
        --muted: #6d6558;
        --line: rgba(29, 27, 23, 0.12);
        --accent: #0d7a5f;
        --accent-soft: rgba(13, 122, 95, 0.1);
        --warm: #d96c3d;
        --danger: #b94a32;
        --danger-soft: rgba(185, 74, 50, 0.1);
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(217,108,61,0.18), transparent 30%),
          radial-gradient(circle at bottom right, rgba(13,122,95,0.18), transparent 35%),
          linear-gradient(135deg, #efe8db 0%, #f8f4ec 48%, #ebe1d0 100%);
      }

      .shell {
        display: grid;
        grid-template-columns: 360px 1fr;
        min-height: 100vh;
      }

      .sidebar, .content {
        padding: 24px;
      }

      .sidebar {
        border-right: 1px solid var(--line);
        background: rgba(255,255,255,0.35);
        backdrop-filter: blur(12px);
      }

      .content {
        display: grid;
        gap: 16px;
      }

      h1, h2, h3, h4 { margin: 0; }
      h1 { font-size: 30px; letter-spacing: 0.02em; }
      .subtitle, .muted { color: var(--muted); }
      .run-list {
        display: grid;
        gap: 12px;
        margin-top: 18px;
      }

      .run-card, .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 16px;
        box-shadow: 0 10px 30px rgba(40, 31, 20, 0.06);
      }

      .run-card {
        cursor: pointer;
        transition: transform 140ms ease, border-color 140ms ease, background 140ms ease;
      }

      .run-card:hover, .run-card.active {
        transform: translateY(-1px);
        border-color: rgba(13, 122, 95, 0.45);
        background: linear-gradient(180deg, rgba(255,252,247,0.98), rgba(247,243,235,0.98));
      }

      .tag {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-size: 12px;
        margin-right: 6px;
      }

      .tag.alert {
        background: var(--danger-soft);
        color: var(--danger);
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 12px;
      }

      .split {
        display: grid;
        grid-template-columns: minmax(0, 1.45fr) minmax(320px, 0.95fr);
        gap: 16px;
        align-items: start;
      }

      .metric {
        border-radius: 14px;
        background: rgba(255,255,255,0.72);
        border: 1px solid var(--line);
        padding: 12px;
      }

      .metric .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
      .metric .value { font-size: 28px; margin-top: 4px; }

      .controls {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 10px;
        margin-top: 14px;
      }

      label {
        display: grid;
        gap: 6px;
        font-size: 12px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }

      input, select {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 10px 12px;
        background: rgba(255,255,255,0.8);
        color: var(--ink);
        font: inherit;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        font-family: ui-monospace, "SFMono-Regular", monospace;
        font-size: 12px;
      }

      th, td {
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
        padding: 10px 8px;
      }

      tr.attempt-row {
        cursor: pointer;
      }

      tr.attempt-row:hover {
        background: rgba(13, 122, 95, 0.05);
      }

      tr.attempt-row.active {
        background: rgba(13, 122, 95, 0.1);
      }

      .empty {
        display: grid;
        place-items: center;
        min-height: 240px;
        color: var(--muted);
        background: repeating-linear-gradient(
          -45deg,
          rgba(255,255,255,0.55),
          rgba(255,255,255,0.55) 12px,
          rgba(255,249,240,0.7) 12px,
          rgba(255,249,240,0.7) 24px
        );
      }

      .detail-stack {
        display: grid;
        gap: 12px;
      }

      .detail-block {
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.72);
        border-radius: 14px;
        padding: 14px;
      }

      .detail-block pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: ui-monospace, "SFMono-Regular", monospace;
        font-size: 12px;
      }

      .chart-stack {
        display: grid;
        gap: 12px;
      }

      .chart {
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.72);
        border-radius: 14px;
        padding: 14px;
      }

      .chart-title {
        margin-bottom: 10px;
        font-size: 14px;
      }

      .bar-list {
        display: grid;
        gap: 8px;
      }

      .bar-row {
        display: grid;
        grid-template-columns: 120px minmax(0, 1fr) 52px;
        gap: 10px;
        align-items: center;
        font-size: 12px;
      }

      .bar-track {
        position: relative;
        height: 10px;
        border-radius: 999px;
        background: rgba(29, 27, 23, 0.08);
        overflow: hidden;
      }

      .bar-fill {
        position: absolute;
        inset: 0 auto 0 0;
        border-radius: 999px;
        background: linear-gradient(90deg, rgba(13,122,95,0.82), rgba(217,108,61,0.82));
      }

      .diff-chip {
        display: inline-block;
        margin: 0 4px 4px 0;
        padding: 3px 7px;
        border-radius: 999px;
        background: rgba(29, 27, 23, 0.06);
      }

      .diff-chip.insert { background: rgba(13, 122, 95, 0.16); }
      .diff-chip.delete { background: rgba(185, 74, 50, 0.16); }
      .diff-chip.same { background: rgba(29, 27, 23, 0.06); }

      @media (max-width: 1180px) {
        .split { grid-template-columns: 1fr; }
      }

      @media (max-width: 920px) {
        .shell { grid-template-columns: 1fr; }
        .sidebar { border-right: 0; border-bottom: 1px solid var(--line); }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <aside class="sidebar">
        <h1>ASR Bench</h1>
        <p class="subtitle">SQLite-backed runs, latency, retries, transcript accuracy, and failure triage in one place.</p>
        <div class="panel" style="margin-top:18px;">
          <h3 style="margin-bottom:10px;">Run Filters</h3>
          <div id="run-filter-controls" class="controls"></div>
        </div>
        <div class="panel" style="margin-top:16px;">
          <h3 style="margin-bottom:10px;">Create Run</h3>
          <div id="run-create-controls" class="controls"></div>
        </div>
        <div class="panel" style="margin-top:16px;">
          <h3 style="margin-bottom:10px;">Background Jobs</h3>
          <div id="job-list"></div>
        </div>
        <div class="panel" style="margin-top:16px;">
          <h3 style="margin-bottom:10px;">Providers</h3>
          <div id="provider-capabilities"></div>
        </div>
        <div id="run-list" class="run-list"></div>
      </aside>
      <main class="content" id="content">
        <section class="panel empty">Loading benchmark runs...</section>
      </main>
    </div>
    <script>
      const state = {
        runs: [],
        providers: [],
        providerCapabilities: [],
        jobs: [],
        demoAssets: null,
        activeRunId: null,
        activeRun: null,
        rawAttemptById: {},
        runFilters: {
          provider: 'all',
          mode: 'all',
          failures: 'all',
          query: '',
        },
        runForm: {
          mode: 'once',
          providerIds: [],
          inputPath: '',
          rounds: '1',
          durationMs: '30000',
          concurrency: '1',
          intervalMs: '0',
          manifestPath: '',
          referenceSidecar: false,
          referenceDir: '',
        },
        isSubmittingRun: false,
        runFormErrors: {},
        runFormMessage: '',
        seenCompletedJobs: {},
        filters: {
          provider: 'all',
          status: 'all',
          search: '',
          sort: 'latency_desc',
          minLatency: '',
          minWer: '',
        },
        selectedAttemptId: null,
      };

      function fmt(value) {
        if (value === null || value === undefined || value === '') return '-';
        return String(value);
      }

      function metric(label, value) {
        return '<div class="metric"><div class="label">' + label + '</div><div class="value">' + fmt(value) + '</div></div>';
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;');
      }

      function renderRunList() {
        const root = document.getElementById('run-list');
        if (!state.runs.length) {
          root.innerHTML = '<div class="run-card">No benchmark runs found in the selected SQLite database.</div>';
          return;
        }

        root.innerHTML = state.runs.map((run) => {
          const active = run.run_id === state.activeRunId ? 'active' : '';
          const failureTag = run.failure_count > 0 ? '<div class="tag alert">' + run.failure_count + ' failures</div>' : '';
          return '<div class="run-card ' + active + '" data-run-id="' + run.run_id + '">' +
            '<div class="tag">' + run.mode + '</div>' +
            '<div class="tag">' + run.attempt_count + ' attempts</div>' +
            failureTag +
            '<h3 style="margin-top:10px;font-size:16px;">' + run.run_id + '</h3>' +
            '<p class="muted" style="margin:8px 0 0;">' + new Date(run.created_at).toLocaleString() + '</p>' +
            '<p class="muted" style="margin:8px 0 0;">avg latency ' + fmt(run.average_latency_ms) + ' ms, avg WER ' + fmt(run.average_wer) + '</p>' +
          '</div>';
        }).join('');

        root.querySelectorAll('[data-run-id]').forEach((node) => {
          node.addEventListener('click', () => loadRun(node.getAttribute('data-run-id')));
        });
      }

      function renderRunSidebarControls() {
        renderRunFilterControls();
        renderRunCreateControls();
        renderJobList();
        renderProviderCapabilities();
      }

      function renderProviderCapabilities() {
        const root = document.getElementById('provider-capabilities');
        if (!root) return;
        if (!state.providerCapabilities.length) {
          root.innerHTML = '<div class="muted">No provider capability data loaded.</div>';
          return;
        }

        root.innerHTML = state.providerCapabilities.map((item) =>
          '<div class="run-card">' +
            '<div class="tag">' + escapeHtml(item.type) + '</div>' +
            '<div class="tag">' + escapeHtml(item.operation) + '</div>' +
            '<h3 style="margin-top:10px;font-size:15px;">' + escapeHtml(item.provider_id) + '</h3>' +
            '<p class="muted" style="margin:8px 0 0;">' + escapeHtml(item.default_model || 'no default model') + '</p>' +
            '<p class="muted" style="margin:8px 0 0;">timestamps: ' + ((item.supports_word_timestamps || item.supports_segment_timestamps) ? 'yes' : 'no') + '</p>' +
          '</div>'
        ).join('');
      }

      function renderRunFilterControls() {
        const root = document.getElementById('run-filter-controls');
        if (!root) return;
        const providers = state.providers.map((provider) => provider.provider_id);
        root.innerHTML =
          '<label>Provider<select id="run-filter-provider"><option value="all">All providers</option>' +
          providers.map((provider) => '<option value="' + escapeHtml(provider) + '"' + (provider === state.runFilters.provider ? ' selected' : '') + '>' + escapeHtml(provider) + '</option>').join('') +
          '</select></label>' +
          '<label>Mode<select id="run-filter-mode">' +
            '<option value="all"' + (state.runFilters.mode === 'all' ? ' selected' : '') + '>All modes</option>' +
            '<option value="once"' + (state.runFilters.mode === 'once' ? ' selected' : '') + '>Once</option>' +
            '<option value="duration"' + (state.runFilters.mode === 'duration' ? ' selected' : '') + '>Duration</option>' +
          '</select></label>' +
          '<label>Failures<select id="run-filter-failures">' +
            '<option value="all"' + (state.runFilters.failures === 'all' ? ' selected' : '') + '>Any</option>' +
            '<option value="yes"' + (state.runFilters.failures === 'yes' ? ' selected' : '') + '>Failures only</option>' +
            '<option value="no"' + (state.runFilters.failures === 'no' ? ' selected' : '') + '>No failures</option>' +
          '</select></label>' +
          '<label>Search<input id="run-filter-query" type="text" placeholder="run id or path" value="' + escapeHtml(state.runFilters.query) + '" /></label>';

        ['run-filter-provider', 'run-filter-mode', 'run-filter-failures', 'run-filter-query'].forEach((id) => {
          const node = document.getElementById(id);
          if (!node) return;
          node.addEventListener('input', updateRunFiltersFromDom);
          node.addEventListener('change', updateRunFiltersFromDom);
        });
      }

      function renderRunCreateControls() {
        const root = document.getElementById('run-create-controls');
        if (!root) return;
        const isDuration = state.runForm.mode === 'duration';
        const providerCheckboxes = state.providers.length
          ? state.providers.map((provider) =>
              '<label style="text-transform:none;letter-spacing:0;font-size:13px;">' +
                '<input type="checkbox" class="run-provider-checkbox" value="' + escapeHtml(provider.provider_id) + '"' +
                (state.runForm.providerIds.includes(provider.provider_id) ? ' checked' : '') +
                ' /> ' + escapeHtml(provider.provider_id) +
              '</label>'
            ).join('')
          : '<div class="muted">No providers loaded.</div>';

        const error = (field) => state.runFormErrors[field] ? '<div class="muted" style="color:#b94a32;">' + escapeHtml(state.runFormErrors[field]) + '</div>' : '';
        const message = state.runFormMessage
          ? '<div class="detail-block" style="padding:10px 12px;font-size:12px;">' + escapeHtml(state.runFormMessage) + '</div>'
          : '';
        const demoButtons = state.demoAssets
          ? '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
              '<button id="run-form-use-demo" type="button" style="padding:8px 10px;border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,0.75);cursor:pointer;">Use demo dataset</button>' +
              '<button id="run-form-use-demo-provider" type="button" style="padding:8px 10px;border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,0.75);cursor:pointer;">Select demo provider</button>' +
            '</div>'
          : '';

        root.innerHTML =
          message +
          demoButtons +
          '<label>Mode<select id="run-form-mode">' +
            '<option value="once"' + (state.runForm.mode === 'once' ? ' selected' : '') + '>Once</option>' +
            '<option value="duration"' + (state.runForm.mode === 'duration' ? ' selected' : '') + '>Duration</option>' +
          '</select></label>' + error('mode') +
          '<label>Input path<input id="run-form-input" type="text" placeholder="/path/to/audio" value="' + escapeHtml(state.runForm.inputPath) + '" /></label>' + error('inputPath') +
          '<label>Manifest path<input id="run-form-manifest" type="text" placeholder="/path/to/manifest.json" value="' + escapeHtml(state.runForm.manifestPath) + '" /></label>' + error('manifestPath') +
          '<label>Reference dir<input id="run-form-reference-dir" type="text" placeholder="/path/to/references" value="' + escapeHtml(state.runForm.referenceDir) + '" /></label>' + error('referenceDir') +
          '<label>Rounds<input id="run-form-rounds" type="number" min="1" value="' + escapeHtml(state.runForm.rounds) + '"' + (isDuration ? ' disabled' : '') + ' /></label>' + error('rounds') +
          '<label>Duration ms<input id="run-form-duration" type="number" min="1" value="' + escapeHtml(state.runForm.durationMs) + '"' + (isDuration ? '' : ' disabled') + ' /></label>' + error('durationMs') +
          '<label>Concurrency<input id="run-form-concurrency" type="number" min="1" value="' + escapeHtml(state.runForm.concurrency) + '" /></label>' + error('concurrency') +
          '<label>Interval ms<input id="run-form-interval" type="number" min="0" value="' + escapeHtml(state.runForm.intervalMs) + '" /></label>' + error('intervalMs') +
          '<label style="text-transform:none;letter-spacing:0;font-size:13px;"><input id="run-form-sidecar" type="checkbox"' + (state.runForm.referenceSidecar ? ' checked' : '') + ' /> Use sidecar reference txt</label>' +
          (state.runFormErrors.providerIds ? '<div class="muted" style="color:#b94a32;">' + escapeHtml(state.runFormErrors.providerIds) + '</div>' : '') +
          '<div style="display:grid;gap:6px;"><div class="muted" style="font-size:12px;">Providers</div>' + providerCheckboxes + '</div>' +
          '<button id="run-form-submit" style="margin-top:8px;padding:12px;border-radius:12px;border:1px solid var(--line);background:var(--accent);color:white;cursor:' + (state.isSubmittingRun ? 'wait' : 'pointer') + ';"' + (state.isSubmittingRun ? ' disabled' : '') + '>' +
            (state.isSubmittingRun ? 'Submitting...' : 'Queue Run') +
          '</button>';

        ['run-form-mode', 'run-form-input', 'run-form-manifest', 'run-form-reference-dir', 'run-form-rounds', 'run-form-duration', 'run-form-concurrency', 'run-form-interval', 'run-form-sidecar']
          .forEach((id) => {
            const node = document.getElementById(id);
            if (!node) return;
            node.addEventListener('input', updateRunFormFromDom);
            node.addEventListener('change', updateRunFormFromDom);
          });
        document.querySelectorAll('.run-provider-checkbox').forEach((node) => {
          node.addEventListener('change', updateRunFormFromDom);
        });
        const submit = document.getElementById('run-form-submit');
        if (submit) {
          submit.addEventListener('click', submitRunForm);
        }
        const useDemo = document.getElementById('run-form-use-demo');
        if (useDemo) {
          useDemo.addEventListener('click', applyDemoDatasetPreset);
        }
        const useDemoProvider = document.getElementById('run-form-use-demo-provider');
        if (useDemoProvider) {
          useDemoProvider.addEventListener('click', applyDemoProviderPreset);
        }
      }

      function renderJobList() {
        const root = document.getElementById('job-list');
        if (!root) return;
        if (!state.jobs.length) {
          root.innerHTML = '<div class="muted">No queued or recent jobs yet.</div>';
          return;
        }

        root.innerHTML = state.jobs.map((job) => {
          const statusTag =
            job.status === 'succeeded'
              ? '<span class="tag">done</span>'
              : job.status === 'cancelled'
                ? '<span class="tag alert">cancelled</span>'
              : job.status === 'failed'
                ? '<span class="tag alert">failed</span>'
                : '<span class="tag">' + escapeHtml(job.status) + '</span>';
          const progress = job.progress || {};
          const ratio = typeof progress.progress_ratio === 'number' ? Math.max(0, Math.min(1, progress.progress_ratio)) : 0;
          const progressLabel = progress.total_attempts
            ? progress.completed_attempts + '/' + progress.total_attempts + ' attempts'
            : (progress.elapsed_ms !== undefined && progress.duration_ms !== undefined
                ? progress.completed_attempts + ' attempts in ' + progress.elapsed_ms + ' / ' + progress.duration_ms + ' ms'
                : progress.completed_attempts + ' attempts');
          const runLink = job.summary?.run_id
            ? '<button class="job-open-run" data-run-id="' + escapeHtml(job.summary.run_id) + '" style="margin-top:8px;padding:6px 10px;border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,0.75);cursor:pointer;">Open run</button>'
            : '';
          const cancelButton = (job.status === 'queued' || job.status === 'running') && !job.cancel_requested
            ? '<button class="job-cancel" data-job-id="' + escapeHtml(job.job_id) + '" style="margin-top:8px;padding:6px 10px;border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,0.75);cursor:pointer;">Cancel</button>'
            : '';
          const errorMessage = job.error?.message
            ? '<p class="muted" style="margin:8px 0 0;color:#b94a32;">' + escapeHtml(job.error.message) + '</p>'
            : '';
          const progressBar =
            '<div style="margin-top:10px;">' +
              '<div class="bar-track" style="height:8px;"><div class="bar-fill" style="width:' + Math.round(ratio * 100) + '%;"></div></div>' +
              '<p class="muted" style="margin:6px 0 0;">' + escapeHtml(progress.message || progressLabel) + '</p>' +
              '<p class="muted" style="margin:4px 0 0;">' + escapeHtml(progressLabel) + '</p>' +
              (progress.retry_history && progress.retry_history.length
                ? '<pre style="margin-top:8px;font-size:11px;">' + escapeHtml(JSON.stringify(progress.retry_history, null, 2)) + '</pre>'
                : '') +
            '</div>';
          return '<div class="run-card">' +
            statusTag +
            '<div class="tag">' + escapeHtml(job.request.mode) + '</div>' +
            '<h3 style="margin-top:10px;font-size:15px;">' + escapeHtml(job.job_id) + '</h3>' +
            '<p class="muted" style="margin:8px 0 0;">' + escapeHtml(job.request.providerIds.join(', ')) + '</p>' +
            '<p class="muted" style="margin:8px 0 0;">' + escapeHtml(job.request.inputPath) + '</p>' +
            progressBar +
            errorMessage +
            cancelButton +
            runLink +
          '</div>';
        }).join('');

        root.querySelectorAll('.job-open-run').forEach((node) => {
          node.addEventListener('click', async () => {
            const runId = node.getAttribute('data-run-id');
            await loadRuns(runId);
          });
        });
        root.querySelectorAll('.job-cancel').forEach((node) => {
          node.addEventListener('click', async () => {
            await cancelJob(node.getAttribute('data-job-id'));
          });
        });
      }

      async function loadRuns(preferredRunId) {
        const params = new URLSearchParams();
        if (state.runFilters.provider !== 'all') params.set('provider', state.runFilters.provider);
        if (state.runFilters.mode !== 'all') params.set('mode', state.runFilters.mode);
        if (state.runFilters.failures !== 'all') params.set('failures', state.runFilters.failures);
        if (state.runFilters.query) params.set('query', state.runFilters.query);

        const response = await fetch('/api/runs?' + params.toString());
        const data = await response.json();
        state.runs = data.runs || [];
        renderRunSidebarControls();
        const requestedRunId = preferredRunId || state.activeRunId;
        const nextRun =
          state.runs.find((run) => run.run_id === requestedRunId) ||
          state.runs[0] ||
          null;
        state.activeRunId = nextRun ? nextRun.run_id : null;
        renderRunList();
        if (state.activeRunId) {
          await loadRun(state.activeRunId);
        } else {
          document.getElementById('content').innerHTML = '<section class="panel empty">Run a benchmark first, then refresh this page.</section>';
        }
      }

      async function loadProviders() {
        const response = await fetch('/api/providers');
        const data = await response.json();
        state.providers = data.providers || [];
        if (!state.runForm.providerIds.length && state.providers[0]) {
          state.runForm.providerIds = [state.providers[0].provider_id];
        }
        renderRunSidebarControls();
      }

      async function loadProviderCapabilities() {
        const response = await fetch('/api/provider-capabilities');
        const data = await response.json();
        state.providerCapabilities = data.providers || [];
        renderProviderCapabilities();
      }

      async function loadDemoAssets() {
        const response = await fetch('/api/demo-assets');
        const data = await response.json();
        state.demoAssets = data;
        renderRunCreateControls();
      }

      async function loadJobs() {
        const response = await fetch('/api/jobs?limit=8');
        const data = await response.json();
        state.jobs = data.jobs || [];
        renderJobList();

        let preferredRunId = null;
        state.jobs.forEach((job) => {
          if (job.status === 'succeeded' && job.summary?.run_id && !state.seenCompletedJobs[job.job_id]) {
            state.seenCompletedJobs[job.job_id] = true;
            preferredRunId = preferredRunId || job.summary.run_id;
          }
          if ((job.status === 'failed' || job.status === 'succeeded' || job.status === 'cancelled') && !state.seenCompletedJobs[job.job_id]) {
            state.seenCompletedJobs[job.job_id] = true;
          }
        });

        if (preferredRunId) {
          state.runFormMessage = 'Background job finished. Loaded the new run.';
          await loadRuns(preferredRunId);
        }

        scheduleJobPolling();
      }

      async function cancelJob(jobId) {
        if (!jobId) return;
        await fetch('/api/jobs/' + encodeURIComponent(jobId) + '/cancel', {
          method: 'POST',
        });
        state.runFormMessage = 'Cancellation requested.';
        await loadJobs();
      }

      async function loadRun(runId) {
        if (!runId) return;
        state.activeRunId = runId;
        renderRunList();

        const response = await fetch('/api/runs/' + encodeURIComponent(runId));
        const data = await response.json();
        state.activeRun = data;
        state.rawAttemptById = {};
        state.selectedAttemptId = data.attempts?.[0]?.attempt_id || null;
        resetFiltersForRun(data);
        renderActiveRun();
        if (state.selectedAttemptId) {
          await ensureRawAttemptLoaded(state.selectedAttemptId);
          renderActiveRun();
        }
      }

      function renderRunExportButtons(runId) {
        const formats = ['json', 'jsonl', 'csv'];
        return '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">' +
          formats.map((format) =>
            '<button class="run-export-button" data-run-id="' + escapeHtml(runId) + '" data-format="' + format + '" style="padding:8px 10px;border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,0.75);cursor:pointer;">Download ' + format.toUpperCase() + '</button>'
          ).join('') +
        '</div>';
      }

      function resetFiltersForRun(data) {
        const providers = new Set((data.attempts || []).map((item) => item.provider_id));
        if (!providers.has(state.filters.provider)) {
          state.filters.provider = 'all';
        }
      }

      function renderActiveRun() {
        if (!state.activeRun) return;
        const summary = state.activeRun.summary;
        const attempts = filteredAttempts();
        const selectedAttempt = resolveSelectedAttempt(attempts, state.activeRun.attempts || []);

        document.getElementById('content').innerHTML =
          '<section class="panel">' +
            '<div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;">' +
              '<div><h2>' + summary.run_id + '</h2><p class="muted" style="margin-top:8px;">' + escapeHtml(summary.input_path) + '</p>' + renderRunExportButtons(summary.run_id) + '</div>' +
              '<div><span class="tag">' + summary.mode + '</span><span class="tag">' + summary.provider_ids.map(escapeHtml).join(', ') + '</span></div>' +
            '</div>' +
            '<div class="grid" style="margin-top:16px;">' +
              metric('Attempts', summary.attempt_count) +
              metric('Success', summary.success_count) +
              metric('Failures', summary.failure_count) +
              metric('Avg latency', summary.average_latency_ms === undefined ? '-' : summary.average_latency_ms + ' ms') +
              metric('P95 latency', summary.p95_latency_ms === undefined ? '-' : summary.p95_latency_ms + ' ms') +
              metric('Retries', summary.total_retry_count) +
              metric('Avg WER', summary.average_wer) +
              metric('Avg CER', summary.average_cer) +
            '</div>' +
          '</section>' +
          '<section class="panel">' +
            '<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;">' +
              '<div><h3 style="margin-bottom:12px;">Provider Summary</h3></div>' +
              '<div class="tag">filtered attempts ' + attempts.length + '</div>' +
            '</div>' +
            renderProviderTable(summary.provider_summaries || []) +
          '</section>' +
          '<section class="panel">' +
            '<h3 style="margin-bottom:12px;">Visual Overview</h3>' +
            renderCharts(attempts) +
          '</section>' +
          '<section class="panel">' +
            '<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;">' +
              '<div><h3 style="margin-bottom:6px;">Attempts</h3><p class="muted" style="margin:0;">Filter failures, high latency, high WER, and inspect one sample in detail.</p></div>' +
            '</div>' +
            renderAttemptFilters(state.activeRun.attempts || []) +
            '<div class="split" style="margin-top:16px;">' +
              '<div>' + renderAttemptTable(attempts, selectedAttempt) + '</div>' +
              '<div>' + renderAttemptDetail(selectedAttempt) + '</div>' +
            '</div>' +
          '</section>';

        bindFilters();
        bindAttemptRows();
        bindRunExportButtons();
      }

      function bindRunExportButtons() {
        document.querySelectorAll('.run-export-button').forEach((node) => {
          node.addEventListener('click', () => {
            const runId = node.getAttribute('data-run-id');
            const format = node.getAttribute('data-format');
            if (!runId || !format) return;
            window.location.href = '/api/runs/' + encodeURIComponent(runId) + '/export?format=' + encodeURIComponent(format);
          });
        });
      }

      function renderProviderTable(rows) {
        if (!rows.length) return '<div class="empty">No provider summaries.</div>';
        return '<table><thead><tr><th>provider</th><th>attempts</th><th>avg latency</th><th>retries</th><th>avg WER</th><th>avg CER</th></tr></thead><tbody>' +
          rows.map((row) => '<tr><td>' + escapeHtml(row.provider_id) + '</td><td>' + row.attempt_count + '</td><td>' + fmt(row.average_latency_ms) + '</td><td>' + fmt(row.total_retry_count) + '</td><td>' + fmt(row.average_wer) + '</td><td>' + fmt(row.average_cer) + '</td></tr>').join('') +
          '</tbody></table>';
      }

      function renderCharts(rows) {
        if (!rows.length) {
          return '<div class="empty">No attempts available for charting.</div>';
        }

        const latencyBuckets = [
          ['<250ms', (row) => Number(row.latency_ms) < 250],
          ['250-500', (row) => Number(row.latency_ms) >= 250 && Number(row.latency_ms) < 500],
          ['500-1000', (row) => Number(row.latency_ms) >= 500 && Number(row.latency_ms) < 1000],
          ['1-2s', (row) => Number(row.latency_ms) >= 1000 && Number(row.latency_ms) < 2000],
          ['>2s', (row) => Number(row.latency_ms) >= 2000],
        ];
        const werBuckets = [
          ['0-0.1', (row) => (row.evaluation?.word_error_rate ?? -1) >= 0 && (row.evaluation?.word_error_rate ?? -1) < 0.1],
          ['0.1-0.2', (row) => (row.evaluation?.word_error_rate ?? -1) >= 0.1 && (row.evaluation?.word_error_rate ?? -1) < 0.2],
          ['0.2-0.4', (row) => (row.evaluation?.word_error_rate ?? -1) >= 0.2 && (row.evaluation?.word_error_rate ?? -1) < 0.4],
          ['0.4-0.6', (row) => (row.evaluation?.word_error_rate ?? -1) >= 0.4 && (row.evaluation?.word_error_rate ?? -1) < 0.6],
          ['>0.6', (row) => (row.evaluation?.word_error_rate ?? -1) >= 0.6],
        ];

        const failureCounts = Object.entries(
          rows.reduce((acc, row) => {
            if (!row.success) {
              const key = row.error?.type || 'failed';
              acc[key] = (acc[key] || 0) + 1;
            }
            return acc;
          }, {}),
        );

        return '<div class="chart-stack">' +
          renderBarChart('Latency Distribution', bucketCounts(rows, latencyBuckets)) +
          renderBarChart('WER Distribution', bucketCounts(rows.filter((row) => row.evaluation), werBuckets)) +
          renderBarChart('Failure Types', failureCounts) +
        '</div>';
      }

      function bucketCounts(rows, buckets) {
        return buckets.map(([label, predicate]) => [label, rows.filter(predicate).length]);
      }

      function renderBarChart(title, rows) {
        const filtered = rows.filter(([, value]) => value > 0);
        if (!filtered.length) {
          return '<div class="chart"><div class="chart-title">' + title + '</div><div class="muted">No data in this slice.</div></div>';
        }
        const maxValue = Math.max(...filtered.map(([, value]) => value), 1);
        return '<div class="chart">' +
          '<div class="chart-title">' + title + '</div>' +
          '<div class="bar-list">' +
            filtered.map(([label, value]) => {
              const pct = Math.max(4, Math.round((value / maxValue) * 100));
              return '<div class="bar-row">' +
                '<div>' + escapeHtml(label) + '</div>' +
                '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;"></div></div>' +
                '<div>' + value + '</div>' +
              '</div>';
            }).join('') +
          '</div>' +
        '</div>';
      }

      function renderAttemptFilters(rows) {
        const providers = Array.from(new Set(rows.map((row) => row.provider_id))).sort();
        return '<div class="controls">' +
          '<label>Provider<select id="provider-filter"><option value="all">All providers</option>' + providers.map((provider) => '<option value="' + escapeHtml(provider) + '"' + (provider === state.filters.provider ? ' selected' : '') + '>' + escapeHtml(provider) + '</option>').join('') + '</select></label>' +
          '<label>Status<select id="status-filter">' +
            optionMarkup('status', 'all', 'All attempts') +
            optionMarkup('status', 'success', 'Success only') +
            optionMarkup('status', 'failure', 'Failures only') +
            optionMarkup('status', 'high_latency', 'High latency') +
            optionMarkup('status', 'high_wer', 'High WER') +
          '</select></label>' +
          '<label>Search<input id="search-filter" type="text" placeholder="provider, text, error..." value="' + escapeHtml(state.filters.search) + '" /></label>' +
          '<label>Sort<select id="sort-filter">' +
            optionMarkup('sort', 'latency_desc', 'Latency desc') +
            optionMarkup('sort', 'latency_asc', 'Latency asc') +
            optionMarkup('sort', 'wer_desc', 'WER desc') +
            optionMarkup('sort', 'retry_desc', 'Retry desc') +
            optionMarkup('sort', 'recent_desc', 'Newest first') +
          '</select></label>' +
          '<label>Min latency ms<input id="latency-filter" type="number" min="0" step="1" placeholder="1000" value="' + escapeHtml(state.filters.minLatency) + '" /></label>' +
          '<label>Min WER<input id="wer-filter" type="number" min="0" max="1" step="0.01" placeholder="0.2" value="' + escapeHtml(state.filters.minWer) + '" /></label>' +
        '</div>';
      }

      function optionMarkup(group, value, label) {
        const selected = state.filters[group] === value ? ' selected' : '';
        return '<option value="' + value + '"' + selected + '>' + label + '</option>';
      }

      function bindFilters() {
        ['provider-filter', 'status-filter', 'search-filter', 'sort-filter', 'latency-filter', 'wer-filter'].forEach((id) => {
          const node = document.getElementById(id);
          if (!node) return;
          node.addEventListener('input', updateFiltersFromDom);
          node.addEventListener('change', updateFiltersFromDom);
        });
      }

      async function updateRunFiltersFromDom() {
        state.runFilters.provider = document.getElementById('run-filter-provider').value;
        state.runFilters.mode = document.getElementById('run-filter-mode').value;
        state.runFilters.failures = document.getElementById('run-filter-failures').value;
        state.runFilters.query = document.getElementById('run-filter-query').value.trim();
        await loadRuns();
      }

      function updateRunFormFromDom() {
        state.runForm.mode = document.getElementById('run-form-mode').value;
        state.runForm.inputPath = document.getElementById('run-form-input').value.trim();
        state.runForm.manifestPath = document.getElementById('run-form-manifest').value.trim();
        state.runForm.referenceDir = document.getElementById('run-form-reference-dir').value.trim();
        state.runForm.rounds = document.getElementById('run-form-rounds').value.trim();
        state.runForm.durationMs = document.getElementById('run-form-duration').value.trim();
        state.runForm.concurrency = document.getElementById('run-form-concurrency').value.trim();
        state.runForm.intervalMs = document.getElementById('run-form-interval').value.trim();
        state.runForm.referenceSidecar = document.getElementById('run-form-sidecar').checked;
        state.runForm.providerIds = Array.from(document.querySelectorAll('.run-provider-checkbox'))
          .filter((node) => node.checked)
          .map((node) => node.value);
        state.runFormErrors = {};
        state.runFormMessage = '';
      }

      function applyDemoDatasetPreset() {
        if (!state.demoAssets) return;
        state.runForm.inputPath = state.demoAssets.demo_input_path || state.runForm.inputPath;
        state.runForm.manifestPath = state.demoAssets.demo_manifest_path || state.runForm.manifestPath;
        state.runForm.referenceSidecar = true;
        state.runForm.referenceDir = '';
        state.runFormMessage = 'Loaded demo dataset paths.';
        renderRunCreateControls();
      }

      function applyDemoProviderPreset() {
        const match = state.providers.find((provider) => provider.provider_id === 'openai-whisper-demo');
        if (!match) {
          state.runFormMessage = 'Demo provider is only available when the UI is started with --config examples/demo-provider.';
          renderRunCreateControls();
          return;
        }
        state.runForm.providerIds = [match.provider_id];
        state.runFormMessage = 'Selected demo provider.';
        renderRunCreateControls();
      }

      function validateRunForm() {
        const errors = {};
        if (!state.runForm.inputPath) errors.inputPath = 'Input path is required.';
        if (!state.runForm.providerIds.length) errors.providerIds = 'Select at least one provider.';

        const rounds = Number.parseInt(state.runForm.rounds || '1', 10);
        const durationMs = Number.parseInt(state.runForm.durationMs || '30000', 10);
        const concurrency = Number.parseInt(state.runForm.concurrency || '1', 10);
        const intervalMs = Number.parseInt(state.runForm.intervalMs || '0', 10);

        if (state.runForm.mode === 'once' && (!Number.isFinite(rounds) || rounds < 1)) {
          errors.rounds = 'Rounds must be >= 1.';
        }
        if (state.runForm.mode === 'duration' && (!Number.isFinite(durationMs) || durationMs < 1)) {
          errors.durationMs = 'Duration must be >= 1 ms.';
        }
        if (!Number.isFinite(concurrency) || concurrency < 1) {
          errors.concurrency = 'Concurrency must be >= 1.';
        }
        if (!Number.isFinite(intervalMs) || intervalMs < 0) {
          errors.intervalMs = 'Interval must be >= 0.';
        }

        return errors;
      }

      function hasActiveJobs() {
        return state.jobs.some((job) => job.status === 'queued' || job.status === 'running');
      }

      function scheduleJobPolling() {
        if (window.__asrBenchJobPollTimer) {
          clearTimeout(window.__asrBenchJobPollTimer);
          window.__asrBenchJobPollTimer = null;
        }
        if (hasActiveJobs()) {
          window.__asrBenchJobPollTimer = setTimeout(() => {
            loadJobs().catch((error) => {
              state.runFormMessage = error && error.message ? error.message : String(error);
              renderRunSidebarControls();
            });
          }, 1500);
        }
      }

      async function submitRunForm() {
        updateRunFormFromDom();
        const localErrors = validateRunForm();
        if (Object.keys(localErrors).length > 0) {
          state.runFormErrors = localErrors;
          renderRunCreateControls();
          return;
        }

        state.isSubmittingRun = true;
        state.runFormMessage = '';
        renderRunCreateControls();
        try {
          const payload = {
            mode: state.runForm.mode,
            providerIds: state.runForm.providerIds,
            inputPath: state.runForm.inputPath,
            rounds: Number.parseInt(state.runForm.rounds || '1', 10),
            durationMs: Number.parseInt(state.runForm.durationMs || '30000', 10),
            concurrency: Number.parseInt(state.runForm.concurrency || '1', 10),
            intervalMs: Number.parseInt(state.runForm.intervalMs || '0', 10),
            manifestPath: state.runForm.manifestPath || undefined,
            referenceSidecar: state.runForm.referenceSidecar,
            referenceDir: state.runForm.referenceDir || undefined,
          };

          const response = await fetch('/api/run', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          });
          const data = await response.json();
          if (response.status === 400) {
            state.runFormErrors = data && data.field_errors ? data.field_errors : {};
            state.runFormMessage = data && data.message ? data.message : 'Please fix the highlighted fields.';
            renderRunCreateControls();
            return;
          }
          if (!response.ok) {
            throw new Error(data && data.message ? data.message : 'Run creation failed');
          }
          state.runFormErrors = {};
          state.runFormMessage = 'Run queued in the background. The jobs panel will update automatically.';
          await loadJobs();
        } catch (error) {
          state.runFormMessage = error && error.message ? error.message : String(error);
        } finally {
          state.isSubmittingRun = false;
          renderRunCreateControls();
        }
      }

      function updateFiltersFromDom() {
        state.filters.provider = document.getElementById('provider-filter').value;
        state.filters.status = document.getElementById('status-filter').value;
        state.filters.search = document.getElementById('search-filter').value.trim().toLowerCase();
        state.filters.sort = document.getElementById('sort-filter').value;
        state.filters.minLatency = document.getElementById('latency-filter').value.trim();
        state.filters.minWer = document.getElementById('wer-filter').value.trim();
        renderActiveRun();
      }

      function filteredAttempts() {
        const attempts = state.activeRun?.attempts || [];
        const minLatency = Number.parseFloat(state.filters.minLatency);
        const minWer = Number.parseFloat(state.filters.minWer);

        const rows = attempts.filter((row) => {
          if (state.filters.provider !== 'all' && row.provider_id !== state.filters.provider) return false;
          if (state.filters.status === 'success' && !row.success) return false;
          if (state.filters.status === 'failure' && row.success) return false;
          if (state.filters.status === 'high_latency' && !(Number(row.latency_ms) >= (Number.isFinite(minLatency) ? minLatency : 1000))) return false;
          if (state.filters.status === 'high_wer' && !((row.evaluation?.word_error_rate ?? -1) >= (Number.isFinite(minWer) ? minWer : 0.2))) return false;

          const haystack = [
            row.provider_id,
            row.audio_id,
            row.audio_path,
            row.audio_language,
            row.audio_speaker,
            (row.audio_tags || []).join(' '),
            row.error?.type,
            row.normalized_result?.text,
            row.evaluation?.reference_text,
          ].filter(Boolean).join(' ').toLowerCase();

          if (state.filters.search && !haystack.includes(state.filters.search)) return false;
          if (Number.isFinite(minLatency) && Number(row.latency_ms) < minLatency) return false;
          if (Number.isFinite(minWer) && (row.evaluation?.word_error_rate ?? -1) < minWer) return false;
          return true;
        });

        return rows.sort(sortAttemptRows);
      }

      function sortAttemptRows(a, b) {
        switch (state.filters.sort) {
          case 'latency_asc':
            return Number(a.latency_ms) - Number(b.latency_ms);
          case 'wer_desc':
            return Number(b.evaluation?.word_error_rate ?? -1) - Number(a.evaluation?.word_error_rate ?? -1);
          case 'retry_desc':
            return Number(b.retry_count) - Number(a.retry_count);
          case 'recent_desc':
            return String(b.started_at).localeCompare(String(a.started_at));
          case 'latency_desc':
          default:
            return Number(b.latency_ms) - Number(a.latency_ms);
        }
      }

      function renderAttemptTable(rows, selectedAttempt) {
        if (!rows.length) return '<div class="empty">No attempts match the current filters.</div>';
        return '<table><thead><tr><th>provider</th><th>audio</th><th>latency</th><th>retry</th><th>status</th><th>WER</th><th>CER</th><th>text</th></tr></thead><tbody>' +
          rows.map((row) => {
            const active = selectedAttempt && row.attempt_id === selectedAttempt.attempt_id ? ' active' : '';
            const text = row.normalized_result?.text || '';
            const audioMeta = [row.audio_language, row.audio_speaker, (row.audio_tags || []).join(', ')].filter(Boolean).join(' · ');
            return '<tr class="attempt-row' + active + '" data-attempt-id="' + row.attempt_id + '">' +
              '<td>' + escapeHtml(row.provider_id) + '</td>' +
              '<td><div>' + escapeHtml(row.audio_id) + '</div>' + (audioMeta ? '<div class="muted" style="margin-top:4px;font-size:11px;">' + escapeHtml(audioMeta) + '</div>' : '') + '</td>' +
              '<td>' + fmt(row.latency_ms) + '</td>' +
              '<td>' + fmt(row.retry_count) + '</td>' +
              '<td>' + (row.success ? '<span class="tag">ok</span>' : '<span class="tag alert">' + escapeHtml(fmt(row.error?.type)) + '</span>') + '</td>' +
              '<td>' + fmt(row.evaluation?.word_error_rate) + '</td>' +
              '<td>' + fmt(row.evaluation?.char_error_rate) + '</td>' +
              '<td>' + escapeHtml(text.slice(0, 100)) + (text.length > 100 ? '...' : '') + '</td>' +
            '</tr>';
          }).join('') +
          '</tbody></table>';
      }

      function bindAttemptRows() {
        document.querySelectorAll('[data-attempt-id]').forEach((node) => {
          node.addEventListener('click', async () => {
            state.selectedAttemptId = node.getAttribute('data-attempt-id');
            await ensureRawAttemptLoaded(state.selectedAttemptId);
            renderActiveRun();
          });
        });
      }

      function resolveSelectedAttempt(filtered, allAttempts) {
        if (state.selectedAttemptId) {
          const match = filtered.find((item) => item.attempt_id === state.selectedAttemptId) || allAttempts.find((item) => item.attempt_id === state.selectedAttemptId);
          if (match) return match;
        }
        return filtered[0] || allAttempts[0] || null;
      }

      function renderAttemptDetail(row) {
        if (!row) {
          return '<div class="detail-block empty">Select an attempt to inspect transcript diff and failure details.</div>';
        }

        const text = row.normalized_result?.text || '';
        const reference = row.evaluation?.reference_text || '';
        const diffHtml = reference ? renderWordDiff(reference, text) : '<div class="muted">No reference transcript attached for this attempt.</div>';
        const rawAttempt = state.rawAttemptById[row.attempt_id];
        const metadata = {
          attempt_id: row.attempt_id,
          provider_id: row.provider_id,
          audio_id: row.audio_id,
          audio_path: row.audio_path,
          audio_language: row.audio_language,
          audio_speaker: row.audio_speaker,
          audio_tags: row.audio_tags,
          audio_reference_path: row.audio_reference_path,
          latency_ms: row.latency_ms,
          retry_count: row.retry_count,
          request_attempts: row.request_attempts,
          http_status: row.http_status,
          status: row.success ? 'ok' : row.error?.type || 'failed',
        };

        return '<div class="detail-stack">' +
          '<div class="detail-block">' +
            '<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;flex-wrap:wrap;">' +
              '<h3>Attempt Detail</h3>' +
              (row.success ? '<span class="tag">success</span>' : '<span class="tag alert">failure</span>') +
            '</div>' +
            '<pre style="margin-top:12px;">' + escapeHtml(JSON.stringify(metadata, null, 2)) + '</pre>' +
          '</div>' +
          '<div class="detail-block">' +
            '<h4>Failure Diagnostics</h4>' +
            '<pre style="margin-top:12px;">' + escapeHtml(row.error ? JSON.stringify(row.error, null, 2) : 'No error for this attempt.') + '</pre>' +
          '</div>' +
          '<div class="detail-block">' +
            '<h4>Raw Attempt Artifact</h4>' +
            '<pre style="margin-top:12px;">' + escapeHtml(rawAttempt ? JSON.stringify(rawAttempt, null, 2) : 'Loading raw attempt artifact...') + '</pre>' +
          '</div>' +
          '<div class="detail-block">' +
            '<h4>Transcript Diff</h4>' +
            '<div style="margin-top:12px;">' + diffHtml + '</div>' +
          '</div>' +
          '<div class="detail-block">' +
            '<h4>Reference Transcript</h4>' +
            '<pre style="margin-top:12px;">' + escapeHtml(reference || 'No reference transcript.') + '</pre>' +
          '</div>' +
          '<div class="detail-block">' +
            '<h4>Hypothesis Transcript</h4>' +
            '<pre style="margin-top:12px;">' + escapeHtml(text || 'No normalized transcript.') + '</pre>' +
          '</div>' +
        '</div>';
      }

      function renderWordDiff(referenceText, hypothesisText) {
        const ref = tokenize(referenceText);
        const hyp = tokenize(hypothesisText);
        const matrix = Array.from({ length: ref.length + 1 }, () => Array(hyp.length + 1).fill(0));

        for (let i = 0; i <= ref.length; i += 1) matrix[i][0] = i;
        for (let j = 0; j <= hyp.length; j += 1) matrix[0][j] = j;

        for (let i = 1; i <= ref.length; i += 1) {
          for (let j = 1; j <= hyp.length; j += 1) {
            const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
              matrix[i - 1][j] + 1,
              matrix[i][j - 1] + 1,
              matrix[i - 1][j - 1] + cost,
            );
          }
        }

        const ops = [];
        let i = ref.length;
        let j = hyp.length;
        while (i > 0 || j > 0) {
          if (i > 0 && j > 0 && ref[i - 1] === hyp[j - 1]) {
            ops.push({ type: 'same', ref: ref[i - 1], hyp: hyp[j - 1] });
            i -= 1;
            j -= 1;
            continue;
          }

          const sub = i > 0 && j > 0 ? matrix[i - 1][j - 1] : Number.POSITIVE_INFINITY;
          const del = i > 0 ? matrix[i - 1][j] : Number.POSITIVE_INFINITY;
          const ins = j > 0 ? matrix[i][j - 1] : Number.POSITIVE_INFINITY;
          const min = Math.min(sub, del, ins);

          if (min === sub) {
            ops.push({ type: 'replace', ref: ref[i - 1], hyp: hyp[j - 1] });
            i -= 1;
            j -= 1;
          } else if (min === del) {
            ops.push({ type: 'delete', ref: ref[i - 1] });
            i -= 1;
          } else {
            ops.push({ type: 'insert', hyp: hyp[j - 1] });
            j -= 1;
          }
        }

        return ops.reverse().map((op) => {
          if (op.type === 'same') return '<span class="diff-chip same">' + escapeHtml(op.hyp) + '</span>';
          if (op.type === 'delete') return '<span class="diff-chip delete">-' + escapeHtml(op.ref) + '</span>';
          if (op.type === 'insert') return '<span class="diff-chip insert">+' + escapeHtml(op.hyp) + '</span>';
          return '<span class="diff-chip delete">-' + escapeHtml(op.ref) + '</span><span class="diff-chip insert">+' + escapeHtml(op.hyp) + '</span>';
        }).join(' ');
      }

      function tokenize(text) {
        const normalized = String(text || '').toLowerCase().trim();
        if (!normalized) return [];
        return normalized.split(/\\s+/).filter(Boolean);
      }

      async function ensureRawAttemptLoaded(attemptId) {
        if (!attemptId || state.rawAttemptById[attemptId] || !state.activeRunId) {
          return;
        }
        try {
          const response = await fetch('/api/runs/' + encodeURIComponent(state.activeRunId) + '/attempts/' + encodeURIComponent(attemptId) + '/raw');
          if (!response.ok) {
            state.rawAttemptById[attemptId] = { error: 'raw_attempt_not_found' };
            return;
          }
          state.rawAttemptById[attemptId] = await response.json();
        } catch (error) {
          state.rawAttemptById[attemptId] = { error: error && error.message ? error.message : String(error) };
        }
      }

      Promise.all([loadProviders(), loadProviderCapabilities(), loadDemoAssets(), loadJobs(), loadRuns()]).catch((error) => {
        document.getElementById('content').innerHTML = '<section class="panel empty">Failed to load runs: ' + escapeHtml(error.message || String(error)) + '</section>';
      });
    </script>
  </body>
</html>`;
}

async function readRawAttemptArtifact(attemptsPath: string, attemptId: string): Promise<unknown | undefined> {
  const rawPath = path.join(path.dirname(attemptsPath), 'raw', `${attemptId}.json`);
  try {
    const payload = await fs.readFile(rawPath, 'utf8');
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}
