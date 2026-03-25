# Audio ASR Bench 需求分析与设计

## 1. 文档目标

本文档用于定义一个基于远程 API 调用的音频 ASR Benchmark 平台的首期需求与技术设计。

平台第一阶段优先支持 OpenAI 兼容接口，同时在架构上保留对未来新增接口形态的扩展能力，包括“部分兼容 OpenAI”与“完全自定义 HTTP 协议”的 ASR 服务。

本文重点覆盖：
- 需求分析
- 方案设计
- 接口设计
- 可选 UI 设计

## 2. 背景与问题定义

你当前已明确的输入有两类：
- 一组 ASR 服务配置，例如 `base_url`、`api_key`，以及未来可能补充的 provider 元信息。
- 一组本地语音文件，例如 `wav`、`mp3` 等主流格式。

但目前最大的实际问题是：
- 不同厂商的 ASR API 请求格式可能不同。
- 即使声称“兼容 OpenAI”，也常常只是路径、字段名、认证方式大体类似，细节并不完全一致。
- 将来还会出现完全不同的接口格式，例如自定义 path、自定义字段、自定义返回结构。

如果没有统一抽象层，后续每接一个新 provider 都会演变成一次单独对接，结果格式也难以做横向对比。

因此，这个 bench 平台需要解决四个核心问题：
1. 如何抽象 provider，兼容不同接口风格。
2. 如何持续提交音频并拿到结构化 ASR 结果。
3. 如何统一记录延迟、结果、timestamp、错误等指标。
4. 如何让核心能力不依赖 CLI / Web，方便以后替换 UI。

## 3. 产品目标

### 3.1 核心目标
- 用统一方式压测或持续测试多个远程 ASR API。
- 对 provider 的接入方式进行归一化封装。
- 对不同 provider 的返回结果做标准化。
- 记录可用于比较和追溯的 benchmark 数据。
- 将核心执行引擎与 UI 解耦，优先做 CLI，同时为未来 Web UI 预留接口。

### 3.2 非目标
以下内容不作为第一阶段必须项：
- 实时流式 ASR benchmark
- 分布式压测集群
- 多用户权限体系
- 完整标注平台或人工纠错平台
- 大规模线上 observability 平台

## 4. 用户与使用场景

### 4.1 目标用户
- 需要评估第三方 ASR API 的工程师
- 需要横向比较多个 ASR 模型/厂商的研发或算法同学
- 需要验证延迟、稳定性、结果质量的产品团队

### 4.2 典型场景
1. 配一份 provider 列表，快速验证每个 API 是否真的可调用。
2. 指定一个音频目录，批量跑多个 provider。
3. 对同一批音频持续跑多轮，观察延迟与稳定性波动。
4. 检查 provider 是否支持 segment / word timestamp。
5. 导出结构化结果，后续做报表或更深层分析。
6. 新增一个 provider 时，先做小流量验证，再做正式 benchmark。

## 5. 需求分析

## 5.1 功能需求

### FR-1 Provider 配置管理
系统必须支持通过配置定义多个 ASR provider。

每个 provider 至少应支持以下字段：
- `provider_id`
- `name`
- `type`
- `base_url`
- `api_key` 或其他鉴权凭证
- `default_model`
- `headers`
- `timeout_ms`
- `retry_policy`
- `adapter_options`

说明：
- `type` 用于决定采用哪种适配器。
- `adapter_options` 用于补充 provider 私有的接口映射规则。

### FR-2 Provider 协议扩展能力
系统第一阶段至少支持三类 provider：
- `openai_compatible`：面向 OpenAI 风格转写接口
- `zenmux`：面向 ZenMux 的 provider-specific 路由实现
- `custom_http`：面向完全自定义 HTTP 接口

这样可以满足两种情况：
- 对“基本兼容 OpenAI”的服务快速接入。
- 对“完全不兼容”的服务通过映射配置或自定义适配器接入。

