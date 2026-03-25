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

const OPENROUTER_AUDIO_IGNORED_PATTERNS = [
  'unable to listen to audio',
  'unable to process or transcribe audio files',
  "can't transcribe audio directly",
  'i am unable to process or transcribe audio files',
  'cannot hear or process audio files directly',
  "don't see an audio file attached",
  "haven't attached or provided the audio file",
  'need the audio file first',
  'please provide the audio',
  "provide the audio you'd like transcribed",
  'please upload the audio file',
  'use a speech-to-text service or tool',
];

const OPENROUTER_AUDIO_RETRYABLE_ERROR_PATTERNS = [
  'multimodal data is corrupted or cannot be processed',
  'no endpoints found that support input audio',
];

function withOpenRouterDefaults(provider: ProviderConfig): ProviderConfig {
  const options = (provider.adapter_options ?? {}) as OpenAICompatibleAdapterOptions;

  return {
    ...provider,
    type: 'openai_compatible',
    adapter_options: {
      operation: 'chat_completions_audio',
      chat_path: '/chat/completions',
      chat_audio_part_type: 'input_audio',
      chat_audio_input_key: 'inputAudio',
      audio_format: 'wav',
      text_prompt: 'Please transcribe this audio faithfully. Return plain text only.',
      ...options,
    },
  };
}

function withAlternateAudioShape(provider: ProviderConfig): ProviderConfig {
  const options = (withOpenRouterDefaults(provider).adapter_options ?? {}) as OpenAICompatibleAdapterOptions;
  const currentInputKey = options.chat_audio_input_key ?? 'inputAudio';

  return {
    ...withOpenRouterDefaults(provider),
    adapter_options: {
      ...options,
      chat_audio_part_type: 'input_audio',
      chat_audio_input_key: currentInputKey === 'inputAudio' ? 'input_audio' : 'inputAudio',
    },
  };
}

function extractChatText(rawJson: any): string {
  const messageContent = rawJson?.choices?.[0]?.message?.content;
  if (typeof messageContent === 'string') {
    return messageContent;
  }
  if (Array.isArray(messageContent)) {
    return messageContent
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function shouldRetryWithAlternateAudioShape(result: ProviderExecutionResult): boolean {
  const rawBody = String(result.rawBodyText ?? '').toLowerCase();
  const normalizedText = extractChatText(result.rawJson).toLowerCase();

  if (!result.ok) {
    return OPENROUTER_AUDIO_RETRYABLE_ERROR_PATTERNS.some((pattern) => rawBody.includes(pattern));
  }

  return OPENROUTER_AUDIO_IGNORED_PATTERNS.some((pattern) => normalizedText.includes(pattern));
}

export class OpenRouterAdapter implements AsrProviderAdapter {
  readonly type = 'openrouter' as const;

  constructor(private readonly baseAdapter: OpenAICompatibleAdapter = new OpenAICompatibleAdapter()) {}

  async validateConfig(config: ProviderConfig): Promise<void> {
    await this.baseAdapter.validateConfig(withOpenRouterDefaults(config));
  }

  async buildRequest(input: ProviderRequestInput): Promise<BuiltHttpRequest> {
    return this.baseAdapter.buildRequest({
      ...input,
      provider: withOpenRouterDefaults(input.provider),
    });
  }

  async execute(input: ProviderRequestInput): Promise<ProviderExecutionResult> {
    const primaryProvider = withOpenRouterDefaults(input.provider);
    const primaryResult = await this.baseAdapter.execute({
      ...input,
      provider: primaryProvider,
    });

    const primaryOptions = (primaryProvider.adapter_options ?? {}) as OpenAICompatibleAdapterOptions;
    if (
      primaryOptions.chat_audio_input_key === 'input_audio' ||
      !shouldRetryWithAlternateAudioShape(primaryResult)
    ) {
      return primaryResult;
    }

    return this.baseAdapter.execute({
      ...input,
      provider: withAlternateAudioShape(input.provider),
    });
  }

  async normalize(input: {
    provider: ProviderConfig;
    executionResult: ProviderExecutionResult;
  }): Promise<NormalizedAsrResult> {
    return this.baseAdapter.normalize({
      provider: withOpenRouterDefaults(input.provider),
      executionResult: input.executionResult,
    });
  }
}
