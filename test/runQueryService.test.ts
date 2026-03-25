import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runOnce } from '../src/services/runOnceService.js';
import { exportRun, listRuns, showRun } from '../src/services/runQueryService.js';

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

test('run query service lists, shows, and exports SQLite runs', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'audioapibench-runquery-'));
  const providerDir = path.join(tempRoot, 'providers');
  const audioDir = path.join(tempRoot, 'audio');
  const outputDir = path.join(tempRoot, 'artifacts');
  const dbPath = path.join(tempRoot, 'bench.sqlite');
  const exportPath = path.join(tempRoot, 'exports', 'run.csv');
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
        text: 'query service hello',
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
    });

    const runs = await listRuns({ dbPath, limit: 10 });
    assert.equal(runs[0]?.run_id, summary.run_id);

    const filteredByProvider = await listRuns({
      dbPath,
      providerId: 'openai-whisper',
      limit: 10,
    });
    assert.equal(filteredByProvider.length, 1);

    const filteredByMode = await listRuns({
      dbPath,
      mode: 'once',
      hasFailures: false,
      query: 'audio',
      limit: 10,
    });
    assert.equal(filteredByMode[0]?.run_id, summary.run_id);

    const shown = await showRun({ dbPath, runId: summary.run_id, includeAttempts: true });
    assert.equal(shown.summary.run_id, summary.run_id);
    assert.equal(shown.attempts.length, 1);

    const jsonl = await exportRun({ dbPath, runId: summary.run_id, format: 'jsonl' });
    assert.match(jsonl.content, /query service hello/);

    const csv = await exportRun({
      dbPath,
      runId: summary.run_id,
      format: 'csv',
      outputPath: exportPath,
    });
    assert.equal(csv.outputPath, path.resolve(exportPath));

    const savedCsv = await fs.readFile(exportPath, 'utf8');
    assert.match(savedCsv, /provider_id/);
    assert.match(savedCsv, /query service hello/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