### FR-3 音频输入管理
系统必须支持：
- 单文件输入
- 目录输入
- 递归扫描子目录
- 主流音频格式识别，如 `wav`、`mp3`、`m4a`、`flac`、`ogg`、`aac`

每个音频文件应保留以下元信息：
- 文件路径
- 文件名
- 格式
- 文件大小
- 音频时长（建议）
- 音频 hash（建议）

### FR-4 持续 benchmark 执行
系统必须支持多种运行方式：
- 单次运行
- 按轮次运行，例如每个音频跑 3 轮
- 按时长持续运行，例如持续 10 分钟
- 可配置并发数
- 可配置请求间隔 / 速率控制

这是 bench 场景的关键，因为实际对比价值不只来自一次调用，而来自持续执行下的稳定性与延迟表现。

当前实现状态：
- 已实现 `run once`
- 已支持 `rounds`
- 已实现 `run duration`
- 已支持 `concurrency`
- 已支持 `interval`

### FR-5 ASR 结果采集
每次请求至少要采集：
- 原始响应体
- 标准化后的 transcript 文本
- 可选的 segment timestamps
- 可选的 word timestamps
- 错误信息（若失败）

### FR-6 性能指标记录
每次请求至少要记录：
- 调度时间
- 请求开始时间
- 响应返回时间
- 请求完成时间
- 端到端延迟
- HTTP 状态码
- 成功/失败状态
- provider / model
- 音频元信息
- transcript 是否存在
- timestamp 是否存在

### FR-7 结果持久化
系统必须将 benchmark 结果以结构化方式落盘。

第一阶段建议：
- `JSONL`：保存每一次 attempt 的完整记录
- `JSON`：保存 run 级别 summary
- `CSV`：导出平铺后的汇总表，便于表格分析
- `raw/`：保存原始响应体或调试信息

### FR-8 Provider 验证能力
系统必须支持 provider 接入验证，避免一上来就跑完整 benchmark。

验证流程至少应包括：
- 配置合法性校验
- 请求预览
- 用样例音频做一次真实请求
- 响应解析校验
- 标准化结果预览

### FR-9 CLI 能力
系统必须提供 CLI，至少支持：
- 列出 provider
- 校验 provider
- 执行单轮 benchmark（run once）
- 创建 run
- 执行 run
- 查看 summary
- 导出结果

### FR-10 UI 可替换性
如果后续增加 Web UI，UI 不应承载 provider 适配、benchmark 调度、结果标准化等核心业务逻辑。

这些能力必须放在核心服务层中，CLI/Web 只是不同入口。

## 5.2 非功能需求

### NFR-1 模块解耦
核心 benchmark 引擎、provider 适配层、结果存储层、CLI/Web 界面必须分层。

### NFR-2 可扩展性
新增 provider 时，最好只需要：
- 新增一份配置
- 或新增一个 adapter
而不需要修改 benchmark 主流程。

### NFR-3 可复现性
每次 run 都应保存：
- provider 配置快照
- 运行参数快照
- 输入音频清单

这样才能保证 benchmark 结果后续可追溯、可复现。

### NFR-4 可调试性
每次失败都应尽量保留足够的上下文，方便定位：
- 实际请求目标
- 关键请求头（脱敏后）
- 响应状态码
- 响应 body
- 解析失败原因

### NFR-5 安全性
- API key 不应直接明文出现在最终 artifacts 中。
- 落盘时必须对敏感信息做脱敏。

### NFR-6 可移植性
第一阶段建议本地即可运行，尽量少依赖复杂基础设施。

### NFR-7 UI 独立性
CLI、未来 Web UI、甚至未来桌面 UI，都应共享同一套应用服务接口。

## 6. 建议补充需求

除了你已经提出的点，建议第一阶段额外补上这些能力：

1. Secret 管理
   - 支持从环境变量读取 key，而不是只允许直接写入配置文件。

