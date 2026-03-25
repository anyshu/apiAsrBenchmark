import test from 'node:test';
import assert from 'node:assert/strict';
import { DefaultProviderSwitcher } from '../src/providers/switcher.js';
import { CustomHttpAdapter } from '../src/providers/customHttpAdapter.js';
import { OpenAICompatibleAdapter } from '../src/providers/openaiCompatibleAdapter.js';
import { ZenMuxAdapter } from '../src/providers/zenmuxAdapter.js';
import type { ProviderConfig } from '../src/domain/types.js';

test('routes openai_compatible providers to the generic adapter', () => {
  const provider: ProviderConfig = {
    provider_id: 'openai-whisper',
    name: 'OpenAI Whisper',
    type: 'openai_compatible',
    base_url: 'https://api.example.com/v1',
  };

  const adapter = new DefaultProviderSwitcher().resolve(provider);
  assert.ok(adapter instanceof OpenAICompatibleAdapter);
});

test('routes zenmux providers to the dedicated ZenMux adapter', () => {
  const provider: ProviderConfig = {
    provider_id: 'zenmux-gemini-chat',
    name: 'ZenMux Gemini Audio Chat',
    type: 'zenmux',
    base_url: 'https://zenmux.ai/api/v1',
  };

  const adapter = new DefaultProviderSwitcher().resolve(provider);
  assert.ok(adapter instanceof ZenMuxAdapter);
});

test('routes custom_http providers to the custom HTTP adapter', () => {
  const provider: ProviderConfig = {
    provider_id: 'custom-http-demo',
    name: 'Custom HTTP Demo',
    type: 'custom_http',
    base_url: 'https://example.com',
  };

  const adapter = new DefaultProviderSwitcher().resolve(provider);
  assert.ok(adapter instanceof CustomHttpAdapter);
});
