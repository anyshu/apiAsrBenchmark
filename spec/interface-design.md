# Audio ASR Bench - 接口设计

## 1. Provider Adapter 接口

```ts
interface AsrProviderAdapter {
  type: string;
  validateConfig(config: ProviderConfig): Promise<ValidationReport>;
  buildRequest(input: ProviderRequestInput): Promise<BuiltHttpRequest>;
  execute(input: ProviderRequestInput): Promise<ProviderExecutionResult>;
  normalize(result: ProviderExecutionResult): Promise<NormalizedAsrResult>;
}
```

当前实现里，`openai_compatible` 已进一步细分为 3 种 operation：
- `audio_transcriptions`
- `chat_completions_audio`
- `responses_audio`

其中 `chat_completions_audio` 用于像 ZenMux 这类“通过 OpenAI 风格 chat 接口接收音频输入”的 provider。

## 1.1 Provider Switcher 设计

建议在 adapter 之上再增加一层 `ProviderSwitcher` 或 `ProviderRouter`：

```ts
interface ProviderSwitcher {
  resolve(provider: ProviderConfig): AsrProviderAdapter;
}
```

职责：
- 根据 `provider.type` 选择 provider 家族
- 根据 `provider_id` 或 `provider_kind` 选择更具体实现
- 对 capability 做约束，例如：
  - ZenMux 优先路由到 `chat_completions_audio`
  - OpenAI Whisper 类 provider 优先路由到 `audio_transcriptions`
- 避免在 CLI 或 service 层写大量 `if provider === ...`

推荐后续演进路径：
- 第一阶段：`openai_compatible` 作为通用实现
- 第二阶段：将 ZenMux 抽成 `zenmux` 独立 provider
- 第三阶段：在 `ProviderSwitcher` 中统一处理 provider 路由和 fallback 策略

当前实现状态：
- `ProviderSwitcher` 已落地
- `zenmux` 已作为独立 provider type 存在于配置中
- `ProviderSwitcher` 会将 `type: zenmux` 路由到独立 ZenMux adapter
- `ProviderSwitcher` 也会将 `type: custom_http` 路由到独立 CustomHttp adapter

## 1.2 Provider 配置文件组织

推荐使用 provider 目录，而不是单一总配置文件：

```text
providers/
  openai-whisper.yaml
  zenmux-gemini-chat.yaml
  zenmux-mimo-chat.yaml
```

每个文件只描述一个 provider，优点：
- 新增 provider 不需要改已有配置
- 删除 provider 风险更小
- 更容易按 provider 做版本管理和 review
- 更适合后续让 provider 实现与 provider 配置一一对应

## 2. 核心类型

```ts
interface ProviderRequestInput {
  provider: ProviderConfig;
  audio: AudioAsset;
  audioBuffer?: Buffer;
  model?: string;
  prompt?: string;
  language?: string;
  responseFormat?: string;
  timestampGranularities?: Array<'segment' | 'word'>;
  requestOptions?: Record<string, unknown>;
}

interface BuiltHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  bodyKind: 'multipart' | 'json' | 'binary';
  debugPreview: Record<string, unknown>;
}

interface ProviderExecutionResult {
  ok: boolean;
  statusCode?: number;
  headers?: Record<string, string>;
  rawBodyText?: string;
  rawJson?: unknown;
  startedAt: string;
  finishedAt: string;
  error?: {
    type: string;
    message: string;
    retriable?: boolean;
  };
}
```

## 3. OpenAI Compatible 配置

```yaml
providers:
  - provider_id: openai-main
    name: OpenAI Whisper Compatible
    type: openai_compatible
    base_url: https://api.example.com/v1
    api_key: ${OPENAI_API_KEY}
    default_model: whisper-1
    adapter_options:
      transcription_path: /audio/transcriptions
      file_field_name: file
      model_field_name: model
      prompt_field_name: prompt
      language_field_name: language
      response_format_field_name: response_format
      timestamp_granularities_field_name: timestamp_granularities[]
```

ZenMux 风格示例：

```yaml
providers:
  - provider_id: zenmux-mimo-audio
    name: ZenMux MIMO Audio Chat
    type: zenmux
    base_url: https://zenmux.ai/api/v1
    api_key_env: ZENMUX_API_KEY
    default_model: xiaomi/mimo-v2-omni
    adapter_options:
      operation: chat_completions_audio
      chat_path: /chat/completions
      text_prompt: Please transcribe this audio and include timestamps if supported.
      audio_format: wav
```

设计说明：
- 从实现上，ZenMux 当前通过独立 adapter 复用部分 `openai_compatible` 能力
- 从架构上，ZenMux 已视为独立 provider
- 原因是它的最佳音频入口、模型能力、错误特征、返回稳定性都和通用 OpenAI transcription provider 不同
- 因此后续建议新增：
  - provider-specific fallback
  - provider-specific capability metadata

## 4. Custom HTTP 配置

```yaml
provider_id: vendor-x
name: Vendor X ASR
type: custom_http
base_url: https://vendor-x.example.com
api_key_env: VENDOR_X_KEY
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
      include_timestamps: true
  response_mapping:
    transcript_path: $.result.text
    language_path: $.result.lang
    duration_path: $.result.duration_ms
```

## 5. 应用服务接口

```ts
interface BenchService {
  validateProvider(input: ValidateProviderInput): Promise<ValidationResult>;
  createRun(input: CreateRunInput): Promise<BenchRun>;
  executeRun(runId: string): Promise<RunExecutionSummary>;
  getRun(runId: string): Promise<BenchRunDetail>;
  exportRun(runId: string, format: 'json' | 'csv'): Promise<string>;
}
```

## 6. CLI 接口

```bash
asrbench provider list
asrbench provider validate --provider openai-main --audio ./samples/a.wav
asrbench run:once --providers zenmux-gemini-chat --input ./samples --rounds 3
asrbench run:duration --providers zenmux-gemini-chat --input ./samples --duration-ms 30000 --concurrency 2 --interval-ms 100
asrbench run create --providers openai-main,vendor-x --input ./samples --rounds 3
asrbench run start --run-id run_001
asrbench run summary --run-id run_001
asrbench export --run-id run_001 --format csv
```

## 7. 可选 HTTP API

- `GET /api/providers`
- `POST /api/providers/validate`
- `POST /api/runs`
- `POST /api/runs/:id/start`
- `GET /api/runs/:id`
- `GET /api/runs/:id/summary`
- `GET /api/runs/:id/attempts`
- `GET /api/runs/:id/export?format=csv`
