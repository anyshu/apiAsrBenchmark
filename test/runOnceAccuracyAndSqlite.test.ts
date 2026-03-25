import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runOnce } from '../src/services/runOnceService.js';
import { getRunDetailFromSqlite } from '../src/services/sqliteStore.js';

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

test('runOnce computes WER/CER and persists runs into SQLite', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'audioapibench-accuracy-'));
  const providerDir = path.join(tempRoot, 'providers');
  const audioDir = path.join(tempRoot, 'audio');
  const outputDir = path.join(tempRoot, 'artifacts');
  const dbPath = path.join(tempRoot, 'bench.sqlite');
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
  await fs.writeFile(path.join(audioDir, 'a.txt'), 'hello world\n', 'utf8');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        text: 'hello brave world',
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
      rounds: 1,
      outputRoot: outputDir,
      dbPath,
      referenceSidecar: true,
    });

    assert.equal(summary.evaluated_attempt_count, 1);
    assert.equal(summary.average_wer, 0.5);
    assert.ok(summary.average_cer !== undefined);
    assert.equal(path.resolve(dbPath), summary.database_path);

    const detail = await getRunDetailFromSqlite(dbPath, summary.run_id);
    assert.ok(detail);
    assert.equal(detail?.attempts.length, 1);
    assert.equal(detail?.attempts[0]?.evaluation?.word_error_rate, 0.5);
    assert.match(detail?.attempts[0]?.evaluation?.reference_text ?? '', /hello world/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