2. Retry 策略
   - 区分可重试错误与不可重试错误，例如超时可重试、4xx 参数错误不可重试。

3. 输入清单快照
   - 每次 run 固定一份 manifest，避免 benchmark 过程中目录内容变化影响结果。

4. 文件 hash
   - 通过 `sha256` 标识音频，方便去重、重跑、对比。

5. Run 取消/恢复能力
   - 第一阶段可以先预留接口，不一定立即实现。

6. 机器可读输出
   - 便于后续接 CI、自动报表、或外部分析脚本。

7. 对照文本能力预留
   - 虽然第一阶段不必强做 WER/CER，但建议在数据结构上预留 reference transcript 字段。

## 7. 方案设计

## 7.1 总体设计原则

1. 核心优先，UI 次之。
2. 配置驱动 provider 接入。
3. 对外多样，对内统一。
4. 原始数据与标准化数据分开保存。
5. Benchmark 记录尽量采用 append-only 方式。
6. 先验证 provider，再大规模运行。
7. CLI 先行，但所有能力都应可被别的 UI 复用。

## 7.2 分层架构

建议采用如下四层结构：

### 1) Domain 层
负责核心实体与稳定领域模型：
- `ProviderConfig`
- `AudioAsset`
- `BenchRun`
- `BenchAttempt`
- `NormalizedAsrResult`

### 2) Application 层
负责核心用例编排：
- 校验 provider
- 创建 run
- 执行 run
- 查询 run
- 导出 summary

### 3) Infrastructure 层
负责与外部系统打交道：
- HTTP client
- 音频文件扫描
- provider adapter 实现
- JSONL / CSV / JSON 存储
- 可选 SQLite 仓储

### 4) Interface 层
负责对外入口：
- CLI
- 可选本地 HTTP API
- 可选 Web UI

该结构的关键价值在于：
- CLI 不会绑死核心逻辑
- Web UI 后面可以直接复用应用层
- provider 适配逻辑不会散落在 UI 或命令行代码里

## 7.3 核心模块设计

### 模块 A：Provider Registry
职责：
- 加载 provider 配置
- 做基础配置校验
- 根据 `type` 选择合适 adapter
- 暴露 provider 查询与实例化能力
- 支持从 provider 配置目录加载多个独立 provider 文件
- 校验 `provider_id` 唯一性

### 模块 A2：Provider Switcher
职责：
- 在运行时根据 `provider_id`、`type`、`provider_kind` 选择最终 provider 实现
- 将“通用协议兼容”和“provider 特有能力路由”分开
- 让 ZenMux 这类 provider 可以先复用 OpenAI 风格协议，再在架构上独立实现
- 避免在 CLI 或应用服务层散落 provider-specific 分支逻辑

设计建议：
- `Provider Registry` 负责注册与加载
- `Provider Switcher` 负责运行时路由
- 上层 service 只依赖统一 `AsrProviderAdapter`

推荐配置组织：

```text
providers/
  openai-whisper.yaml
  zenmux-gemini-chat.yaml
  zenmux-mimo-chat.yaml
```

即一份 provider 一个配置文件，这样新增 provider 时不需要修改代码，也不需要修改一个集中式大配置文件。

### 模块 B：Audio Catalog
职责：
- 扫描输入文件/目录
- 过滤支持的音频格式
- 提取文件元信息
- 计算时长、hash 等辅助信息
- 生成稳定 `audio_id`

### 模块 C：Benchmark Runner
职责：
- 根据 provider x audio x round 展开任务
- 根据并发/时长/速率限制调度任务
- 执行 provider 请求
- 记录 attempt 生命周期
- 处理超时、重试、失败分类
- 第一阶段先落地 `run once`，用于执行单轮 provider x audio benchmark 并落盘

### 模块 D：Result Normalizer
职责：
- 将 provider 原始返回转换成统一结构
- 提取 transcript / segments / words
- 保存原始响应引用以便调试

