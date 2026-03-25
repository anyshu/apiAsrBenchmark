import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AsrProviderAdapter,
  BuiltHttpRequest,
  NormalizedAsrResult,
  OpenAICompatibleAdapterOptions,
  ProviderConfig,
  ProviderExecutionResult,
  ProviderRequestInput,
} from '../domain/types.js';
import { headersToObject, redactHeaders } from '../utils/http.js';
import { inferAudioMimeType } from '../utils/audio.js';

function getOptions(provider: ProviderConfig): OpenAICompatibleAdapterOptions {
  return (provider.adapter_options ?? {}) as OpenAICompatibleAdapterOptions;
}

function resolveOperation(provider: ProviderConfig): NonNullable<OpenAICompatibleAdapterOptions['operation']> {
  return getOptions(provider).operation ?? 'audio_transcriptions';
}

function resolveModel(provider: ProviderConfig, input: ProviderRequestInput): string {
  return input.model ?? provider.default_model ?? 'gpt-4o-mini-transcribe';
}

function joinUrl(baseUrl: string, route: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const normalizedRoute = route.replace(/^\/+/, '');
  return new URL(normalizedRoute, normalizedBase).toString();
}

function extractTextFromChatCompletion(rawJson: any): string {
  const messageContent = rawJson?.choices?.[0]?.message?.content;
  if (typeof messageContent === 'string') {
    return messageContent;
  }
  if (Array.isArray(messageContent)) {
    return messageContent
      .map((item) => {
        if (typeof item?.text === 'string') {
          return item.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function extractTextFromResponseApi(rawJson: any): string {
  if (typeof rawJson?.output_text === 'string') {
    return rawJson.output_text;
  }
  const chunks = rawJson?.output ?? [];
  return chunks
    .flatMap((item: any) => item?.content ?? [])
    .map((content: any) => content?.text ?? '')
    .filter(Boolean)
    .join('\n');
}

export class OpenAICompatibleAdapter implements AsrProviderAdapter {
  readonly type = 'openai_compatible' as const;

  async validateConfig(config: ProviderConfig): Promise<void> {
    if (!config.api_key) {
      throw new Error(`Provider ${config.provider_id} is missing api_key or api_key_env.`);
    }
    if (!config.base_url) {
      throw new Error(`Provider ${config.provider_id} is missing base_url.`);
    }
  }

  async buildRequest(input: ProviderRequestInput): Promise<BuiltHttpRequest> {
    const options = getOptions(input.provider);
    const operation = resolveOperation(input.provider);
    const audioBuffer = await fs.readFile(input.audio.path);
    const fileName = path.basename(input.audio.path);
    const model = resolveModel(input.provider, input);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${input.provider.api_key ?? ''}`,
      ...(input.provider.headers ?? {}),
    };

    if (operation === 'audio_transcriptions') {
      const form = new FormData();
      const fileFieldName = options.file_field_name ?? 'file';
      const modelFieldName = options.model_field_name ?? 'model';
      const promptFieldName = options.prompt_field_name ?? 'prompt';
      const languageFieldName = options.language_field_name ?? 'language';
      const responseFormatFieldName = options.response_format_field_name ?? 'response_format';
      const timestampFieldName =
        options.timestamp_granularities_field_name ?? 'timestamp_granularities[]';
      const blob = new Blob([audioBuffer], { type: inferAudioMimeType(input.audio.format) });
      form.set(fileFieldName, blob, fileName);
      form.set(modelFieldName, model);
      if (input.prompt) {
        form.set(promptFieldName, input.prompt);
      }
      if (input.language) {
        form.set(languageFieldName, input.language);
      }
      if (input.responseFormat ?? options.response_format) {
        form.set(responseFormatFieldName, input.responseFormat ?? options.response_format ?? 'json');
      }
      const granularities = input.timestampGranularities ?? options.timestamp_granularities;
      if (granularities) {
        for (const value of granularities) {
          form.append(timestampFieldName, value);
        }
      }

      return {
        method: 'POST',
        url: joinUrl(input.provider.base_url, options.transcription_path ?? '/audio/transcriptions'),
        headers,
        bodyKind: 'multipart',
        body: form,
        debugPreview: {
          operation,
          model,
          audio: {
            path: input.audio.path,
            format: input.audio.format,
            size_bytes: input.audio.size_bytes,
          },
          fields: {
            prompt: input.prompt,
            language: input.language,
            response_format: input.responseFormat ?? options.response_format,
            timestamp_granularities: granularities,
          },
          headers: redactHeaders(headers),
        },
      };
    }

    const audioFormat = options.audio_format ?? input.audio.format;
    const audioBase64 = audioBuffer.toString('base64');
    const promptText = input.prompt ?? options.text_prompt ?? 'Please transcribe this audio.';

    if (operation === 'chat_completions_audio') {
      const payload = {
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: promptText },
              {
                type: 'input_audio',
                input_audio: {
                  data: audioBase64,
                  format: audioFormat,
                },
              },
            ],
          },
        ],
      };

      return {
        method: 'POST',
        url: joinUrl(input.provider.base_url, options.chat_path ?? '/chat/completions'),
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        bodyKind: 'json',
        body: JSON.stringify(payload),
        debugPreview: {
          operation,
          model,
          audio: {
            path: input.audio.path,
            format: audioFormat,
            size_bytes: input.audio.size_bytes,
            base64_bytes: audioBase64.length,
          },
          prompt: promptText,
          headers: redactHeaders(headers),
        },
      };
    }

    const payload = {
      model,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: promptText },
            {
              type: 'input_audio',
              input_audio: {
                data: audioBase64,
                format: audioFormat,
              },
            },
          ],
        },
      ],
    };

    return {
      method: 'POST',
      url: joinUrl(input.provider.base_url, options.responses_path ?? '/responses'),
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      bodyKind: 'json',
      body: JSON.stringify(payload),
      debugPreview: {
        operation,
        model,
        audio: {
          path: input.audio.path,
          format: audioFormat,
          size_bytes: input.audio.size_bytes,
          base64_bytes: audioBase64.length,
        },
        prompt: promptText,
        headers: redactHeaders(headers),
      },
    };
  }

  async execute(input: ProviderRequestInput): Promise<ProviderExecutionResult> {
    const request = await this.buildRequest(input);
    const controller = new AbortController();
    const timeoutMs = input.provider.timeout_ms ?? 60_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = new Date().toISOString();

    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      const finishedAt = new Date().toISOString();
      const rawBodyText = await response.text();
      let rawJson: unknown = undefined;
      try {
        rawJson = JSON.parse(rawBodyText);
      } catch {
        rawJson = undefined;
      }

      return {
        ok: response.ok,
        statusCode: response.status,
        headers: headersToObject(response.headers),
        rawBodyText,
        rawJson,
        startedAt,
        finishedAt,
        error: response.ok
          ? undefined
          : {
              type: response.status >= 500 ? 'server_error' : 'client_error',
              message: `HTTP ${response.status}`,
              retriable: response.status >= 500,
            },
      };
    } catch (error) {
      const finishedAt = new Date().toISOString();
      return {
        ok: false,
        startedAt,
        finishedAt,
        error: {
          type: error instanceof DOMException && error.name === 'AbortError' ? 'timeout' : 'network_error',
          message: error instanceof Error ? error.message : 'Unknown fetch error',
          retriable: true,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async normalize(input: {
    provider: ProviderConfig;
    executionResult: ProviderExecutionResult;
  }): Promise<NormalizedAsrResult> {
    const { provider, executionResult } = input;
    if (!executionResult.ok) {
      throw new Error(executionResult.error?.message ?? 'Cannot normalize failed response.');
    }

    const rawJson: any = executionResult.rawJson;
    const operation = resolveOperation(provider);

    if (operation === 'audio_transcriptions') {
      return {
        text: rawJson?.text ?? '',
        language: rawJson?.language,
        duration_ms:
          typeof rawJson?.duration === 'number' ? Math.round(rawJson.duration * 1000) : undefined,
        provider_model: rawJson?.model,
        segments: Array.isArray(rawJson?.segments)
          ? rawJson.segments.map((segment: any) => ({
              start_ms:
                typeof segment?.start === 'number' ? Math.round(segment.start * 1000) : undefined,
              end_ms: typeof segment?.end === 'number' ? Math.round(segment.end * 1000) : undefined,
              text: segment?.text ?? '',
            }))
          : undefined,
        words: Array.isArray(rawJson?.words)
          ? rawJson.words.map((word: any) => ({
              start_ms: typeof word?.start === 'number' ? Math.round(word.start * 1000) : undefined,
              end_ms: typeof word?.end === 'number' ? Math.round(word.end * 1000) : undefined,
              word: word?.word ?? '',
            }))
          : undefined,
      };
    }

    if (operation === 'chat_completions_audio') {
      return {
        text: extractTextFromChatCompletion(rawJson),
        provider_model: rawJson?.model,
        usage: rawJson?.usage,
        extra: {
          finish_reason: rawJson?.choices?.[0]?.finish_reason,
        },
      };
    }

    return {
      text: extractTextFromResponseApi(rawJson),
      provider_model: rawJson?.model,
      usage: rawJson?.usage,
      extra: {
        response_id: rawJson?.id,
      },
    };
  }
}
