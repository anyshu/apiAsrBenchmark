import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenRouterAdapter } from '../src/providers/openRouterAdapter.js';
import type {
  BuiltHttpRequest,
  NormalizedAsrResult,
  ProviderConfig,
  ProviderExecutionResult,
  ProviderRequestInput,
} from '../src/domain/types.js';
import { createAudioAsset } from '../src/utils/audio.js';

async function createTempAudioFile(ext = 'wav'): Promise<string> {
  const filePath = path.join(os.tmpdir(), `audioapibench-openrouter-${Date.now()}.${ext}`);
  await fs.writeFile(filePath, Buffer.from('RIFFTESTDATA'));
  return filePath;
}

test('applies OpenRouter chat audio defaults through the dedicated adapter', async () => {
  const filePath = await createTempAudioFile('wav');
  const audio = await createAudioAsset(filePath);
  const provider: ProviderConfig = {
    provider_id: 'openrouter-mimo-omni',
    name: 'OpenRouter MiMo Omni Audio Chat',
    type: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    api_key: 'test-key',
    default_model: 'xiaomi/mimo-v2-omni',
  };

  const adapter = new OpenRouterAdapter();
  const request = await adapter.buildRequest({ provider, audio });
  const payload = JSON.parse(request.body as string);

  assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(request.bodyKind, 'json');
  assert.equal(payload.messages[0].content[1].type, 'input_audio');
  assert.equal(payload.messages[0].content[1].inputAudio.format, 'wav');
});

test('retries OpenRouter execution with the legacy snake_case audio key when the first shape is ignored', async () => {
  const filePath = await createTempAudioFile('wav');
  const audio = await createAudioAsset(filePath);
  const provider: ProviderConfig = {
    provider_id: 'openrouter-mimo-omni',
    name: 'OpenRouter MiMo Omni Audio Chat',
    type: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    api_key: 'test-key',
    default_model: 'xiaomi/mimo-v2-omni',
  };

  const seenInputKeys: string[] = [];
  const stubAdapter = {
    async validateConfig(): Promise<void> {},
    async buildRequest(input: ProviderRequestInput): Promise<BuiltHttpRequest> {
      return {
        method: 'POST',
        url: input.provider.base_url,
        headers: {},
        bodyKind: 'json',
        body: '{}',
        debugPreview: {},
      };
    },
    async execute(input: ProviderRequestInput): Promise<ProviderExecutionResult> {
      const options = (input.provider.adapter_options ?? {}) as Record<string, string>;
      seenInputKeys.push(options.chat_audio_input_key ?? 'missing');
      if (options.chat_audio_input_key === 'inputAudio') {
        return {
          ok: true,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          rawJson: {
            choices: [
              {
                message: {
                  content: "I don't see an audio file attached to your message.",
                },
              },
            ],
          },
        };
      }

      return {
        ok: true,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        rawJson: {
          choices: [
            {
              message: {
                content: 'hello world',
              },
            },
          ],
        },
      };
    },
    async normalize(): Promise<NormalizedAsrResult> {
      return { text: 'hello world' };
    },
  } as unknown as any;

  const adapter = new OpenRouterAdapter(stubAdapter);
  const result = await adapter.execute({ provider, audio });

  assert.equal(result.ok, true);
  assert.deepEqual(seenInputKeys, ['inputAudio', 'input_audio']);
});

test('does not retry when OpenRouter is already pinned to the snake_case audio key', async () => {
  const filePath = await createTempAudioFile('wav');
  const audio = await createAudioAsset(filePath);
  const provider: ProviderConfig = {
    provider_id: 'openrouter-mimo-omni',
    name: 'OpenRouter MiMo Omni Audio Chat',
    type: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    api_key: 'test-key',
    default_model: 'xiaomi/mimo-v2-omni',
    adapter_options: {
      chat_audio_input_key: 'input_audio',
    },
  };

  let executeCount = 0;
  const stubAdapter = {
    async validateConfig(): Promise<void> {},
    async buildRequest(input: ProviderRequestInput): Promise<BuiltHttpRequest> {
      return {
        method: 'POST',
        url: input.provider.base_url,
        headers: {},
        bodyKind: 'json',
        body: '{}',
        debugPreview: {},
      };
    },
    async execute(): Promise<ProviderExecutionResult> {
      executeCount += 1;
      return {
        ok: false,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        rawBodyText: '{"error":"Multimodal data is corrupted or cannot be processed."}',
        error: {
          type: 'client_error',
          message: 'HTTP 400',
        },
      };
    },
    async normalize(): Promise<NormalizedAsrResult> {
      return { text: '' };
    },
  } as unknown as any;

  const adapter = new OpenRouterAdapter(stubAdapter);
  await adapter.execute({ provider, audio });

  assert.equal(executeCount, 1);
});