### 模块 E：Result Store
职责：
- 以 append-only 方式写入 attempt 记录
- 产出 run 级 summary
- 导出 CSV / JSON 等结果

### 模块 F：Validation Service
职责：
- 对 provider 做独立验证
- 构建请求预览
- 执行单次 smoke request
- 输出解析与诊断信息

### 模块 G：Reporting Service
职责：
- 统计 p50 / p90 / p95 latency
- 统计 success / failure rate
- 统计 timestamp 覆盖率
- 为后续 UI 或报表提供聚合数据

## 8. 运行流程设计

## 8.1 Provider 验证流程
1. 加载指定 provider 配置。
2. 完成本地配置合法性校验。
3. 实例化对应 adapter。
4. 用样例音频构造一次标准输入。
5. 生成并展示请求预览（脱敏后）。
6. 发起一次真实请求。
7. 解析 provider 响应。
8. 转换为统一结果结构。
9. 保存验证报告。
10. 返回 pass/fail 与诊断信息。

## 8.2 Benchmark 运行流程
1. 加载 provider 集合。
2. 扫描输入音频并生成 manifest。
3. 创建 `run_id` 和 run 配置快照。
4. 按 provider x audio x round 展开 attempt 列表。
5. 根据并发与节流策略进行调度。
6. 对每个 attempt：
   - 记录调度时间
   - 记录请求开始时间
   - 发起请求
   - 获取响应
   - 标准化结果
   - 记录完成时间与状态
   - 持久化 attempt 记录
7. 计算 run summary。
8. 写出 summary 与导出文件。

## 8.3 失败处理设计
失败不能只打印日志，必须作为 benchmark 结果的一部分保存。

建议分类：
- `timeout`
- `network_error`
- `auth_error`
- `client_error`
- `server_error`
- `schema_error`
- `unsupported_audio`
- `unknown_error`

每种失败至少要保留：
- 错误类型
- 错误信息
- HTTP 状态码（若存在）
- provider 原始响应（若可获得）

## 9. 数据结构设计

## 9.1 核心实体

### ProviderConfig
- `provider_id`
- `name`
- `type`
- `base_url`
- `api_key_ref` 或 `api_key`
- `default_model`
- `headers`
- `timeout_ms`
- `retry_policy`
- `adapter_options`

### AudioAsset
- `audio_id`
- `path`
- `filename`
- `format`
- `size_bytes`
- `duration_ms`
- `sample_rate`（可选）
- `channels`（可选）
- `sha256`（建议）

### BenchRun
- `run_id`
- `created_at`
- `mode`：`once | rounds | duration`
- `provider_ids`
- `audio_selection`
- `runner_settings`
- `status`
- `config_snapshot_path`

### BenchAttempt
- `attempt_id`
- `run_id`
- `provider_id`
- `audio_id`
- `round_index`
- `scheduled_at`
- `request_started_at`
- `response_received_at`
- `completed_at`
- `latency_ms`
- `queue_delay_ms`
- `status`
- `http_status`
- `error_type`
- `error_message`
- `normalized_result`
- `raw_response_path`

### NormalizedAsrResult
- `text`
- `language`
- `duration_ms`
- `segments[]`
- `words[]`
- `provider_request_id`
- `provider_model`
- `usage`
- `extra`

## 9.2 建议落盘结构

```text
artifacts/
  providers/
    <provider-id>.validation.json
  runs/
    <run-id>/
      run.json
      manifest.json
      attempts.jsonl
      summary.json
      summary.csv
      raw/
        <attempt-id>.json
```

说明：
- `attempts.jsonl` 适合流式追加写入。
- `summary.json` 适合后续 API/UI 直接读取。
- `summary.csv` 便于直接用 Excel/Numbers/Sheets 分析。
- `raw/` 用于存原始响应体或脱敏调试信息。

## 10. 接口设计

## 10.1 Provider 适配层接口

