import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenAICompatibleAdapter } from '../src/providers/openaiCompatibleAdapter.js';
import type { ProviderConfig } from '../src/domain/types.js';
import { createAudioAsset } from '../src/utils/audio.js';

async function createTempAudioFile(ext = 'wav'): Promise<string> {
  const filePath = path.join(os.tmpdir(), `audioapibench-${Date.now()}.${ext}`);
  await fs.writeFile(filePath, Buffer.from('RIFFTESTDATA'));
  return filePath;
}

test('builds an audio transcriptions request', async () => {
  const filePath = await createTempAudioFile('wav');
  const audio = await createAudioAsset(filePath);
  const provider: ProviderConfig = {
    provider_id: 'openai-whisper',
    name: 'OpenAI Whisper',
    type: 'openai_compatible',
    base_url: 'https://api.example.com/v1',
    api_key: 'test-key',
    default_model: 'gpt-4o-mini-transcribe',
    adapter_options: {
      operation: 'audio_transcriptions',
    },
  };

  const adapter = new OpenAICompatibleAdapter();
  const request = await adapter.buildRequest({ provider, audio });

  assert.equal(request.url, 'https://api.example.com/v1/audio/transcriptions');
  assert.equal(request.bodyKind, 'multipart');
  assert.equal(request.debugPreview.operation, 'audio_transcriptions');
});

test('builds a chat completions audio request', async () => {
  const filePath = await createTempAudioFile('mp3');
  const audio = await createAudioAsset(filePath);
  const provider: ProviderConfig = {
    provider_id: 'zenmux-mimo-audio',
    name: 'ZenMux',
    type: 'openai_compatible',
    base_url: 'https://zenmux.ai/api/v1',
    api_key: 'test-key',
    default_model: 'xiaomi/mimo-v2-omni',
    adapter_options: {
      operation: 'chat_completions_audio',
      text_prompt: 'Transcribe this audio.',
    },
  };

  const adapter = new OpenAICompatibleAdapter();
  const request = await adapter.buildRequest({ provider, audio });
  const payload = JSON.parse(request.body as string);

  assert.equal(request.url, 'https://zenmux.ai/api/v1/chat/completions');
  assert.equal(payload.messages[0].content[1].type, 'input_audio');
  assert.equal(payload.messages[0].content[1].input_audio.format, 'mp3');
});

test('normalizes audio transcription output', async () => {
  const adapter = new OpenAICompatibleAdapter();
  const normalized = await adapter.normalize({
    provider: {
      provider_id: 'openai-whisper',
      name: 'OpenAI Whisper',
      type: 'openai_compatible',
      base_url: 'https://api.example.com/v1',
      api_key: 'test-key',
      adapter_options: {
        operation: 'audio_transcriptions',
      },
    },
    executionResult: {
      ok: true,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      rawJson: {
        text: 'hello world',
        language: 'en',
        duration: 1.2,
        segments: [{ start: 0, end: 1.2, text: 'hello world' }],
      },
    },
  });

  assert.equal(normalized.text, 'hello world');
  assert.equal(normalized.language, 'en');
  assert.equal(normalized.duration_ms, 1200);
  assert.equal(normalized.segments?.[0]?.text, 'hello world');
});
