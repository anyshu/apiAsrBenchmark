import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDuration } from '../src/services/runDurationService.js';
import { getRunDetailFromSqlite, listRunsFromSqlite } from '../src/services/sqliteStore.js';

async function createTempAudioFile(dir: string, name: string): Promise<string> {
  const filePath = path.join(dir, name);
  const sampleRate = 16000;
  const durationSeconds = 1;
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = sampleRate * durationSeconds * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  await fs.writeFile(filePath, buffer);
  return filePath;
}

test('runDuration honors provider runtime overrides, retries failures, and persists data for the UI', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'audioapibench-runduration-ui-'));
  const providerDir = path.join(tempRoot, 'providers');
  const audioDir = path.join(tempRoot, 'audio');
  const outputDir = path.join(tempRoot, 'artifacts');
  const dbPath = path.join(tempRoot, 'bench.sqlite');
  await fs.mkdir(providerDir, { recursive: true });
  await fs.mkdir(audioDir, { recursive: true });

  await fs.writeFile(
    path.join(providerDir, 'fast.yaml'),
    [
      'provider_id: fast-provider',
      'name: Fast Provider',
      'type: openai_compatible',
      'base_url: https://api.example.com/v1',
      'api_key: test-key',
      'default_model: gpt-4o-mini-transcribe',
      'headers:',
      '  x-provider-id: fast-provider',
      'retry_policy:',
      '  max_attempts: 2',
      '  backoff_ms: 1',
      'runner_options:',
      '  concurrency: 2',
      '  interval_ms: 0',
      'adapter_options:',
      '  operation: audio_transcriptions',
    ].join('\n'),
    'utf8',
  );

  await fs.writeFile(
    path.join(providerDir, 'slow.yaml'),
    [
      'provider_id: slow-provider',
      'name: Slow Provider',
      'type: openai_compatible',
      'base_url: https://api.example.com/v1',
      'api_key: test-key',
      'default_model: gpt-4o-mini-transcribe',
      'headers:',
      '  x-provider-id: slow-provider',
      'runner_options:',
      '  concurrency: 1',
      '  interval_ms: 25',
      'adapter_options:',
      '  operation: audio_transcriptions',
    ].join('\n'),
    'utf8',
  );

  await createTempAudioFile(audioDir, 'a.wav');

  const callCounts = new Map<string, number>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    const providerId = new Headers(init?.headers).get('x-provider-id') ?? 'unknown';
    const count = (callCounts.get(providerId) ?? 0) + 1;
    callCounts.set(providerId, count);
    await new Promise((resolve) => setTimeout(resolve, 5));

    if (providerId === 'fast-provider' && count === 1) {
      return new Response(JSON.stringify({ error: 'retry me' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({
        text: `${providerId} transcript`,
        language: 'en',
        duration: 1.0,
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof fetch;

  try {
    const summary = await runDuration({
      configPath: providerDir,
      providerIds: ['fast-provider', 'slow-provider'],
      inputPath: audioDir,
      durationMs: 80,
      concurrency: 1,
      intervalMs: 0,
      outputRoot: outputDir,
      dbPath,
    });

    const fastSummary = summary.provider_summaries.find((item) => item.provider_id === 'fast-provider');
    const slowSummary = summary.provider_summaries.find((item) => item.provider_id === 'slow-provider');

    assert.ok(fastSummary);
    assert.ok(slowSummary);
    assert.ok((fastSummary?.attempt_count ?? 0) > (slowSummary?.attempt_count ?? 0));
    assert.ok(summary.total_retry_count >= 1);

    const runs = await listRunsFromSqlite(dbPath);
    assert.equal(runs[0]?.run_id, summary.run_id);

    const detail = await getRunDetailFromSqlite(dbPath, summary.run_id);
    assert.equal(detail?.summary.run_id, summary.run_id);
    assert.ok(detail?.attempts.some((item) => item.retry_count >= 1));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
