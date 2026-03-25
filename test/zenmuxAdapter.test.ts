import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ZenMuxAdapter } from '../src/providers/zenmuxAdapter.js';
import type { ProviderConfig } from '../src/domain/types.js';
import { createAudioAsset } from '../src/utils/audio.js';

async function createTempAudioFile(ext = 'wav'): Promise<string> {
  const filePath = path.join(os.tmpdir(), `audioapibench-zenmux-${Date.now()}.${ext}`);
  await fs.writeFile(filePath, Buffer.from('RIFFTESTDATA'));
  return filePath;
}

test('applies ZenMux chat audio defaults through the dedicated adapter', async () => {
  const filePath = await createTempAudioFile('wav');
  const audio = await createAudioAsset(filePath);
  const provider: ProviderConfig = {
    provider_id: 'zenmux-gemini-chat',
    name: 'ZenMux Gemini Audio Chat',
    type: 'zenmux',
    base_url: 'https://zenmux.ai/api/v1',
    api_key: 'test-key',
    default_model: 'google/gemini-2.5-pro',
  };

  const adapter = new ZenMuxAdapter();
  const request = await adapter.buildRequest({ provider, audio });
  const payload = JSON.parse(request.body as string);

  assert.equal(request.url, 'https://zenmux.ai/api/v1/chat/completions');
  assert.equal(request.bodyKind, 'json');
  assert.equal(payload.messages[0].content[1].type, 'input_audio');
  assert.equal(payload.messages[0].content[1].input_audio.format, 'wav');
});