建议定义统一 adapter 接口：

```ts
interface AsrProviderAdapter {
  type: string;

  validateConfig(config: ProviderConfig): Promise<ValidationReport>;

  buildRequest(input: ProviderRequestInput): Promise<BuiltHttpRequest>;

  execute(input: ProviderRequestInput): Promise<ProviderExecutionResult>;

  normalize(result: ProviderExecutionResult): Promise<NormalizedAsrResult>;
}
```

### ProviderRequestInput

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
```

### BuiltHttpRequest

```ts
interface BuiltHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  bodyKind: 'multipart' | 'json' | 'binary';
  debugPreview: Record<string, unknown>;
}
```

### ProviderExecutionResult

```ts
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

## 10.2 OpenAI 兼容接口设计

第一阶段内置一个 `openai_compatible` adapter，另外为 ZenMux 提供独立 `zenmux` provider 路由，核心假设如下：
- 接口形态通常为 `POST {base_url}/audio/transcriptions`
- 鉴权方式通常为 `Authorization: Bearer <key>`
- body 通常为 `multipart/form-data`
- 常见字段包括：
  - `file`
  - `model`
  - `language`
  - `prompt`
  - `response_format`
  - `timestamp_granularities[]`

但考虑到“兼容”常常不完全兼容，因此建议 adapter 支持轻量字段映射。

同时，从设计层面不应把所有“兼容 OpenAI”的服务都视为同一种 provider。像 ZenMux 这种虽然能复用 OpenAI 风格协议，但最佳音频入口、模型能力边界、错误特征都具有明显 provider-specific 特征，因此后续建议将其抽成独立 `zenmux` provider，并由 `Provider Switcher` 进行路由。

配置示例：

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

ZenMux provider 示例：

```yaml
provider_id: zenmux-gemini-chat
name: ZenMux Gemini Audio Chat
type: zenmux
base_url: https://zenmux.ai/api/v1
api_key_env: ZENMUX_API_KEY
default_model: google/gemini-2.5-pro
adapter_options:
  operation: chat_completions_audio
  chat_path: /chat/completions
  text_prompt: Please transcribe this audio faithfully. Return plain text only.
  audio_format: wav
```

## 10.3 Custom HTTP 接口设计

对于完全不兼容 OpenAI 风格的服务，建议使用 `custom_http` adapter。

它通过配置明确描述：
- 请求 path / method
- 请求体类型
- 文件字段名
- 额外字段
- 返回 JSON 中 transcript 和 timestamps 的映射路径

当前实现已支持 `custom_http` adapter，适合接入路径、字段和返回结构都不同的 provider。

配置示例：

```yaml
providers:
  - provider_id: vendor-x
    name: Vendor X ASR
    type: custom_http
    base_url: https://vendor-x.example.com
    api_key: ${VENDOR_X_KEY}
    headers:
      X-API-Key: ${VENDOR_X_KEY}
    adapter_options:
      endpoint:
        method: POST
        path: /asr/recognize
      request:
        content_type: multipart
        file_field: audio
        fields:
          engine: fast
          include_timestamps: true
      response_mapping:
        transcript_path: $.result.text
        language_path: $.result.lang
        segment_path: $.result.segments[*]
        segment_start_path: start_ms
        segment_end_path: end_ms
        segment_text_path: text
```

这样可以把很多“新 provider 接入工作”从“改代码”降级成“补配置”。

## 10.4 应用服务接口设计

核心能力建议通过统一 service 暴露：

```ts
interface BenchService {
  validateProvider(input: ValidateProviderInput): Promise<ValidationResult>;
  createRun(input: CreateRunInput): Promise<BenchRun>;
  executeRun(runId: string): Promise<RunExecutionSummary>;
  getRun(runId: string): Promise<BenchRunDetail>;
  exportRun(runId: string, format: 'json' | 'csv'): Promise<string>;
}
```

