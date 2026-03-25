import type {
  AsrProviderAdapter,
  BuiltHttpRequest,
  NormalizedAsrResult,
  OpenAICompatibleAdapterOptions,
  ProviderConfig,
  ProviderExecutionResult,
  ProviderRequestInput,
} from '../domain/types.js';
import { OpenAICompatibleAdapter } from './openaiCompatibleAdapter.js';

function withZenMuxDefaults(provider: ProviderConfig): ProviderConfig {
  const options = (provider.adapter_options ?? {}) as OpenAICompatibleAdapterOptions;

  return {
    ...provider,
    type: 'openai_compatible',
    adapter_options: {
      operation: 'chat_completions_audio',
      chat_path: '/chat/completions',
      audio_format: 'wav',
      text_prompt: 'Please transcribe this audio faithfully. Return plain text only.',
      ...options,
    },
  };
}

export class ZenMuxAdapter implements AsrProviderAdapter {
  readonly type = 'zenmux' as const;

  constructor(private readonly baseAdapter: OpenAICompatibleAdapter = new OpenAICompatibleAdapter()) {}

  async validateConfig(config: ProviderConfig): Promise<void> {
    await this.baseAdapter.validateConfig(withZenMuxDefaults(config));
  }

  async buildRequest(input: ProviderRequestInput): Promise<BuiltHttpRequest> {
    return this.baseAdapter.buildRequest({
      ...input,
      provider: withZenMuxDefaults(input.provider),
    });
  }

  async execute(input: ProviderRequestInput): Promise<ProviderExecutionResult> {
    return this.baseAdapter.execute({
      ...input,
      provider: withZenMuxDefaults(input.provider),
    });
  }

  async normalize(input: {
    provider: ProviderConfig;
    executionResult: ProviderExecutionResult;
  }): Promise<NormalizedAsrResult> {
    return this.baseAdapter.normalize({
      provider: withZenMuxDefaults(input.provider),
      executionResult: input.executionResult,
    });
  }
}
