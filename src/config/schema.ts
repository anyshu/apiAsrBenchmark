import { z } from 'zod';

const customHttpAdapterOptionsSchema = z.object({
  endpoint: z.object({
    method: z.literal('POST'),
    path: z.string().min(1),
  }),
  request: z.object({
    content_type: z.enum(['multipart', 'json']),
    file_field: z.string().min(1).optional(),
    file_base64_field: z.string().min(1).optional(),
    model_field: z.string().min(1).optional(),
    prompt_field: z.string().min(1).optional(),
    language_field: z.string().min(1).optional(),
    fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  }),
  response_mapping: z.object({
    transcript_path: z.string().min(1),
    language_path: z.string().min(1).optional(),
    duration_path: z.string().min(1).optional(),
  }),
});

export const providerConfigSchema = z.object({
  provider_id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['openai_compatible', 'zenmux', 'custom_http']),
  base_url: z.url(),
  api_key: z.string().min(1).optional(),
  api_key_env: z.string().min(1).optional(),
  default_model: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeout_ms: z.number().int().positive().optional(),
  retry_policy: z
    .object({
      maxAttempts: z.number().int().positive().optional(),
      backoffMs: z.number().int().nonnegative().optional(),
    })
    .optional(),
  adapter_options: z.union([z.record(z.string(), z.unknown()), customHttpAdapterOptionsSchema]).optional(),
});

export const providersFileSchema = z.object({
  providers: z.array(providerConfigSchema).min(1),
});

export const providerConfigDocumentSchema = z.union([
  providerConfigSchema,
  providersFileSchema,
]);
