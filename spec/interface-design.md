# Audio ASR Bench - 接口设计

## 1. Provider Adapter 接口

```ts
interface AsrProviderAdapter {
  readonly type: ProviderType;
  validateConfig(config: ProviderConfig): Promise<void>;
  buildRequest(input: ProviderRequestInput): Promise<BuiltHttpRequest>;
  execute(input: ProviderRequestInput): Promise<ProviderExecutionResult>;
  normalize(input: {
    provider: ProviderConfig;
    executionResult: ProviderExecutionResult;
  }): Promise<NormalizedAsrResult>;
}
```

当前 `openai_compatible` 支持：
- `audio_transcriptions`
- `chat_completions_audio`
- `responses_audio`

其中 `chat_completions_audio` 用于像 ZenMux 这类通过 `/chat/completions` 接收音频输入的 provider。

## 2. Provider Switcher

```ts
interface ProviderSwitcher {
  resolve(provider: ProviderConfig): AsrProviderAdapter;
}
```

职责：
- 根据 `provider.type` 选择 provider 家族
- 避免在 CLI / service 层写 provider-specific 分支
- 允许 ZenMux 和未来新接口以独立 adapter 演进

## 3. 核心类型

```ts
interface RetryPolicy {
  maxAttempts?: number;
  backoffMs?: number;
}

interface ProviderRunnerOptions {
  concurrency?: number;
  interval_ms?: number;
}

interface ProviderConfig {
  provider_id: string;
  name: string;
  type: 'openai_compatible' | 'zenmux' | 'openrouter' | 'custom_http';
  base_url: string;
  api_key?: string;
  api_key_env?: string;
  default_model?: string;
  headers?: Record<string, string>;
  timeout_ms?: number;
  retry_policy?: RetryPolicy;
  runner_options?: ProviderRunnerOptions;
  adapter_options?: Record<string, unknown>;
}

interface AudioAsset {
  audio_id: string;
  path: string;
  filename: string;
  format: string;
  size_bytes: number;
  duration_ms?: number;
  language?: string;
  speaker?: string;
  tags?: string[];
  reference_text?: string;
  reference_path?: string;
}

interface ProviderExecutionEnvelope {
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

interface AccuracyMetrics {
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
```

```ts
interface BenchAttemptRecord {
  attempt_id: string;
  run_id: string;
  provider_id: string;
  audio_id: string;
  audio_path: string;
  audio_duration_ms?: number;
  audio_language?: string;
  audio_speaker?: string;
  audio_tags?: string[];
  audio_reference_path?: string;
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
```

## 4. Provider 配置示例

### 4.1 OpenAI-compatible

```yaml
provider_id: openai-whisper
name: OpenAI Audio Transcriptions
type: openai_compatible
base_url: https://api.openai.com/v1
api_key_env: OPENAI_API_KEY
default_model: gpt-4o-mini-transcribe
retry_policy:
  max_attempts: 2
  backoff_ms: 250
runner_options:
  concurrency: 1
  interval_ms: 0
adapter_options:
  operation: audio_transcriptions
  transcription_path: /audio/transcriptions
  response_format: verbose_json
  timestamp_granularities:
    - segment
```

### 4.2 ZenMux

```yaml
provider_id: zenmux-gemini-chat
name: ZenMux Gemini Audio Chat
type: zenmux
base_url: https://zenmux.ai/api/v1
api_key_env: ZENMUX_API_KEY
default_model: google/gemini-2.5-pro
retry_policy:
  max_attempts: 2
  backoff_ms: 500
runner_options:
  concurrency: 1
  interval_ms: 200
adapter_options:
  operation: chat_completions_audio
  chat_path: /chat/completions
  text_prompt: Please transcribe this audio faithfully. Return plain text only.
  audio_format: wav
```

### 4.3 Custom HTTP

```yaml
provider_id: vendor-x
name: Vendor X ASR
type: custom_http
base_url: https://vendor-x.example.com
api_key_env: VENDOR_X_KEY
retry_policy:
  max_attempts: 3
  backoff_ms: 300
runner_options:
  concurrency: 2
  interval_ms: 100
adapter_options:
  endpoint:
    method: POST
    path: /asr/recognize
  request:
    content_type: multipart
    file_field: audio
    model_field: model
    fields:
      engine: fast
  response_mapping:
    transcript_path: $.result.text
    language_path: $.result.lang
```

## 5. Artifact 与存储接口

文件产物：
- `attempts.jsonl`
- `summary.json`
- `summary.csv`
- `raw/*.json`