这样 CLI、HTTP API、Web UI 都可以基于同一层服务实现。

## 10.5 CLI 接口设计

建议命令形态：

```bash
asrbench provider list
asrbench provider validate --provider openai-main --audio ./samples/a.wav
asrbench run create --providers openai-main,vendor-x --input ./samples --rounds 3
asrbench run start --run-id run_001
asrbench run:once --providers openai-main --input ./samples --rounds 3
asrbench run:duration --providers openai-main --input ./samples --duration-ms 30000 --concurrency 2 --interval-ms 100
asrbench run summary --run-id run_001
asrbench export --run-id run_001 --format csv
```

CLI 设计原则：
- 控制台输出对人类友好
- 支持 `--json` 便于机器处理
- 命令命名稳定清晰
- 不在 CLI 层写 provider 业务逻辑

## 10.6 可选 HTTP API 设计

如果后续要支持 Web UI，建议增加一个非常薄的本地 HTTP API，仅作为界面访问核心服务的桥。

建议接口：
- `GET /api/providers`
- `POST /api/providers/validate`
- `POST /api/runs`
- `POST /api/runs/:id/start`
- `GET /api/runs/:id`
- `GET /api/runs/:id/summary`
- `GET /api/runs/:id/attempts`
- `GET /api/runs/:id/export?format=csv`

注意：
- HTTP API 不负责 provider-specific 逻辑。
- 所有复杂逻辑都仍然在应用层/adapter 层。

## 11. 指标设计

## 11.1 Attempt 级指标
每个 attempt 建议至少记录：
- `latency_ms`
- `queue_delay_ms`
- `audio_duration_ms`
- `rtf`（real-time factor）
- `success`
- `http_status`
- `has_segments`
- `has_words`
- `response_size_bytes`

其中：
- `rtf = latency_ms / audio_duration_ms`
- 这是 ASR bench 里很有价值的指标，可以快速判断转写速度是否接近实时。

## 11.2 Run 级指标
每个 run 建议汇总：
- 总请求数
- 成功率
- 按错误类型拆分失败率
- p50 / p90 / p95 latency
- 平均延迟 / 最大延迟
- 平均 RTF
- transcript 可用率
- segment timestamp 可用率
- word timestamp 可用率

当前实现状态：
- 已支持按 provider 聚合 summary
- 已支持 `p50 / p90 / p95 latency`
- 已支持 `failure_type_counts`
- 对可识别时长的音频已支持 `rtf`

## 11.3 未来可扩展质量指标
如果未来补充 reference transcript，可进一步支持：
- `WER`
- `CER`
- 标点恢复准确率
- timestamp 对齐误差

## 12. 测试与验证设计

你特别提到了“最好能够有测试验证的方式或接口”，这里建议做三层验证。

## 12.1 Adapter Contract Test
对每一种 adapter 都跑同一套契约测试：
- 合法配置能通过
- 非法配置会报错
- buildRequest 结果符合预期
- 样例响应能正确 normalize
- 异常响应能正确归类

这样能保证 provider 层行为一致。

## 12.2 Mock Server 测试
提供本地 mock server，模拟以下情况：
- OpenAI 兼容 provider
- 返回较慢的 provider
- 4xx / 5xx 错误
- 非法 JSON
- 有 timestamp 与无 timestamp 两类响应

这个 mock server 非常重要，因为：
- 它可以在不消耗真实 API quota 的情况下验证 bench 框架。
- 它可以稳定复现各种异常分支。

## 12.3 Live Smoke Test
提供真实小流量验证命令：
- 指定一个 provider
- 指定一个短音频
- 发 1 次请求
- 打印标准化结果与 latency
- 保存 artifacts

适合作为接入新 provider 的第一步。

建议命令例如：

```bash
asrbench provider validate --provider vendor-x --audio ./samples/short.wav
```

## 12.4 Golden File 测试
建议维护 fixtures：
- provider 原始响应样例
- 对应的标准化输出样例
- summary 聚合后的预期输出样例

