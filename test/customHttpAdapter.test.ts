import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CustomHttpAdapter } from '../src/providers/customHttpAdapter.js';
import type { ProviderConfig } from '../src/domain/types.js';
import { createAudioAsset } from '../src/utils/audio.js';

async function createTempAudioFile(ext = 'wav'): Promise<string> {
  const filePath = path.join(os.tmpdir(), `audioapibench-custom-${Date.now()}.${ext}`);
  await fs.writeFile(filePath, Buffer.from('RIFFTESTDATA'));
  return filePath;
}

test('builds a custom multipart request', async () => {
  const filePath = await createTempAudioFile('wav');
  const audio = await createAudioAsset(filePath);
  const provider: ProviderConfig = {
    provider_id: 'custom-http-demo',
    name: 'Custom HTTP Demo',
    type: 'custom_http',
    base_url: 'https://example.com',
    api_key: 'test-key',
    default_model: 'demo-model',
    adapter_options: {
      endpoint: {
        method: 'POST',
        path: '/asr/recognize',
      },
      request: {
        content_type: 'multipart',
        file_field: 'audio',
        model_field: 'model',
        fields: {
          engine: 'fast',
        },
      },
      response_mapping: {
        transcript_path: '$.result.text',
      },
    },
  };

  const adapter = new CustomHttpAdapter();
  const request = await adapter.buildRequest({ provider, audio });

  assert.equal(request.url, 'https://example.com/asr/recognize');
  assert.equal(request.bodyKind, 'multipart');
  assert.equal(request.debugPreview.content_type, 'multipart');
});

test('normalizes custom response mappings', async () => {
  const provider: ProviderConfig = {
    provider_id: 'custom-http-demo',
    name: 'Custom HTTP Demo',
    type: 'custom_http',
    base_url: 'https://example.com',
    api_key: 'test-key',
    adapter_options: {
      endpoint: {
        method: 'POST',
        path: '/asr/recognize',
      },
      request: {
        content_type: 'json',
        file_base64_field: 'audio_base64',
      },
      response_mapping: {
        transcript_path: '$.result.text',
        language_path: '$.result.language',
        duration_path: '$.result.duration_ms',
      },
    },
  };

  const adapter = new CustomHttpAdapter();
  const normalized = await adapter.normalize({
    provider,
    executionResult: {
      ok: true,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      rawJson: {
        result: {
          text: 'hello from custom',
          language: 'en',
          duration_ms: 1530,
        },
      },
    },
  });

  assert.equal(normalized.text, 'hello from custom');
  assert.equal(normalized.language, 'en');
  assert.equal(normalized.duration_ms, 1530);
});