SQLite：

```ts
persistRunToSqlite({
  dbPath,
  summary,
  attempts,
});

listRunsFromSqlite(dbPath, limit?);
getRunDetailFromSqlite(dbPath, runId);
```

## 6. CLI 接口

```bash
asrbench provider:list
asrbench provider:validate --provider openai-whisper --audio ./samples/a.wav
asrbench --reference-sidecar run:once --providers openai-whisper --input ./samples --rounds 3
asrbench --reference-dir ./refs run:duration --providers zenmux-gemini-chat --input ./samples --duration-ms 30000 --concurrency 2 --interval-ms 100
asrbench --db ./artifacts/asrbench.sqlite run:list --limit 20
asrbench --db ./artifacts/asrbench.sqlite run:list --provider openai-whisper --mode once --failures no --created-after 2026-03-25T00:00:00Z --query samples
asrbench --db ./artifacts/asrbench.sqlite run:show --run-id run_123 --attempts
asrbench --db ./artifacts/asrbench.sqlite run:export --run-id run_123 --format csv --output ./exports/run_123.csv
asrbench --db artifacts/asrbench.sqlite ui:serve --port 3000
```

全局 CLI 选项：
- `--config`
- `--db`
- `--manifest`
- `--reference-sidecar`
- `--reference-dir`

## 7. 本地 UI API

```http
GET /api/providers
GET /api/provider-capabilities
GET /api/demo-assets
GET /api/jobs
GET /api/jobs/:job_id
POST /api/jobs/:job_id/cancel
GET /api/runs
GET /api/runs/:run_id
GET /api/runs/:run_id/export
GET /api/runs/:run_id/attempts/:attempt_id/raw
POST /api/run
GET /
```

说明：
- `/api/providers` 返回已加载的 provider 配置摘要，用于 UI 选择
- `/api/provider-capabilities` 返回 provider operation、timestamp 能力、retry / runner 摘要
- `/api/demo-assets` 返回 demo dataset / provider 的推荐本地路径，供 UI 快捷填充
- `/api/jobs` 返回最近的浏览器触发 run job 列表
- `/api/jobs/:job_id` 返回单个后台 job 的状态、错误、summary
- `/api/jobs/:job_id/cancel` 请求取消一个 queued / running job
- `/api/runs` 返回 run summary 列表
- `/api/runs` 支持 `provider`、`mode`、`failures`、`created_after`、`created_before`、`query`
- `/api/runs/:run_id` 返回 summary + attempts
- `/api/runs/:run_id/export` 支持 `format=json|jsonl|csv`
- `/api/run` 创建后台 job；成功时返回 `202 Accepted`
- `/` 返回最小 dashboard 页面

### 7.1 Dataset Manifest

```json
{
  "items": [
    {
      "path": "speaker-a.wav",
      "reference_text": "optional inline transcript",
      "reference_path": "../refs/speaker-a.txt",
      "language": "zh",
      "speaker": "speaker-a",
      "tags": ["meeting", "far-field"]
    }
  ]
}
```

规则：
- `path` 优先按输入根目录相对路径匹配，回退到文件名匹配
- `reference_path` 相对 manifest 文件解析
- manifest 先于 sidecar / reference-dir 执行，后两者仅补齐缺失 reference

### 7.2 `POST /api/run` 请求体

```json
{
  "mode": "once",
  "providerIds": ["openai-whisper"],
  "inputPath": "/path/to/audio",
  "rounds": 1,
  "durationMs": 30000,
  "concurrency": 1,
  "intervalMs": 0,
  "manifestPath": "/path/to/audio/dataset.manifest.json",
  "referenceSidecar": false,
  "referenceDir": "/path/to/references"
}
```

错误返回：

```json
{
  "error": "validation_failed",
  "message": "Please fix the highlighted fields and try again.",
  "field_errors": {
    "inputPath": "Input path does not exist.",
    "providerIds": "Select at least one provider."
  }
}
```

### 7.3 Job 响应摘要

```json
{
  "job": {
    "job_id": "job_1234abcd",
    "status": "running",
    "cancel_requested": false,
    "progress": {
      "completed_attempts": 3,
      "total_attempts": 12,
      "progress_ratio": 0.25,
      "current_attempt_id": "openai-whisper-demo__sample__r1",
      "current_provider_id": "openai-whisper-demo",
      "current_audio_id": "sample",
      "message": "Running once benchmark."
    }
  }
}
```
