import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runOnce } from '../src/services/runOnceService.js';

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

test('runOnce writes attempts and summary artifacts', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'audioapibench-runonce-'));
  const providerDir = path.join(tempRoot, 'providers');
  const audioDir = path.join(tempRoot, 'audio');
  const outputDir = path.join(tempRoot, 'artifacts');
  await fs.mkdir(providerDir, { recursive: true });
  await fs.mkdir(audioDir, { recursive: true });

  await fs.writeFile(
    path.join(providerDir, 'provider.yaml'),
    [
      'provider_id: openai-whisper',
      'name: OpenAI Whisper',
      'type: openai_compatible',
      'base_url: https://api.example.com/v1',
      'api_key: test-key',
      'default_model: gpt-4o-mini-transcribe',
      'adapter_options:',
      '  operation: audio_transcriptions',
    ].join('\n'),
    'utf8',
  );

  await createTempAudioFile(audioDir, 'a.wav');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        text: 'hello world',
        language: 'en',
        duration: 1.0,
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      },
    )) as typeof fetch;

  try {
    const summary = await runOnce({
      configPath: providerDir,
      providerIds: ['openai-whisper'],
      inputPath: audioDir,
      rounds: 2,
      outputRoot: outputDir,
    });

    assert.equal(summary.rounds, 2);
    assert.equal(summary.attempt_count, 2);
    assert.equal(summary.success_count, 2);
    assert.equal(summary.provider_summaries.length, 1);
    assert.equal(summary.provider_summaries[0]?.attempt_count, 2);
    assert.equal(summary.p50_latency_ms !== undefined, true);
    assert.equal(summary.p90_latency_ms !== undefined, true);
    assert.equal(summary.failure_type_counts.client_error ?? 0, 0);
    assert.equal(summary.average_rtf !== undefined, true);

    const attemptsJsonl = await fs.readFile(summary.attempts_path, 'utf8');
    assert.match(attemptsJsonl, /hello world/);
    assert.match(attemptsJsonl, /"round_index":2/);
    assert.match(attemptsJsonl, /"audio_duration_ms":1000/);

    const summaryJson = JSON.parse(await fs.readFile(summary.summary_path, 'utf8'));
    assert.equal(summaryJson.success_count, 2);
    assert.equal(summaryJson.provider_summaries[0].failure_type_counts.client_error ?? 0, 0);

    const csv = await fs.readFile(summary.csv_path, 'utf8');
    assert.match(csv, /provider_id,audio_id,audio_path,audio_duration_ms/);
    assert.match(csv, /audio_duration_ms/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
