import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AsrProviderAdapter,
  BuiltHttpRequest,
  CustomHttpAdapterOptions,
  NormalizedAsrResult,
  ProviderConfig,
  ProviderExecutionResult,
  ProviderRequestInput,
} from '../domain/types.js';
import { inferAudioMimeType } from '../utils/audio.js';
import { headersToObject, redactHeaders } from '../utils/http.js';

function getOptions(provider: ProviderConfig): CustomHttpAdapterOptions {
  return provider.adapter_options as CustomHttpAdapterOptions;
}

function joinUrl(baseUrl: string, route: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const normalizedRoute = route.replace(/^\/+/, '');
  return new URL(normalizedRoute, normalizedBase).toString();
}

function getByPath(input: unknown, rawPath?: string): unknown {
  if (!rawPath) {
    return undefined;
  }
  const normalizedPath = rawPath.replace(/^\$\./, '').replace(/^\$/, '');
  if (!normalizedPath) {
    return input;
  }

  return normalizedPath.split('.').reduce<unknown>((current, part) => {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, input);
}

export class CustomHttpAdapter implements AsrProviderAdapter {
  readonly type = 'custom_http' as const;

  async validateConfig(config: ProviderConfig): Promise<void> {
    if (!config.api_key && !config.headers) {
      throw new Error(`Provider ${config.provider_id} requires api_key/api_key_env or explicit headers.`);
    }

    const options = getOptions(config);
    if (!options?.endpoint?.path) {
      throw new Error(`Provider ${config.provider_id} is missing custom_http endpoint.path.`);
    }
    if (!options?.request?.content_type) {
      throw new Error(`Provider ${config.provider_id} is missing custom_http request.content_type.`);
    }
    if (!options?.response_mapping?.transcript_path) {
      throw new Error(`Provider ${config.provider_id} is missing response_mapping.transcript_path.`);
    }
  }

  async buildRequest(input: ProviderRequestInput): Promise<BuiltHttpRequest> {
    const options = getOptions(input.provider);
    const audioBuffer = await fs.readFile(input.audio.path);
    const fileName = path.basename(input.audio.path);
    const headers: Record<string, string> = {
      ...(input.provider.api_key ? { Authorization: `Bearer ${input.provider.api_key}` } : {}),
      ...(input.provider.headers ?? {}),
    };

    if (options.request.content_type === 'multipart') {
      const form = new FormData();
      if (options.request.file_field) {
        const blob = new Blob([audioBuffer], { type: inferAudioMimeType(input.audio.format) });
        form.set(options.request.file_field, blob, fileName);
      }
      if (options.request.model_field && input.provider.default_model) {
        form.set(options.request.model_field, input.provider.default_model);
      }
      if (options.request.prompt_field && input.prompt) {
        form.set(options.request.prompt_field, input.prompt);
      }
      if (options.request.language_field && input.language) {
        form.set(options.request.language_field, input.language);
      }
      for (const [key, value] of Object.entries(options.request.fields ?? {})) {
        form.set(key, String(value));
      }

      return {
        method: 'POST',
        url: joinUrl(input.provider.base_url, options.endpoint.path),
        headers,
        bodyKind: 'multipart',
        body: form,
        debugPreview: {
          endpoint: options.endpoint,
          content_type: options.request.content_type,
          audio: {
            path: input.audio.path,
            format: input.audio.format,
            size_bytes: input.audio.size_bytes,
          },
          fields: options.request.fields ?? {},
          headers: redactHeaders(headers),
        },
      };
    }

    const payload: Record<string, unknown> = {
      ...(options.request.fields ?? {}),
    };
    if (options.request.file_base64_field) {
      payload[options.request.file_base64_field] = audioBuffer.toString('base64');
    }
    if (options.request.model_field && input.provider.default_model) {
      payload[options.request.model_field] = input.provider.default_model;
    }
    if (options.request.prompt_field && input.prompt) {
      payload[options.request.prompt_field] = input.prompt;
    }
    if (options.request.language_field && input.language) {
      payload[options.request.language_field] = input.language;
    }

    return {
      method: 'POST',
      url: joinUrl(input.provider.base_url, options.endpoint.path),
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      bodyKind: 'json',
      body: JSON.stringify(payload),
      debugPreview: {
        endpoint: options.endpoint,
        content_type: options.request.content_type,
        audio: {
          path: input.audio.path,
          format: input.audio.format,
          size_bytes: input.audio.size_bytes,
          base64_bytes: audioBuffer.length,
        },
        fields: options.request.fields ?? {},
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
    if (!input.executionResult.ok) {
      throw new Error(input.executionResult.error?.message ?? 'Cannot normalize failed response.');
    }

    const options = getOptions(input.provider);
    const rawJson = input.executionResult.rawJson;
    const text = getByPath(rawJson, options.response_mapping.transcript_path);
    const language = getByPath(rawJson, options.response_mapping.language_path);
    const duration = getByPath(rawJson, options.response_mapping.duration_path);

    return {
      text: typeof text === 'string' ? text : '',
      language: typeof language === 'string' ? language : undefined,
      duration_ms: typeof duration === 'number' ? Math.round(duration) : undefined,
      extra: {
        response_mapping: options.response_mapping,
      },
    };
  }
}
