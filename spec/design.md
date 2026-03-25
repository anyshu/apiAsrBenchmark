# Audio ASR Bench - 方案设计

## 1. 设计原则

1. 核心优先，UI 次之
2. 配置驱动 provider 接入
3. 对外多样，对内统一
4. 原始结果和标准化结果分离
5. Benchmark 记录 append-only
6. 先验证，再批量运行

## 2. 分层架构

### Domain
- `ProviderConfig`
- `AudioAsset`
- `BenchRun`
- `BenchAttempt`
- `NormalizedAsrResult`

### Application
- validate provider
- create run
- execute run
- get run
- export run

### Infrastructure
- HTTP client
- 文件扫描
- provider adapter
- JSONL / JSON / CSV 存储
- 可选 SQLite

### Interface
- CLI
- 可选 HTTP API
- 可选 Web UI

## 3. 核心模块

### Provider Registry
- 加载 provider 配置
- 按 `type` 实例化 adapter
- 对 `openai_compatible` 进一步按 operation 区分请求形态
- 支持从 provider 目录批量加载独立配置文件
- 做 `provider_id` 去重校验

### Provider Switcher
- 根据 `provider_id` 或 `provider_kind` 选择具体 provider 实现
- 将 `openai_compatible`、`zenmux`、未来自定义 provider 的差异隔离在 provider 层
- 对上层 `ValidationService` / `BenchmarkRunner` 暴露统一调用入口
- 负责 capability 判断，例如该 provider 支持 `audio_transcriptions` 还是只支持 `chat_completions_audio`

设计建议：
- `Provider Registry` 负责“加载配置 + 注册 provider 实现”
- `Provider Switcher` 负责“运行时按 provider 选择正确实现”
- 这样后续 ZenMux 可以从通用 `openai_compatible` 中独立出来，变成单独的 `zenmux` provider，而不影响上层 bench 流程

推荐配置组织方式：
- `providers/openai-whisper.yaml`
- `providers/zenmux-gemini-chat.yaml`
- `providers/zenmux-mimo-chat.yaml`

即“一 provider 一文件”，这样新增 provider 时无需修改集中配置大文件。

### Audio Catalog
- 扫描输入
- 提取元信息
- 生成 `audio_id`

### Benchmark Runner
- 展开任务
- 调度并发
- 执行请求
- 记录 attempt 生命周期
- 第一阶段先落地 `run once`
- `run once` 负责 provider x audio 的单轮执行与结果落盘
- 当前已支持 `rounds` 多轮执行
- 当前已支持 `duration` 持续执行
- 当前已支持全局 `concurrency`
- 当前已支持调度 `interval`

### Result Normalizer
- 统一 transcript / timestamp 结构
- 保留原始响应引用

### Result Store
- 写入 `attempts.jsonl`
- 生成 `summary.json` 和 `summary.csv`

### Validation Service
- 请求预览
- 单次验证
- 输出诊断信息

当前第一版实现状态：
- 已实现 `openai_compatible` adapter
- 已实现 `zenmux` adapter
- 已实现 `custom_http` adapter
- 已实现 `Provider Switcher`
- 已支持 `audio_transcriptions`
- 已支持 `chat_completions_audio`
- 已为 `responses_audio` 预留结构
- 已实现 `run once`

下一步建议：
- 在 `Provider Switcher` 中继续扩展 provider-specific fallback 策略
- 明确区分“标准 transcription provider”和“multimodal chat transcript provider”

### Reporting Service
- 统计延迟、成功率、timestamp 覆盖率
- 统计 p50 / p90 / p95 latency
- 统计 failure type 分布
- 在能获得音频时长时统计 `rtf`

## 4. 运行流程

### Provider 验证流程
1. 加载 provider 配置
2. 校验配置
3. 构造请求
4. 预览脱敏请求
5. 发起真实请求
6. 解析并标准化结果
7. 保存验证报告

### Benchmark 流程
1. 扫描音频并生成 manifest
2. 创建 run 和配置快照
3. 展开 provider x audio x round 任务
4. 调度执行
5. 对每个 attempt 记录时间与结果
6. 生成 summary 与导出结果

## 5. 失败处理

失败类型建议包括：
- `timeout`
- `network_error`
- `auth_error`
- `client_error`
- `server_error`
- `schema_error`
- `unsupported_audio`
- `unknown_error`