这样修改 normalize 逻辑时，可以快速发现回归。

## 13. UI 设计

结论先说：第一阶段建议 CLI 为主；如果需要 UI，建议做一个非常薄的本地 Web UI。

## 13.1 UI 目标
UI 主要解决三个问题：
- 配置 provider
- 发起 benchmark
- 查看结果与失败诊断

## 13.2 最小 UI 信息架构
建议最少包含 6 个页面/视图：
1. Provider 列表页
2. Provider 验证页
3. 新建 Run 页
4. Run 详情页
5. Attempt 浏览页
6. Summary Dashboard

## 13.3 关键界面组件

### Provider Form
字段建议：
- Name
- Type
- Base URL
- API Key
- Default Model
- Adapter Options（JSON/YAML 编辑器）
- Validate 按钮

### Run Builder
字段建议：
- Provider 多选
- 输入路径选择
- 音频格式过滤
- 运行模式：once / rounds / duration
- 并发数
- 请求间隔 / rate limit
- 输出目录

### Run Detail
展示建议：
- Run 状态
- 进度条
- attempt 数
- 成功/失败统计
- latency 图表
- transcript 预览表
- failure diagnostics 面板

## 13.4 UI 技术方向
建议：
- 前端只消费本地 HTTP API
- 前端不写 provider-specific 逻辑
- 前端不直接读取 artifacts 文件
- Web UI 后续可替换成桌面 UI，而不用改 benchmark 内核

## 14. 分阶段实施建议

## Phase 1
先完成可用核心：
- 配置加载
- `openai_compatible` adapter
- `zenmux` provider
- `Provider Switcher`
- `custom_http` adapter
- 音频扫描与 manifest
- benchmark runner
- JSONL / JSON / CSV 结果存储
- CLI
- mock server + 契约测试 + smoke test

## Phase 2
增强可视化与查询能力：
- SQLite 存储
- 本地 HTTP 服务
- 简单 Web UI
- 更丰富的 summary 与比较图表

## Phase 3
增强质量评估与高级能力：
- reference transcript 对比
- WER/CER
- 定时任务
- streaming benchmark
- 更强的 provider 模板系统

## 15. 推荐的首版技术路线

如果现在直接进入实现，最平衡的路线是：
- 语言：TypeScript / Node.js
- 配置格式：YAML
- 核心入口：CLI
- 落盘方式：JSONL + JSON summary + CSV export
- 首批 adapter：
  - `openai_compatible`
  - `custom_http`
- 测试方式：
  - adapter contract test
  - mock server integration test
  - live smoke test command

原因：
- Node.js 在 HTTP、多 part 上传、CLI、后续 Web UI 复用上都比较顺手。
- YAML 对 provider 配置比较友好。
- 文件型 artifacts 在第一阶段最轻量、最容易调试。

## 16. 当前仍待确认的问题

这几个点不影响先开工写骨架，但最好尽早定：
- 最终实现语言是否确定为 TypeScript？
- provider 配置是否只用 YAML，还是也支持 JSON？
- 第一阶段是否需要直接接 SQLite？
- benchmark 重点是否只针对“单音频单请求”型接口？
- 终端实时进度输出是否足够，还是你希望尽快有简易网页？

## 17. 建议的下一步

在这份设计基础上，下一步最自然的是：
1. 初始化项目骨架与目录结构
2. 定义 domain types 与 provider config schema
3. 实现 `openai_compatible` adapter
4. 实现 `provider validate` 命令
5. 加入 mock server 与 smoke test
6. 再接 `run once` / `run create` / `run start`

如果你愿意，我下一步可以直接继续把这份 spec 拆成：
- `spec/requirements.md`
- `spec/design.md`
- `spec/interface-design.md`
- `spec/ui-design.md`

或者我也可以直接开始搭第一版项目骨架和 CLI。 
