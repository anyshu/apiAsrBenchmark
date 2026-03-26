import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeRunJob, validateRunSubmission } from '../src/services/uiServer.js';
import type { UiRunJob } from '../src/services/uiServer.js';

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

test('ui server validation rejects missing paths and providers', async () => {
  const validation = await validateRunSubmission(
    {
      mode: 'once',
      providerIds: [],
      inputPath: '/definitely/missing',
    },
    ['openai-whisper-demo'],
  );

  assert.equal(validation.ok, false);
  assert.match(validation.fieldErrors.inputPath ?? '', /does not exist/i);
  assert.match(validation.fieldErrors.providerIds ?? '', /select at least one provider/i);
});

test('ui server validation keeps provider API key overrides for the selected providers', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'audioapibench-ui-keys-'));
  const audioDir = path.join(tempRoot, 'audio');
  await fs.mkdir(audioDir, { recursive: true });
  await createTempAudioFile(audioDir, 'sample.wav');

  const validation = await validateRunSubmission(
    {
      mode: 'once',
      providerIds: ['openai-whisper-demo'],
      providerApiKeys: {
        'openai-whisper-demo': ' test-key ',
        ignored: 'should-not-matter',
      },
      inputPath: audioDir,
    },
    ['openai-whisper-demo'],
  );

  assert.equal(validation.ok, true);
  assert.deepEqual(validation.value?.providerApiKeys, {
    'openai-whisper-demo': 'test-key',
  });
});

test('ui server background job runner persists manifest metadata', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'audioapibench-ui-job-'));
  const providerDir = path.join(tempRoot, 'providers');
  const audioDir = path.join(tempRoot, 'audio');
  const dbPath = path.join(tempRoot, 'artifacts', 'bench.sqlite');
  await fs.mkdir(providerDir, { recursive: true });
  await fs.mkdir(audioDir, { recursive: true });

  await createTempAudioFile(audioDir, 'speaker-a.wav');
  await fs.writeFile(
    path.join(audioDir, 'dataset.manifest.json'),
    JSON.stringify(
      {
        items: [
          {
            path: 'speaker-a.wav',
            language: 'zh',
            speaker: 'speaker-a',
            tags: ['demo', 'far-field'],
            reference_text: 'hello from background job',
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  await fs.writeFile(
    path.join(providerDir, 'provider.yaml'),
    [
      'provider_id: openai-whisper-demo',
      'name: OpenAI Whisper Demo',
      'type: openai_compatible',
      'base_url: https://api.example.com/v1',
      'api_key_env: OPENAI_API_KEY',
      'default_model: gpt-4o-mini-transcribe',
      'adapter_options:',
      '  operation: audio_transcriptions',
    ].join('\n'),
    'utf8',
  );

  const validation = await validateRunSubmission(
    {
      mode: 'once',
      providerIds: ['openai-whisper-demo'],
      providerApiKeys: {
        'openai-whisper-demo': 'ui-key-override',
      },
      inputPath: audioDir,
      manifestPath: path.join(audioDir, 'dataset.manifest.json'),
    },
    ['openai-whisper-demo'],
  );

  assert.equal(validation.ok, true);
  assert.ok(validation.value);

  const job: UiRunJob = {
    job_id: 'job_test',
    status: 'queued',
    created_at: new Date().toISOString(),
    request: validation.value!,
  };
  const jobs = new Map([[job.job_id, job]]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        text: 'hello from background job',
        language: 'zh',
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
    await executeRunJob(job, { configPath: providerDir, dbPath }, jobs);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const completedJob = jobs.get(job.job_id);
  assert.equal(completedJob?.status, 'succeeded');
  assert.ok(completedJob?.summary?.attempts_path);
  assert.equal(job.request.providerApiKeys['openai-whisper-demo'], 'ui-key-override');

  const attemptsJsonl = await fs.readFile(completedJob!.summary!.attempts_path, 'utf8');
  assert.match(attemptsJsonl, /"audio_language":"zh"/);
  assert.match(attemptsJsonl, /"audio_speaker":"speaker-a"/);
  assert.match(attemptsJsonl, /"audio_tags":\["demo","far-field"\]/);
});

test('ui server background job runner supports cooperative cancellation', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'audioapibench-ui-cancel-'));
  const providerDir = path.join(tempRoot, 'providers');
  const audioDir = path.join(tempRoot, 'audio');
  const dbPath = path.join(tempRoot, 'artifacts', 'bench.sqlite');
  await fs.mkdir(providerDir, { recursive: true });
  await fs.mkdir(audioDir, { recursive: true });

  await createTempAudioFile(audioDir, 'a.wav');
  await fs.writeFile(
    path.join(providerDir, 'provider.yaml'),
    [
      'provider_id: openai-whisper-demo',
      'name: OpenAI Whisper Demo',
      'type: openai_compatible',
      'base_url: https://api.example.com/v1',
      'api_key_env: OPENAI_API_KEY',
      'default_model: gpt-4o-mini-transcribe',
      'adapter_options:',
      '  operation: audio_transcriptions',
    ].join('\n'),
    'utf8',
  );

  const validation = await validateRunSubmission(
    {
      mode: 'once',
      providerIds: ['openai-whisper-demo'],
      providerApiKeys: {
        'openai-whisper-demo': 'ui-key-override',
      },
      inputPath: audioDir,
      rounds: 3,
    },
    ['openai-whisper-demo'],
  );

  assert.equal(validation.ok, true);
  assert.ok(validation.value);

  const job: UiRunJob = {
    job_id: 'job_cancel',
    status: 'queued',
    created_at: new Date().toISOString(),
    request: validation.value!,
  };
  const jobs = new Map([[job.job_id, job]]);

  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    callCount += 1;
    if (callCount === 1) {
      job.cancel_requested = true;
    }
    return new Response(
      JSON.stringify({
        text: 'cancel me',
        language: 'en',
        duration: 1.0,
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      },
    );
  }) as typeof fetch;

  try {
    await executeRunJob(job, { configPath: providerDir, dbPath }, jobs);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const completedJob = jobs.get(job.job_id);
  assert.equal(completedJob?.status, 'cancelled');
  assert.equal(completedJob?.summary?.attempt_count, 1);
  assert.equal(completedJob?.progress?.completed_attempts, 1);
});
