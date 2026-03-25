export type ProviderType = 'openai_compatible' | 'zenmux' | 'custom_http';
export type OpenAICompatibleOperation =
  | 'audio_transcriptions'
  | 'chat_completions_audio'
  | 'responses_audio';

export interface RetryPolicy {
  maxAttempts?: number;
  backoffMs?: number;
}

export interface ProviderRunnerOptions {
  concurrency?: number;
  interval_ms?: number;
}

export interface OpenAICompatibleAdapterOptions {
  operation?: OpenAICompatibleOperation;
  transcription_path?: string;
  chat_path?: string;
  responses_path?: string;
  file_field_name?: string;
  model_field_name?: string;
  prompt_field_name?: string;
  language_field_name?: string;
  response_format_field_name?: string;
  timestamp_granularities_field_name?: string;
  response_format?: string;
  timestamp_granularities?: Array<'segment' | 'word'>;
  text_prompt?: string;
  audio_format?: string;
}

export interface CustomHttpRequestOptions {
  content_type: 'multipart' | 'json';
  file_field?: string;
  file_base64_field?: string;
  model_field?: string;
  prompt_field?: string;
  language_field?: string;
  fields?: Record<string, string | number | boolean>;
}

export interface CustomHttpResponseMapping {
  transcript_path: string;
  language_path?: string;
  duration_path?: string;
}

export interface CustomHttpAdapterOptions {
  endpoint: {
    method: 'POST';
    path: string;
  };
  request: CustomHttpRequestOptions;
  response_mapping: CustomHttpResponseMapping;
}

export interface ProviderConfig {
  provider_id: string;
  name: string;
  type: ProviderType;
  base_url: string;
  api_key?: string;
  api_key_env?: string;
  default_model?: string;
  headers?: Record<string, string>;
  timeout_ms?: number;
  retry_policy?: RetryPolicy;
  runner_options?: ProviderRunnerOptions;
  adapter_options?:
    | Record<string, unknown>
    | OpenAICompatibleAdapterOptions
    | CustomHttpAdapterOptions;
}

export interface ProvidersFile {
  providers: ProviderConfig[];
}

export interface AudioAsset {
  audio_id: string;
  path: string;
  filename: string;
  format: string;
  size_bytes: number;
  duration_ms?: number;
  reference_text?: string;
  reference_path?: string;
}

export interface AccuracyMetrics {
  reference_text: string;
  normalized_reference_text: string;
  normalized_hypothesis_text: string;
  word_error_rate: number;
  char_error_rate: number;
  word_distance: number;
  char_distance: number;
  reference_word_count: number;
  reference_char_count: number;
}

export interface BenchAttemptRecord {
  attempt_id: string;
  run_id: string;
  provider_id: string;
  audio_id: string;
  audio_path: string;
  audio_duration_ms?: number;
  round_index: number;
  started_at: string;
  finished_at: string;
  latency_ms: number;
  rtf?: number;
  success: boolean;
  request_attempts: number;
  retry_count: number;
  http_status?: number;
  error?: ProviderExecutionError;
  normalized_result?: NormalizedAsrResult;
  evaluation?: AccuracyMetrics;
}

export interface BenchRunSummary {
  run_id: string;
  mode: 'once' | 'duration';
  created_at: string;
  provider_ids: string[];
  input_path: string;
  rounds: number;
  duration_ms?: number;
  concurrency?: number;
  interval_ms?: number;
  attempt_count: number;
  success_count: number;
  failure_count: number;
  attempts_path: string;
  summary_path: string;
  csv_path: string;
  database_path?: string;
  average_latency_ms?: number;
  p50_latency_ms?: number;
  p90_latency_ms?: number;
  p95_latency_ms?: number;
  average_rtf?: number;
  total_retry_count: number;
  average_retry_count?: number;
  evaluated_attempt_count: number;
  average_wer?: number;
  average_cer?: number;
  failure_type_counts: Record<string, number>;
  provider_summaries: BenchProviderSummary[];
}

export interface BenchProviderSummary {
  provider_id: string;
  attempt_count: number;
  success_count: number;
  failure_count: number;
  average_latency_ms?: number;
  p50_latency_ms?: number;
  p90_latency_ms?: number;
  p95_latency_ms?: number;
  average_rtf?: number;
  total_retry_count: number;
  average_retry_count?: number;
  evaluated_attempt_count: number;
  average_wer?: number;
  average_cer?: number;
  failure_type_counts: Record<string, number>;
}

export interface ProviderRequestInput {
  provider: ProviderConfig;
  audio: AudioAsset;
  model?: string;
  prompt?: string;
  language?: string;
  responseFormat?: string;
  timestampGranularities?: Array<'segment' | 'word'>;
  requestOptions?: Record<string, unknown>;
}

export interface BuiltHttpRequest {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  bodyKind: 'multipart' | 'json';
  debugPreview: Record<string, unknown>;
  body: FormData | string;
}

export interface ProviderExecutionError {
  type: string;
  message: string;
  retriable?: boolean;
}

export interface ProviderExecutionResult {
  ok: boolean;
  statusCode?: number;
  headers?: Record<string, string>;
  rawBodyText?: string;
  rawJson?: unknown;
  startedAt: string;
  finishedAt: string;
  error?: ProviderExecutionError;
}

export interface ProviderExecutionEnvelope {
  result: ProviderExecutionResult;
  requestAttempts: number;
  retryCount: number;
  retryHistory: Array<{
    attempt: number;
    statusCode?: number;
    error?: ProviderExecutionError;
    startedAt: string;
    finishedAt: string;
  }>;
}

export interface NormalizedSegment {
  start_ms?: number;
  end_ms?: number;
  text: string;
}

export interface NormalizedWord {
  start_ms?: number;
  end_ms?: number;
  word: string;
}

export interface NormalizedAsrResult {
  text: string;
  language?: string;
  duration_ms?: number;
  provider_model?: string;
  provider_request_id?: string;
  segments?: NormalizedSegment[];
  words?: NormalizedWord[];
  usage?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface ValidationReport {
  ok: boolean;
  provider_id: string;
  validated_at: string;
  request_preview?: Record<string, unknown>;
  normalized_result?: NormalizedAsrResult;
  execution?: {
    statusCode?: number;
    error?: ProviderExecutionError;
  };
}

export interface AsrProviderAdapter {
  readonly type: ProviderType;
  validateConfig(config: ProviderConfig): Promise<void>;
  buildRequest(input: ProviderRequestInput): Promise<BuiltHttpRequest>;
  execute(input: ProviderRequestInput): Promise<ProviderExecutionResult>;
  normalize(input: {
    provider: ProviderConfig;
    executionResult: ProviderExecutionResult;
  }): Promise<NormalizedAsrResult>;
}

export interface ProviderSwitcher {
  resolve(provider: ProviderConfig): AsrProviderAdapter;
}
